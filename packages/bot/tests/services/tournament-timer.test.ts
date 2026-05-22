import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { migrate } from "../../src/db/schema.js";
import { createMatchService } from "@yugidraft/shared/services";
import { createTournamentService } from "@yugidraft/shared/services";
import { createTournamentTimerService } from "../../src/services/tournament-timer.js";

function setup() {
  const db = new Database(":memory:");
  db.exec(`
    create table if not exists card_sets (
      set_name text primary key not null,
      synced_at text not null,
      card_count integer,
      set_code text
    );
  `);
  migrate(db);
  const insertPlayer = db.prepare(
    "insert into players (guild_id, discord_user_id, display_name) values (?, ?, ?)",
  );
  const p1 = Number(insertPlayer.run("g1", "u1", "Yugi").lastInsertRowid);
  const p2 = Number(insertPlayer.run("g1", "u2", "Kaiba").lastInsertRowid);
  return { db, matches: createMatchService(db), tournaments: createTournamentService(db), p1, p2 };
}

describe("tournament timer service", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("auto-approves overdue pending confirmations and invokes the callback", async () => {
    const app = setup();
    const t = app.tournaments.create("g1", "Cup", "round_robin", "u1", { reportConfirmWindowHours: 1 });
    app.tournaments.join(t.id, app.p1);
    app.tournaments.join(t.id, app.p2);
    app.tournaments.start(t.id);
    const match = app.tournaments.report(t.id, app.p1, app.p2, app.p1);
    app.db.prepare("update matches set created_at = ? where id = ?").run("2026-05-20T00:00:00.000Z", match.id);

    const resolved: number[] = [];
    const closed: number[] = [];
    const timer = createTournamentTimerService({
      tournaments: app.tournaments,
      matches: app.matches,
      onMatchAutoResolved: async (m) => { resolved.push(m.id); },
      onTournamentClosed: async (tt) => { closed.push(tt.id); },
    });

    await timer.tick(new Date("2026-05-20T02:00:00.000Z"));

    const updated = app.db.prepare("select status, approver_id from matches where id = ?").get(match.id) as { status: string; approver_id: number | null };
    expect(updated.status).toBe("approved");
    expect(updated.approver_id).toBeNull();
    expect(resolved).toEqual([match.id]);
  });

  it("auto-closes tournaments past their deadline and invokes the callback", async () => {
    const app = setup();
    const t = app.tournaments.create("g1", "Cup", "round_robin", "u1", { deadlineAt: "2026-05-20T00:00:00.000Z" });
    app.tournaments.join(t.id, app.p1);
    app.tournaments.join(t.id, app.p2);
    app.tournaments.start(t.id);

    const closed: number[] = [];
    const timer = createTournamentTimerService({
      tournaments: app.tournaments,
      matches: app.matches,
      onMatchAutoResolved: async () => {},
      onTournamentClosed: async (tt) => { closed.push(tt.id); },
    });

    await timer.tick(new Date("2026-05-21T00:00:00.000Z"));

    const row = app.db.prepare("select status from tournaments where id = ?").get(t.id) as { status: string };
    expect(row.status).toBe("completed");
    expect(closed).toEqual([t.id]);
  });

  it("continues past a callback that throws", async () => {
    const app = setup();
    const mk = (name: string) => {
      const t = app.tournaments.create("g1", name, "round_robin", "u1", { deadlineAt: "2026-05-20T00:00:00.000Z" });
      app.tournaments.join(t.id, app.p1);
      app.tournaments.join(t.id, app.p2);
      app.tournaments.start(t.id);
      return t;
    };
    const t1 = mk("A");
    const t2 = mk("B");

    const closed: number[] = [];
    const timer = createTournamentTimerService({
      tournaments: app.tournaments,
      matches: app.matches,
      onMatchAutoResolved: async () => {},
      onTournamentClosed: async (tt) => {
        if (tt.id === t1.id) throw new Error("boom");
        closed.push(tt.id);
      },
    });

    await timer.tick(new Date("2026-05-21T00:00:00.000Z"));
    // both closed in DB; callback failure on t1 didn't stop t2's callback
    expect(closed).toContain(t2.id);
    expect((app.db.prepare("select status from tournaments where id = ?").get(t2.id) as { status: string }).status).toBe("completed");
  });

  it("polls every 60 seconds while running", () => {
    const app = setup();
    const spy = vi.spyOn(globalThis, "setInterval");
    const timer = createTournamentTimerService({
      tournaments: app.tournaments,
      matches: app.matches,
      onMatchAutoResolved: async () => {},
      onTournamentClosed: async () => {},
    });
    timer.start();
    expect(spy).toHaveBeenCalledWith(expect.any(Function), 60_000);
    timer.stop();
    spy.mockRestore();
  });
});
