import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { migrate } from "../../src/db/index.js";
import { createDraftService } from "../../src/services/drafts.js";

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

function setup() {
  const db = new Database(":memory:");
  migrate(db);

  return {
    db,
    drafts: createDraftService(db),
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

describe("shared draft service", () => {
  it("creates a pending draft, stores config, and auto-joins the creator", () => {
    const app = setup();
    const yugi = insertPlayer(app.db, "guild-1", "user-1", "Yugi");

    const draft = app.drafts.create(
      "guild-1",
      "channel-1",
      "cube night",
      {
        setNames: ["Battle Pack 3"],
        includeNames: ["Dark Magician"],
        excludeNames: ["Pot of Greed"],
      },
      "user-1",
      yugi.id,
    );

    expect(draft).toEqual({
      id: expect.any(Number),
      guildId: "guild-1",
      channelId: "channel-1",
      name: "cube night",
      status: "pending",
      createdByUserId: "user-1",
      config: {
        setNames: ["Battle Pack 3"],
        includeNames: ["Dark Magician"],
        excludeNames: ["Pot of Greed"],
        packSize: 8,
        packsPerPlayer: 5,
        pickSeconds: 45,
        alternatePassDirection: true,
        randomizeSeats: false,
      },
      currentPackRound: 0,
      currentPickStep: 0,
      pickDeadlineAt: null,
      statusMessageId: null,
      webSlug: expect.any(String),
    });
    expect(app.drafts.players(draft.id)).toEqual([{ playerId: yugi.id, displayName: "Yugi" }]);
  });

  it("starts a draft by seating players and opening one 8-card pack per player", () => {
    const app = setup();
    const yugi = insertPlayer(app.db, "guild-1", "user-1", "Yugi");
    const kaiba = insertPlayer(app.db, "guild-1", "user-2", "Kaiba");
    const draft = app.drafts.create("guild-1", "channel-1", "cube night", { setNames: ["Metal Raiders"] }, "user-1", yugi.id);

    app.drafts.join(draft.id, kaiba.id);
    seedCatalogCards(app.db, 16);

    const started = app.drafts.start(draft.id, new Date("2026-05-01T00:00:00.000Z"));

    expect(started).toEqual(expect.objectContaining({
      id: draft.id,
      status: "active",
      currentPackRound: 1,
      currentPickStep: 1,
      pickDeadlineAt: "2026-05-01T00:00:45.000Z",
    }));
    expect(app.drafts.players(draft.id)).toEqual([
      { playerId: yugi.id, displayName: "Yugi", seatIndex: 0 },
      { playerId: kaiba.id, displayName: "Kaiba", seatIndex: 1 },
    ]);
    expect(app.drafts.currentPackOptions(draft.id, yugi.id)).toHaveLength(8);
    expect(app.drafts.currentPackOptions(draft.id, kaiba.id)).toHaveLength(8);
  });

  it("uses custom card ids as an explicit draft pool", () => {
    const app = setup();
    const yugi = insertPlayer(app.db, "guild-1", "user-1", "Yugi");
    const kaiba = insertPlayer(app.db, "guild-1", "user-2", "Kaiba");
    const draft = app.drafts.create(
      "guild-1",
      "channel-1",
      "custom pool night",
      { setNames: ["Missing Set"], customCardIds: [101, 102], packSize: 2, packsPerPlayer: 1 },
      "user-1",
      yugi.id,
    );

    app.drafts.join(draft.id, kaiba.id);

    const insertCard = app.db.prepare(
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

    for (const id of [101, 102]) {
      insertCard.run(
        id,
        `Custom Card ${id}`,
        "Spellcaster / Normal Monster",
        "normal",
        `https://img/full/${id}`,
        `https://img/small/${id}`,
        JSON.stringify([{ set_name: "Different Set" }]),
        "2026-01-01T00:00:00Z",
      );
    }

    app.drafts.start(draft.id);

    const openedCardIds = app.db
      .prepare("select distinct catalog_card_id from draft_cards where draft_id = ? order by catalog_card_id")
      .all(draft.id);

    expect(openedCardIds).toEqual([{ catalog_card_id: 101 }, { catalog_card_id: 102 }]);
  });

  it("records synchronized pick steps after all players pick", () => {
    const app = setup();
    const yugi = insertPlayer(app.db, "guild-1", "user-1", "Yugi");
    const kaiba = insertPlayer(app.db, "guild-1", "user-2", "Kaiba");
    const draft = app.drafts.create("guild-1", "channel-1", "cube night", {}, "user-1", yugi.id);

    app.drafts.join(draft.id, kaiba.id);
    seedCatalogCards(app.db, 16);
    app.drafts.start(draft.id);

    const yugiPick = app.drafts.currentPackOptions(draft.id, yugi.id)[0];
    const kaibaPick = app.drafts.currentPackOptions(draft.id, kaiba.id)[0];

    app.drafts.pickCard(draft.id, yugi.id, yugiPick.id);
    expect(app.drafts.findById(draft.id).currentPickStep).toBe(1);

    app.drafts.pickCard(draft.id, kaiba.id, kaibaPick.id);

    expect(app.drafts.findById(draft.id).currentPickStep).toBe(2);
    expect(app.drafts.picks(draft.id)).toEqual([
      expect.objectContaining({ playerId: yugi.id, draftCardId: yugiPick.id, waveNumber: 1, pickStep: 1 }),
      expect.objectContaining({ playerId: kaiba.id, draftCardId: kaibaPick.id, waveNumber: 1, pickStep: 1 }),
    ]);
  });

  it("recordManualPick returns alreadyPicked: true when expiry auto-picked the player before the manual pick runs", () => {
    const app = setup();
    const yugi = insertPlayer(app.db, "guild-1", "user-1", "Yugi");
    const kaiba = insertPlayer(app.db, "guild-1", "user-2", "Kaiba");
    const draft = app.drafts.create("guild-1", "channel-1", "cube night", { packSize: 8, packsPerPlayer: 5 }, "user-1", yugi.id);

    app.drafts.join(draft.id, kaiba.id);
    seedCatalogCards(app.db, 50);
    app.drafts.start(draft.id);

    // Get a valid card from Yugi's current pack
    const options = app.drafts.currentPackOptions(draft.id, yugi.id);
    expect(options.length).toBeGreaterThan(0);
    const cardId = options[0].id;

    // Set deadline to the past so the next expiry fires immediately
    app.db
      .prepare("update drafts set pick_deadline_at = ? where id = ?")
      .run(new Date(Date.now() - 1000).toISOString(), draft.id);

    // recordManualPick fires expiry inside the transaction, which auto-picks Yugi
    const started = app.drafts.findById(draft.id);
    const result = app.drafts.recordManualPick(draft.id, yugi.id, cardId);

    expect(result).toEqual({ alreadyPicked: true });

    // A pick row must exist for Yugi at the current wave/step
    const pickRow = app.db
      .prepare(
        "select * from draft_picks where draft_id = ? and player_id = ? and wave_number = ? and pick_step = ?",
      )
      .get(draft.id, yugi.id, started.currentPackRound, started.currentPickStep);

    expect(pickRow).toBeTruthy();
  });

  it("recordManualPick records the manual pick and returns alreadyPicked: false when no expiry fires", () => {
    const app = setup();
    const yugi = insertPlayer(app.db, "guild-1", "user-1", "Yugi");
    const kaiba = insertPlayer(app.db, "guild-1", "user-2", "Kaiba");
    const draft = app.drafts.create("guild-1", "channel-1", "cube night", { packSize: 8, packsPerPlayer: 5 }, "user-1", yugi.id);

    app.drafts.join(draft.id, kaiba.id);
    seedCatalogCards(app.db, 50);
    // Deadline is in the future after start, so expiry will not fire
    app.drafts.start(draft.id, new Date());

    const options = app.drafts.currentPackOptions(draft.id, yugi.id);
    expect(options.length).toBeGreaterThan(0);
    const cardId = options[0].id;

    const result = app.drafts.recordManualPick(draft.id, yugi.id, cardId);

    expect(result).toEqual({ alreadyPicked: false });

    // A pick row with pick_method = 'manual' must exist
    const pickRow = app.db
      .prepare("select * from draft_picks where draft_id = ? and player_id = ?")
      .get(draft.id, yugi.id) as { pick_method: string } | undefined;

    expect(pickRow).toBeTruthy();
    expect(pickRow?.pick_method).toBe("manual");
  });

  it("exports a completed deck in YGOPro YDK format", () => {
    const app = setup();
    const yugi = insertPlayer(app.db, "guild-1", "user-1", "Yugi");
    const kaiba = insertPlayer(app.db, "guild-1", "user-2", "Kaiba");
    const draft = app.drafts.create("guild-1", "channel-1", "cube night", { packSize: 8, packsPerPlayer: 5 }, "user-1", yugi.id);

    app.drafts.join(draft.id, kaiba.id);
    seedCatalogCards(app.db, 50);
    app.drafts.start(draft.id);

    // Pick 40 cards to complete the deck (both players need to pick so packs pass)
    for (let i = 0; i < 40; i++) {
      const yugiOptions = app.drafts.currentPackOptions(draft.id, yugi.id);
      const kaibaOptions = app.drafts.currentPackOptions(draft.id, kaiba.id);
      if (yugiOptions.length > 0) {
        app.drafts.pickCard(draft.id, yugi.id, yugiOptions[0].id);
      }
      if (kaibaOptions.length > 0) {
        app.drafts.pickCard(draft.id, kaiba.id, kaibaOptions[0].id);
      }
    }

    const ydk = app.drafts.exportYdk(draft.id, yugi.id);

    // Verify YDK format
    const lines = ydk.split("\n");
    expect(lines[0]).toBe("#main");
    expect(lines[41]).toBe("#extra");
    expect(lines[42]).toBe("");
    expect(lines[43]).toBe("!side");
    expect(lines[44]).toBe("");
    expect(lines.length).toBe(45);

    // Verify card IDs are present
    for (let i = 1; i <= 40; i++) {
      expect(lines[i]).toMatch(/^\d+$/);
    }
  });
});
