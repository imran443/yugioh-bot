import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { migrate } from "../../src/db/index.js";
import { createTournamentService } from "../../src/services/tournaments.js";

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
