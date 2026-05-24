import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { migrate } from "../src/db/index.js";
import { createDraftService } from "../src/services/drafts.js";
import { createDraftTournamentService } from "../src/services/draft-tournament.js";

function seedDb(db: Database.Database) {
  db.prepare("insert into players (guild_id, discord_user_id, display_name) values ('g1', 'u1', 'Alice')").run();
  db.prepare("insert into players (guild_id, discord_user_id, display_name) values ('g1', 'u2', 'Bob')").run();
  for (let i = 1; i <= 40; i++) {
    db.prepare(
      `insert into card_catalog (ygoprodeck_id, name, type, frame_type, image_url, image_url_small, card_sets_json, cached_at)
       values (?, ?, 'Effect Monster', 'effect', '', '', '[{"set_name":"Set A"}]', current_timestamp)`,
    ).run(i, `Card ${i}`);
  }
}

function completeDraft(db: Database.Database) {
  seedDb(db);
  const drafts = createDraftService(db);
  const alice = db.prepare("select id from players where discord_user_id = 'u1'").get() as { id: number };
  const bob = db.prepare("select id from players where discord_user_id = 'u2'").get() as { id: number };
  const cubeCardIds = drafts.resolveCubeCardIds({ setNames: ["Set A"] });
  const draft = drafts.create("g1", "ch1", "Test Draft", {
    setNames: ["Set A"], cubeCardIds, packsPerPlayer: 5, packSize: 8, pickSeconds: 45,
  }, "u1", alice.id);
  drafts.join(draft.id, bob.id);
  db.prepare("update drafts set status = 'completed' where id = ?").run(draft.id);
  return { draft, aliceId: alice.id, bobId: bob.id };
}

describe("createTournamentFromDraft", () => {
  it("creates a tournament and seeds all players", () => {
    const db = new Database(":memory:");
    migrate(db);
    const { draft } = completeDraft(db);
    const service = createDraftTournamentService(db);

    const result = service.createTournamentFromDraft({
      draftId: draft.id,
      format: "round_robin",
      createdByUserId: "u1",
    });

    expect(result.tournamentName).toBe("Test Draft");
    const participants = db
      .prepare("select player_id from tournament_participants where tournament_id = ?")
      .all(result.tournamentId) as Array<{ player_id: number }>;
    expect(participants).toHaveLength(2);
  });

  it("is idempotent — second call returns existing tournament", () => {
    const db = new Database(":memory:");
    migrate(db);
    const { draft } = completeDraft(db);
    const service = createDraftTournamentService(db);

    const r1 = service.createTournamentFromDraft({ draftId: draft.id, format: "round_robin", createdByUserId: "u1" });
    const r2 = service.createTournamentFromDraft({ draftId: draft.id, format: "single_elim", createdByUserId: "u1" });

    expect(r1.tournamentId).toBe(r2.tournamentId);
  });

  it("rejects non-creator", () => {
    const db = new Database(":memory:");
    migrate(db);
    const { draft } = completeDraft(db);
    const service = createDraftTournamentService(db);

    expect(() =>
      service.createTournamentFromDraft({ draftId: draft.id, format: "round_robin", createdByUserId: "u2" }),
    ).toThrow("Only the draft creator");
  });

  it("rejects non-completed draft", () => {
    const db = new Database(":memory:");
    migrate(db);
    seedDb(db);
    const drafts = createDraftService(db);
    const alice = db.prepare("select id from players where discord_user_id = 'u1'").get() as { id: number };
    const cubeCardIds = drafts.resolveCubeCardIds({ setNames: ["Set A"] });
    const draft = drafts.create("g1", "ch1", "Pending", {
      setNames: ["Set A"], cubeCardIds, packsPerPlayer: 5, packSize: 8, pickSeconds: 45,
    }, "u1", alice.id);

    const service = createDraftTournamentService(db);
    expect(() =>
      service.createTournamentFromDraft({ draftId: draft.id, format: "round_robin", createdByUserId: "u1" }),
    ).toThrow("must be completed");
  });

  it("stores tournament_id on the draft row", () => {
    const db = new Database(":memory:");
    migrate(db);
    const { draft } = completeDraft(db);
    const service = createDraftTournamentService(db);

    const result = service.createTournamentFromDraft({ draftId: draft.id, format: "round_robin", createdByUserId: "u1" });

    const row = db.prepare("select tournament_id from drafts where id = ?").get(draft.id) as { tournament_id: number };
    expect(row.tournament_id).toBe(result.tournamentId);
  });
});
