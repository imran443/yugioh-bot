import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { migrate } from "../src/db/index.js";
import { createDraftService } from "../src/services/drafts.js";

function seedDb(db: Database.Database, count = 20) {
  db.prepare("insert into players (guild_id, discord_user_id, display_name) values ('g1', 'u1', 'Alice')").run();
  db.prepare("insert into players (guild_id, discord_user_id, display_name) values ('g1', 'u2', 'Bob')").run();
  const insertCard = db.prepare(
    `insert into card_catalog (ygoprodeck_id, name, type, frame_type, image_url, image_url_small, card_sets_json, cached_at)
     values (?, ?, 'Effect Monster', 'effect', '', '', ?, current_timestamp)`,
  );
  for (let i = 1; i <= count; i++) {
    insertCard.run(i, `Card ${i}`, JSON.stringify([{ set_name: "Set A" }]));
  }
}

describe("pool snapshot", () => {
  it("resolvePoolCardIds returns cards matching the recipe", () => {
    const db = new Database(":memory:");
    migrate(db);
    seedDb(db);
    const drafts = createDraftService(db);
    const ids = drafts.resolvePoolCardIds({ setNames: ["Set A"] });
    expect(ids).toHaveLength(20);
    expect(ids).toContain(1);
  });

  it("openWave uses poolCardIds when present, ignoring catalog changes", () => {
    const db = new Database(":memory:");
    migrate(db);
    seedDb(db, 80);

    const drafts = createDraftService(db);
    const poolCardIds = drafts.resolvePoolCardIds({ setNames: ["Set A"] });

    const alice = db.prepare("select id from players where discord_user_id = 'u1'").get() as { id: number };
    const bob = db.prepare("select id from players where discord_user_id = 'u2'").get() as { id: number };

    const draft = drafts.create("g1", "ch1", "Test Draft", {
      setNames: ["Set A"],
      poolCardIds,
      packsPerPlayer: 5,
      packSize: 8,
      pickSeconds: 45,
    }, "u1", alice.id);

    drafts.join(draft.id, bob.id);

    // Add a new card to catalog AFTER draft creation (simulates daily sync)
    db.prepare(
      `insert into card_catalog (ygoprodeck_id, name, type, frame_type, image_url, image_url_small, card_sets_json, cached_at)
       values (999, 'New Card', 'Effect Monster', 'effect', '', '', '[{"set_name":"Set A"}]', current_timestamp)`,
    ).run();

    // Start the draft — openWave should not include card 999
    drafts.start(draft.id);

    const waveCards = db
      .prepare("select catalog_card_id from draft_cards where draft_id = ?")
      .all(draft.id) as Array<{ catalog_card_id: number }>;

    const cardIds = waveCards.map((r) => r.catalog_card_id);
    expect(cardIds).not.toContain(999);
  });

  it("resolvePoolCardIds is a multiset: set baseline 1 + additive custom repeats", () => {
    const db = new Database(":memory:");
    migrate(db);
    seedDb(db); // cards 1..20 in "Set A"
    const drafts = createDraftService(db);

    // Card 1 is in Set A (baseline 1) and pasted 3× => 4 copies.
    // Card 999 is not in any catalog row => contributes nothing.
    // Card 5 is in Set A only => 1 copy.
    const ids = drafts.resolvePoolCardIds({
      setNames: ["Set A"],
      customCardIds: [1, 1, 1, 999],
    });

    const counts = new Map<number, number>();
    for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1);

    expect(counts.get(1)).toBe(4);
    expect(counts.get(5)).toBe(1);
    expect(counts.has(999)).toBe(false);
  });

  it("openWave falls back to catalog when poolCardIds is absent (old draft)", () => {
    const db = new Database(":memory:");
    migrate(db);
    seedDb(db, 80);

    const drafts = createDraftService(db);
    const alice = db.prepare("select id from players where discord_user_id = 'u1'").get() as { id: number };
    const bob = db.prepare("select id from players where discord_user_id = 'u2'").get() as { id: number };

    // Create draft WITHOUT poolCardIds (simulates old draft)
    const draft = drafts.create("g1", "ch1", "Old Draft", {
      setNames: ["Set A"],
      packsPerPlayer: 5,
      packSize: 8,
      pickSeconds: 45,
    }, "u1", alice.id);

    drafts.join(draft.id, bob.id);
    drafts.start(draft.id);

    const waveCards = db
      .prepare("select catalog_card_id from draft_cards where draft_id = ?")
      .all(draft.id) as Array<{ catalog_card_id: number }>;

    expect(waveCards.length).toBeGreaterThan(0);
  });
});
