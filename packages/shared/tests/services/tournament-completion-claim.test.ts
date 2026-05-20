import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { migrate } from "../../src/db/index.js";
import { createMatchService } from "../../src/services/matches.js";

function setup() {
  const db = new Database(":memory:");
  migrate(db);
  return db;
}

function insertTournament(
  db: Database.Database,
  status: string,
  completedAnnouncedAt: string | null,
): number {
  const r = db
    .prepare(
      "insert into tournaments (guild_id, name, format, status, created_by_user_id, completed_announced_at) values (?, ?, ?, ?, ?, ?)",
    )
    .run("g1", `tournament-${Math.random()}`, "round_robin", status, "u1", completedAnnouncedAt);
  return Number(r.lastInsertRowid);
}

describe("claimTournamentCompletionAnnouncement", () => {
  it("returns true on the first claim for a completed tournament with no prior announcement", () => {
    const db = setup();
    const svc = createMatchService(db);
    const tournamentId = insertTournament(db, "completed", null);

    expect(svc.claimTournamentCompletionAnnouncement(tournamentId)).toBe(true);
  });

  it("returns false on the second claim (one-shot guarantee)", () => {
    const db = setup();
    const svc = createMatchService(db);
    const tournamentId = insertTournament(db, "completed", null);

    svc.claimTournamentCompletionAnnouncement(tournamentId);

    expect(svc.claimTournamentCompletionAnnouncement(tournamentId)).toBe(false);
  });

  it("returns false for a non-completed tournament", () => {
    const db = setup();
    const svc = createMatchService(db);
    const tournamentId = insertTournament(db, "active", null);

    expect(svc.claimTournamentCompletionAnnouncement(tournamentId)).toBe(false);
  });

  it("sets completed_announced_at to a non-null value after a successful claim", () => {
    const db = setup();
    const svc = createMatchService(db);
    const tournamentId = insertTournament(db, "completed", null);

    svc.claimTournamentCompletionAnnouncement(tournamentId);

    const row = db
      .prepare("select completed_announced_at from tournaments where id = ?")
      .get(tournamentId) as { completed_announced_at: string | null };
    expect(row.completed_announced_at).not.toBeNull();
  });
});
