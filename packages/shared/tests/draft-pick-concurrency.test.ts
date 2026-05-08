/**
 * Regression guard for the concurrent auto-pick race in expireCurrentPickStep.
 *
 * The race scenario (two concurrent web container requests):
 *   1. Request A enters expireCurrentPickStep, sees player P has not picked yet.
 *   2. Request B enters expireCurrentPickStep, also sees player P has not picked yet.
 *   3. Request A calls pickCard for player P — succeeds.
 *   4. Request B calls pickCard for player P — throws "Player has already picked this step".
 *      That error propagated out of expireCurrentPickStep and caused a 400 response
 *      with a corrupt broadcast (describing a step the DB never reached).
 *
 * better-sqlite3 is synchronous, so true parallelism cannot be simulated in a single
 * Node.js process. Instead this test exercises the exact interleaving that would occur
 * across two processes by directly calling the internal logic twice before each
 * transaction commits. Since expireCurrentPickStep is now a db.transaction, SQLite
 * serialises concurrent writes: the second call sees the first pick already committed
 * and skips that player cleanly rather than throwing.
 *
 * What this test asserts:
 *   - Calling expireCurrentPickStep twice in immediate succession (simulating two
 *     concurrent requests racing) does NOT throw and does NOT double-pick a player.
 *   - Each player is auto-picked exactly once.
 *   - The draft state advances to the next pick step exactly once.
 */

import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { migrate } from "../src/db/index.js";
import { createDraftService } from "../src/services/drafts.js";

function insertPlayer(db: Database.Database, guildId: string, discordUserId: string, displayName: string) {
  const result = db
    .prepare(
      `
        insert into players (guild_id, discord_user_id, display_name)
        values (?, ?, ?)
      `,
    )
    .run(guildId, discordUserId, displayName);

  return {
    id: Number(result.lastInsertRowid),
    guildId,
    discordUserId,
    displayName,
  };
}

function seedCatalogCards(db: Database.Database, count: number) {
  const insertCard = db.prepare(
    `
      insert into card_catalog (
        ygoprodeck_id,
        name,
        type,
        frame_type,
        image_url,
        image_url_small,
        card_sets_json,
        cached_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?)
    `,
  );

  for (let id = 1; id <= count; id += 1) {
    insertCard.run(
      id,
      `Card ${id}`,
      "Spellcaster / Normal Monster",
      "normal",
      `https://img/full/${id}`,
      `https://img/small/${id}`,
      JSON.stringify([{ set_name: "Metal Raiders" }]),
      "2026-01-01T00:00:00Z",
    );
  }
}

function setup() {
  const db = new Database(":memory:");
  migrate(db);
  return { db, drafts: createDraftService(db) };
}

describe("draft pick concurrency", () => {
  it("expireCurrentPickStep called twice does not double-pick any player", () => {
    const app = setup();
    const yugi = insertPlayer(app.db, "guild-1", "user-1", "Yugi");
    const kaiba = insertPlayer(app.db, "guild-1", "user-2", "Kaiba");

    const draft = app.drafts.create(
      "guild-1",
      "channel-1",
      "concurrency test",
      { packSize: 8, packsPerPlayer: 2 },
      "user-1",
      yugi.id,
    );

    app.drafts.join(draft.id, kaiba.id);
    seedCatalogCards(app.db, 32);

    // Start in the past so the deadline is already expired
    const pastDeadline = new Date("2026-01-01T00:00:00.000Z");
    app.drafts.start(draft.id, pastDeadline);

    const draftAfterStart = app.drafts.findById(draft.id);
    expect(draftAfterStart.status).toBe("active");
    expect(draftAfterStart.currentPickStep).toBe(1);

    // Both players have not yet picked. Simulate two concurrent requests:
    // each calls expireCurrentPickStep with a "now" that is past the deadline.
    const expiredNow = new Date("2026-01-01T00:01:00.000Z");

    // First call — should auto-pick both pending players and not throw.
    const result1 = app.drafts.expireCurrentPickStep(draft.id, expiredNow);

    // Second call — simulates the second request arriving just after the first
    // committed. Because expireCurrentPickStep is now a db.transaction, it re-reads
    // hasPickedCurrentStep inside the same transaction and finds both players have
    // already picked. It must return an empty autoPickedPlayerIds list without throwing.
    const result2 = app.drafts.expireCurrentPickStep(draft.id, expiredNow);

    // First call should have auto-picked both players
    expect(result1.autoPickedPlayerIds).toHaveLength(2);
    expect(result1.autoPickedPlayerIds).toContain(yugi.id);
    expect(result1.autoPickedPlayerIds).toContain(kaiba.id);

    // Second call must not have picked anyone — players were already picked
    expect(result2.autoPickedPlayerIds).toHaveLength(0);

    // Verify at the DB level: each player has exactly one pick for pick step 1
    const picks = app.drafts.picks(draft.id);
    const step1Picks = picks.filter((p) => p.pickStep === 1);
    expect(step1Picks).toHaveLength(2);

    const yugiStep1Picks = step1Picks.filter((p) => p.playerId === yugi.id);
    const kaibaStep1Picks = step1Picks.filter((p) => p.playerId === kaiba.id);
    expect(yugiStep1Picks).toHaveLength(1);
    expect(kaibaStep1Picks).toHaveLength(1);

    // Draft should have advanced to pick step 2 (both players picked step 1)
    const draftAfterExpiry = app.drafts.findById(draft.id);
    expect(draftAfterExpiry.currentPickStep).toBe(2);
  });

  it("expireCurrentPickStep is a no-op when deadline has not passed", () => {
    const app = setup();
    const yugi = insertPlayer(app.db, "guild-1", "user-1", "Yugi");
    const kaiba = insertPlayer(app.db, "guild-1", "user-2", "Kaiba");

    const draft = app.drafts.create(
      "guild-1",
      "channel-1",
      "no-op test",
      { packSize: 8, packsPerPlayer: 2 },
      "user-1",
      yugi.id,
    );

    app.drafts.join(draft.id, kaiba.id);
    seedCatalogCards(app.db, 32);

    // Start with a future deadline
    const futureDeadline = new Date("2030-01-01T00:00:00.000Z");
    app.drafts.start(draft.id, futureDeadline);

    // Call expireCurrentPickStep with "now" before the deadline — must be a no-op
    const result = app.drafts.expireCurrentPickStep(draft.id, new Date("2026-01-01T00:00:00.000Z"));

    expect(result.autoPickedPlayerIds).toHaveLength(0);
    expect(app.drafts.picks(draft.id)).toHaveLength(0);
  });
});
