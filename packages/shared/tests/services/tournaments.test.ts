import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { migrate } from "../../src/db/index.js";
import { createTournamentService } from "../../src/services/tournaments.js";
import { DEFAULT_REPORT_CONFIRM_HOURS } from "../../src/services/constants.js";

function setup() {
  const db = new Database(":memory:");
  migrate(db);
  return { db, tournaments: createTournamentService(db) };
}

function insertPlayer(db: Database.Database, guildId: string, discordUserId: string, name: string) {
  const r = db
    .prepare("insert into players (guild_id, discord_user_id, display_name) values (?, ?, ?)")
    .run(guildId, discordUserId, name);
  return Number(r.lastInsertRowid);
}

describe("tournaments service", () => {
  describe("leave", () => {
    it("removes a participant from a pending tournament", () => {
      const { db, tournaments } = setup();
      const alice = insertPlayer(db, "g1", "u-alice", "Alice");
      const t = tournaments.create("g1", "T", "round_robin", "u-alice");
      tournaments.join(t.id, alice);

      tournaments.leave(t.id, alice);

      expect(tournaments.participants(t.id)).toEqual([]);
    });

    it("throws when the tournament is not pending", () => {
      const { db, tournaments } = setup();
      const alice = insertPlayer(db, "g1", "u-alice", "Alice");
      const bob = insertPlayer(db, "g1", "u-bob", "Bob");
      const t = tournaments.create("g1", "T", "round_robin", "u-alice");
      tournaments.join(t.id, alice);
      tournaments.join(t.id, bob);
      tournaments.start(t.id);

      expect(() => tournaments.leave(t.id, alice)).toThrow(/already started/i);
    });

    it("throws when the participant is not in the tournament", () => {
      const { db, tournaments } = setup();
      const alice = insertPlayer(db, "g1", "u-alice", "Alice");
      const t = tournaments.create("g1", "T", "round_robin", "u-alice");

      expect(() => tournaments.leave(t.id, alice)).toThrow(/not a participant|not joined/i);
    });
  });

  describe("kick", () => {
    it("lets the organizer remove a participant from a pending tournament", () => {
      const { db, tournaments } = setup();
      const alice = insertPlayer(db, "g1", "u-alice", "Alice");
      const bob = insertPlayer(db, "g1", "u-bob", "Bob");
      const t = tournaments.create("g1", "T", "round_robin", "u-alice");
      tournaments.join(t.id, alice);
      tournaments.join(t.id, bob);

      tournaments.kick(t.id, "u-alice", bob);

      expect(tournaments.participants(t.id)).toEqual([alice]);
    });

    it("rejects kick when caller is not the organizer", () => {
      const { db, tournaments } = setup();
      const alice = insertPlayer(db, "g1", "u-alice", "Alice");
      const bob = insertPlayer(db, "g1", "u-bob", "Bob");
      const t = tournaments.create("g1", "T", "round_robin", "u-alice");
      tournaments.join(t.id, bob);

      expect(() => tournaments.kick(t.id, "u-bob", bob)).toThrow(/only the organizer/i);
    });

    it("rejects kick when the tournament is not pending", () => {
      const { db, tournaments } = setup();
      const alice = insertPlayer(db, "g1", "u-alice", "Alice");
      const bob = insertPlayer(db, "g1", "u-bob", "Bob");
      const t = tournaments.create("g1", "T", "round_robin", "u-alice");
      tournaments.join(t.id, alice);
      tournaments.join(t.id, bob);
      tournaments.start(t.id);

      expect(() => tournaments.kick(t.id, "u-alice", bob)).toThrow(/already started/i);
    });
  });

  describe("participantCount", () => {
    it("returns the number of participants", () => {
      const { db, tournaments } = setup();
      const alice = insertPlayer(db, "g1", "u-alice", "Alice");
      const bob = insertPlayer(db, "g1", "u-bob", "Bob");
      const t = tournaments.create("g1", "T", "round_robin", "u-alice");
      tournaments.join(t.id, alice);
      tournaments.join(t.id, bob);

      expect(tournaments.participantCount(t.id)).toBe(2);
    });
  });
});

describe("tournaments timing settings", () => {
  it("create stores deadlineAt and reportConfirmWindowHours when provided", () => {
    const { tournaments } = setup();
    const t = tournaments.create("g1", "Cup", "round_robin", "u1", {
      deadlineAt: "2099-01-01T00:00:00.000Z",
      reportConfirmWindowHours: 6,
    });
    expect(t.deadlineAt).toBe("2099-01-01T00:00:00.000Z");
    expect(t.reportConfirmWindowHours).toBe(6);
  });

  it("create leaves both null when options omitted", () => {
    const { tournaments } = setup();
    const t = tournaments.create("g1", "Cup", "round_robin", "u1");
    expect(t.deadlineAt).toBeUndefined();
    expect(t.reportConfirmWindowHours).toBeUndefined();
  });

  it("updateSettings patches only provided keys", () => {
    const { tournaments } = setup();
    const t = tournaments.create("g1", "Cup", "round_robin", "u1", { reportConfirmWindowHours: 6 });
    const u = tournaments.updateSettings(t.id, { deadlineAt: "2099-02-02T00:00:00.000Z" });
    expect(u.deadlineAt).toBe("2099-02-02T00:00:00.000Z");
    expect(u.reportConfirmWindowHours).toBe(6); // untouched
    const cleared = tournaments.updateSettings(t.id, { deadlineAt: null });
    expect(cleared.deadlineAt).toBeUndefined();
  });

  it("updateSettings rejects an out-of-range window", () => {
    const { tournaments } = setup();
    const t = tournaments.create("g1", "Cup", "round_robin", "u1");
    expect(() => tournaments.updateSettings(t.id, { reportConfirmWindowHours: 0 })).toThrow();
    expect(() => tournaments.updateSettings(t.id, { reportConfirmWindowHours: 721 })).toThrow();
  });

  it("updateSettings throws when tournament is completed", () => {
    const { tournaments, db } = setup();
    const t = tournaments.create("g1", "Cup", "round_robin", "u1");
    db.prepare("update tournaments set status = 'completed' where id = ?").run(t.id);
    expect(() => tournaments.updateSettings(t.id, { reportConfirmWindowHours: 6 })).toThrow();
  });

  it("closeForDeadline completes an active tournament and is a no-op otherwise", () => {
    const { tournaments, db } = setup();
    const p1 = insertPlayer(db, "g1", "u1", "Yugi");
    const p2 = insertPlayer(db, "g1", "u2", "Kaiba");
    const t = tournaments.create("g1", "Cup", "round_robin", "u1");
    tournaments.join(t.id, p1);
    tournaments.join(t.id, p2);
    tournaments.start(t.id); // -> active
    const closed = tournaments.closeForDeadline(t.id);
    expect(closed.status).toBe("completed");
    const endedAt = db.prepare("select ended_at from tournaments where id = ?").get(t.id) as { ended_at: string | null };
    expect(endedAt.ended_at).not.toBeNull();
    // idempotent: second call no longer active -> returns completed, leaves it completed
    expect(tournaments.closeForDeadline(t.id).status).toBe("completed");
  });

  it("findOverdueActive returns only active tournaments with deadline_at <= now", () => {
    const { tournaments, db } = setup();
    const p1 = insertPlayer(db, "g1", "u1", "Yugi");
    const p2 = insertPlayer(db, "g1", "u2", "Kaiba");
    const overdue = tournaments.create("g1", "Past", "round_robin", "u1", { deadlineAt: "2000-01-01T00:00:00.000Z" });
    const future = tournaments.create("g1", "Future", "round_robin", "u1", { deadlineAt: "2999-01-01T00:00:00.000Z" });
    const noDeadline = tournaments.create("g1", "None", "round_robin", "u1");
    for (const t of [overdue, future, noDeadline]) {
      tournaments.join(t.id, p1);
      tournaments.join(t.id, p2);
      tournaments.start(t.id);
    }
    const found = tournaments.findOverdueActive("2026-05-20T00:00:00.000Z");
    expect(found.map((t) => t.id)).toEqual([overdue.id]);
  });

  it("DEFAULT_REPORT_CONFIRM_HOURS is 24", () => {
    expect(DEFAULT_REPORT_CONFIRM_HOURS).toBe(24);
  });
});

describe("tournaments complete (manual early finish)", () => {
  it("completes an active tournament and stamps ended_at", () => {
    const { tournaments, db } = setup();
    const p1 = insertPlayer(db, "g1", "u1", "Yugi");
    const p2 = insertPlayer(db, "g1", "u2", "Kaiba");
    const t = tournaments.create("g1", "Cup", "round_robin", "u1");
    tournaments.join(t.id, p1);
    tournaments.join(t.id, p2);
    tournaments.start(t.id); // -> active

    const completed = tournaments.complete(t.id);

    expect(completed.status).toBe("completed");
    const row = db
      .prepare("select ended_at from tournaments where id = ?")
      .get(t.id) as { ended_at: string | null };
    expect(row.ended_at).not.toBeNull();
  });

  it("throws when the tournament is still pending (never started)", () => {
    const { tournaments } = setup();
    const t = tournaments.create("g1", "Cup", "round_robin", "u1");
    expect(() => tournaments.complete(t.id)).toThrow(/cannot be completed/i);
  });

  it("throws when the tournament is already completed", () => {
    const { tournaments, db } = setup();
    const t = tournaments.create("g1", "Cup", "round_robin", "u1");
    db.prepare("update tournaments set status = 'completed' where id = ?").run(t.id);
    expect(() => tournaments.complete(t.id)).toThrow(/cannot be completed/i);
  });
});
