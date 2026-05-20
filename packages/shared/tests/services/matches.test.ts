import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { migrate } from "../../src/db/index.js";
import { createMatchService } from "../../src/services/matches.js";
import { createTournamentService } from "../../src/services/tournaments.js";

function setup() {
  const db = new Database(":memory:");
  migrate(db);
  const insertPlayer = db.prepare(
    "insert into players (guild_id, discord_user_id, display_name) values (?, ?, ?)",
  );
  const p1 = Number(insertPlayer.run("g1", "u1", "Yugi").lastInsertRowid);
  const p2 = Number(insertPlayer.run("g1", "u2", "Kaiba").lastInsertRowid);
  return {
    db,
    matches: createMatchService(db),
    tournaments: createTournamentService(db),
    p1,
    p2,
  };
}

// Reports a tournament match (winner = p1) and returns its match id, with a
// controllable created_at so the confirm window can be tested deterministically.
function seedPendingTournamentMatch(
  app: ReturnType<typeof setup>,
  opts: { windowHours?: number | null; createdAt: string },
) {
  const t = app.tournaments.create("g1", "Cup", "round_robin", "u1", {
    reportConfirmWindowHours: opts.windowHours ?? null,
  });
  app.tournaments.join(t.id, app.p1);
  app.tournaments.join(t.id, app.p2);
  app.tournaments.start(t.id);
  const match = app.tournaments.report(t.id, app.p1, app.p2, app.p1); // p1 reports a win
  app.db.prepare("update matches set created_at = ? where id = ?").run(opts.createdAt, match.id);
  return { tournamentId: t.id, matchId: match.id };
}

describe("matches.autoApprove", () => {
  it("approves a pending tournament match with a null approver and completes it", () => {
    const app = setup();
    const { matchId, tournamentId } = seedPendingTournamentMatch(app, {
      createdAt: "2026-05-01T00:00:00.000Z",
    });
    const result = app.matches.autoApprove(matchId);
    expect(result.status).toBe("approved");
    expect(result.approverId).toBeNull();
    const row = app.db.prepare("select resolved_at from matches where id = ?").get(matchId) as { resolved_at: string | null };
    expect(row.resolved_at).not.toBeNull();
    // round-robin with the single match resolved -> tournament completes
    const t = app.db.prepare("select status from tournaments where id = ?").get(tournamentId) as { status: string };
    expect(t.status).toBe("completed");
  });

  it("is a no-op on a non-pending match", () => {
    const app = setup();
    const { matchId } = seedPendingTournamentMatch(app, { createdAt: "2026-05-01T00:00:00.000Z" });
    app.matches.autoApprove(matchId);
    const again = app.matches.autoApprove(matchId);
    expect(again.status).toBe("approved");
  });
});

describe("matches.findOverduePendingConfirmations", () => {
  it("returns matches past created_at + per-tournament window", () => {
    const app = setup();
    const { matchId } = seedPendingTournamentMatch(app, {
      windowHours: 6,
      createdAt: "2026-05-20T00:00:00.000Z",
    });
    // 5h later -> not overdue
    expect(app.matches.findOverduePendingConfirmations("2026-05-20T05:00:00.000Z")).toEqual([]);
    // 7h later -> overdue
    const overdue = app.matches.findOverduePendingConfirmations("2026-05-20T07:00:00.000Z");
    expect(overdue.map((m) => m.id)).toEqual([matchId]);
  });

  it("uses the 24h default when window is null", () => {
    const app = setup();
    const { matchId } = seedPendingTournamentMatch(app, {
      windowHours: null,
      createdAt: "2026-05-20T00:00:00.000Z",
    });
    expect(app.matches.findOverduePendingConfirmations("2026-05-20T23:00:00.000Z")).toEqual([]);
    const overdue = app.matches.findOverduePendingConfirmations("2026-05-21T01:00:00.000Z");
    expect(overdue.map((m) => m.id)).toEqual([matchId]);
  });

  it("excludes matches in non-active tournaments", () => {
    const app = setup();
    const { matchId, tournamentId } = seedPendingTournamentMatch(app, {
      windowHours: 1,
      createdAt: "2026-05-20T00:00:00.000Z",
    });
    app.db.prepare("update tournaments set status = 'completed' where id = ?").run(tournamentId);
    expect(app.matches.findOverduePendingConfirmations("2026-05-21T00:00:00.000Z").map((m) => m.id)).not.toContain(matchId);
  });

  it("excludes casual matches", () => {
    const app = setup();
    const m = app.matches.report({ guildId: "g1", reporterId: app.p1, opponentId: app.p2, winnerId: app.p1, source: "casual" });
    app.db.prepare("update matches set created_at = ? where id = ?").run("2000-01-01T00:00:00.000Z", m.id);
    expect(app.matches.findOverduePendingConfirmations("2026-05-21T00:00:00.000Z")).toEqual([]);
  });
});
