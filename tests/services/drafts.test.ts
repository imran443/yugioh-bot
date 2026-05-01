import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { migrate } from "../../src/db/schema.js";
import { createPlayerRepository } from "../../src/repositories/players.js";
import { createDraftService } from "../../src/services/drafts.js";

function setup() {
  const db = new Database(":memory:");
  migrate(db);

  return {
    db,
    drafts: createDraftService(db),
    players: createPlayerRepository(db),
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

function insertDraftCard(db: Database.Database, draftId: number, waveNumber: number, catalogCardId: number) {
  return Number(
    db.prepare(
      `
        insert into draft_cards (draft_id, wave_number, catalog_card_id)
        values (?, ?, ?)
      `,
    ).run(draftId, waveNumber, catalogCardId).lastInsertRowid,
  );
}

function insertCatalogCard(
  db: Database.Database,
  input: { id: number; name: string; type: string; frameType: string; setName: string },
) {
  db.prepare(
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
  ).run(
    input.id,
    input.name,
    input.type,
    input.frameType,
    `https://img/full/${input.id}`,
    `https://img/small/${input.id}`,
    JSON.stringify([{ set_name: input.setName }]),
    "2026-01-01T00:00:00Z",
  );
}

describe("draft service", () => {
  it("creates a pending draft, stores config, and auto-joins the creator", () => {
    const app = setup();
    const yugi = app.players.upsert("guild-1", "user-1", "Yugi");

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
      },
      currentWaveNumber: 0,
      currentPickStep: 0,
    });
    expect(app.drafts.findById(draft.id)).toEqual(draft);
    expect(app.drafts.findByName("guild-1", "cube night")).toEqual(draft);
    expect(app.drafts.players(draft.id)).toEqual([{ playerId: yugi.id, displayName: "Yugi" }]);
  });

  it("lists drafts by status within a guild", () => {
    const app = setup();
    const yugi = app.players.upsert("guild-1", "user-1", "Yugi");
    const kaiba = app.players.upsert("guild-2", "user-2", "Kaiba");
    const pending = app.drafts.create("guild-1", "channel-1", "cube night", {}, "user-1", yugi.id);
    const active = app.drafts.create("guild-1", "channel-2", "side draft", {}, "user-1", yugi.id);
    app.drafts.create("guild-2", "channel-3", "remote draft", {}, "user-2", kaiba.id);

    app.db.prepare("update drafts set status = 'active' where id = ?").run(active.id);

    expect(app.drafts.listByStatus("guild-1", ["pending", "active"])).toEqual([
      expect.objectContaining({ id: pending.id, guildId: "guild-1", status: "pending" }),
      expect.objectContaining({ id: active.id, guildId: "guild-1", status: "active" }),
    ]);
  });

  it("joins pending drafts without duplicating players and rejects non-pending drafts", () => {
    const app = setup();
    const yugi = app.players.upsert("guild-1", "user-1", "Yugi");
    const kaiba = app.players.upsert("guild-1", "user-2", "Kaiba");
    const joey = app.players.upsert("guild-1", "user-3", "Joey");
    const draft = app.drafts.create("guild-1", "channel-1", "cube night", {}, "user-1", yugi.id);

    app.drafts.join(draft.id, kaiba.id);

    expect(() => app.drafts.join(draft.id, kaiba.id)).toThrow("You have already joined this draft");

    expect(app.drafts.players(draft.id)).toEqual([
      { playerId: yugi.id, displayName: "Yugi" },
      { playerId: kaiba.id, displayName: "Kaiba" },
    ]);

    app.db.prepare("update drafts set status = 'active' where id = ?").run(draft.id);

    expect(() => app.drafts.join(draft.id, joey.id)).toThrow("Draft is no longer accepting players");
  });

  it("rejects creating or joining a draft with players from another guild", () => {
    const app = setup();
    const yugi = app.players.upsert("guild-1", "user-1", "Yugi");
    const kaiba = app.players.upsert("guild-2", "user-2", "Kaiba");

    expect(() => app.drafts.create("guild-1", "channel-1", "cube night", {}, "user-1", kaiba.id)).toThrow(
      "Player must belong to the same guild as the draft",
    );

    const draft = app.drafts.create("guild-1", "channel-1", "cube night", {}, "user-1", yugi.id);

    expect(() => app.drafts.join(draft.id, kaiba.id)).toThrow(
      "Player must belong to the same guild as the draft",
    );
  });

  it("rejects duplicate active or pending draft names in the same guild", () => {
    const app = setup();
    const yugi = app.players.upsert("guild-1", "user-1", "Yugi");
    const active = app.drafts.create("guild-1", "channel-1", "cube night", {}, "user-1", yugi.id);

    app.db.prepare("update drafts set status = 'active' where id = ?").run(active.id);

    expect(() =>
      app.drafts.create("guild-1", "channel-2", "cube night", {}, "user-1", yugi.id),
    ).toThrow("An active or pending draft already uses that name");
  });

  it("starts a pending draft, opens the first 8-card wave for each player, and exposes current wave cards", () => {
    const app = setup();
    const yugi = app.players.upsert("guild-1", "user-1", "Yugi");
    const kaiba = app.players.upsert("guild-1", "user-2", "Kaiba");
    const draft = app.drafts.create(
      "guild-1",
      "channel-1",
      "cube night",
      {
        setNames: ["Metal Raiders"],
        includeNames: ["Blue-Eyes White Dragon"],
        excludeNames: ["Kuriboh"],
      },
      "user-1",
      yugi.id,
    );

    app.drafts.join(draft.id, kaiba.id);

    const cards = [
      { id: 1, name: "Summoned Skull", sets: [{ set_name: "Metal Raiders" }] },
      { id: 2, name: "Kuriboh", sets: [{ set_name: "Metal Raiders" }] },
      { id: 3, name: "Blue-Eyes White Dragon", sets: [{ set_name: "Starter Deck: Kaiba" }] },
      { id: 4, name: "Dark Magician", sets: [{ set_name: "Legend of Blue Eyes White Dragon" }] },
    ];

    for (const card of cards) {
      app.db.prepare(
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
      ).run(
        card.id,
        card.name,
        "Spellcaster / Normal Monster",
        "normal",
        `https://img/full/${card.id}`,
        `https://img/small/${card.id}`,
        JSON.stringify(card.sets),
        "2026-01-01T00:00:00Z",
      );
    }

    const started = app.drafts.start(draft.id);
    const waveCards = app.drafts.currentWaveCards(draft.id);

    expect(started).toMatchObject({
      id: draft.id,
      status: "active",
      currentWaveNumber: 1,
      currentPickStep: 1,
    });
    expect(app.db.prepare("select started_at from drafts where id = ?").get(draft.id)).toEqual({
      started_at: expect.any(String),
    });
    expect(waveCards).toHaveLength(16);
    expect(waveCards.every((card) => card.waveNumber === 1)).toBe(true);
    expect(waveCards.every((card) => card.pickedByPlayerId === null)).toBe(true);
    expect(new Set(waveCards.map((card) => card.catalogCardId))).toEqual(new Set([1, 3]));
    expect(app.db.prepare("select count(*) as count from draft_cards where draft_id = ?").get(draft.id)).toEqual({
      count: 16,
    });
  });

  it("excludes cached extra deck cards when opening draft waves", () => {
    const app = setup();
    const yugi = app.players.upsert("guild-1", "user-1", "Yugi");
    const kaiba = app.players.upsert("guild-1", "user-2", "Kaiba");
    const draft = app.drafts.create(
      "guild-1",
      "channel-1",
      "cube night",
      { setNames: ["Metal Raiders"] },
      "user-1",
      yugi.id,
    );
    app.drafts.join(draft.id, kaiba.id);
    insertCatalogCard(app.db, {
      id: 1,
      name: "Summoned Skull",
      type: "Fiend / Normal Monster",
      frameType: "normal",
      setName: "Metal Raiders",
    });
    insertCatalogCard(app.db, {
      id: 2,
      name: "Fusionist",
      type: "Beast / Fusion Monster",
      frameType: "fusion",
      setName: "Metal Raiders",
    });

    app.drafts.start(draft.id);

    expect(app.db.prepare("select distinct catalog_card_id from draft_cards where draft_id = ?").all(draft.id)).toEqual([
      { catalog_card_id: 1 },
    ]);
  });

  it("requires a pending draft to start", () => {
    const app = setup();
    const yugi = app.players.upsert("guild-1", "user-1", "Yugi");
    const kaiba = app.players.upsert("guild-1", "user-2", "Kaiba");
    const draft = app.drafts.create("guild-1", "channel-1", "cube night", {}, "user-1", yugi.id);

    app.drafts.join(draft.id, kaiba.id);
    app.db.prepare("update drafts set status = 'active' where id = ?").run(draft.id);

    expect(() => app.drafts.start(draft.id)).toThrow("Draft must be pending to start");
  });

  it("requires at least two players to start", () => {
    const app = setup();
    const yugi = app.players.upsert("guild-1", "user-1", "Yugi");
    const draft = app.drafts.create("guild-1", "channel-1", "cube night", {}, "user-1", yugi.id);

    expect(() => app.drafts.start(draft.id)).toThrow("Draft requires at least two players to start");
  });

  it("returns pick options and records synchronized pick steps after all players pick", () => {
    const app = setup();
    const yugi = app.players.upsert("guild-1", "user-1", "Yugi");
    const kaiba = app.players.upsert("guild-1", "user-2", "Kaiba");
    const draft = app.drafts.create("guild-1", "channel-1", "cube night", {}, "user-1", yugi.id);

    app.drafts.join(draft.id, kaiba.id);

    for (let id = 1; id <= 16; id += 1) {
      app.db.prepare(
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
      ).run(
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

    app.drafts.start(draft.id);

    const yugiOptions = app.drafts.pickOptions(draft.id, yugi.id);

    expect(yugiOptions).toHaveLength(8);
    expect(yugiOptions.every((card) => card.waveNumber === 1)).toBe(true);
    expect(yugiOptions.every((card) => card.pickedByPlayerId === null)).toBe(true);

    const yugiPick = app.drafts.pickCard(draft.id, yugi.id, yugiOptions[0].id);

    expect(yugiPick).toMatchObject({
      draftId: draft.id,
      playerId: yugi.id,
      draftCardId: yugiOptions[0].id,
      waveNumber: 1,
      pickStep: 1,
    });
    expect(app.drafts.findById(draft.id).currentPickStep).toBe(1);

    const kaibaOptions = app.drafts.pickOptions(draft.id, kaiba.id);

    expect(kaibaOptions).toHaveLength(8);
    expect(kaibaOptions.map((card) => card.id)).not.toContain(yugiOptions[0].id);

    const kaibaPick = app.drafts.pickCard(draft.id, kaiba.id, kaibaOptions[0].id);

    expect(kaibaPick).toMatchObject({
      draftId: draft.id,
      playerId: kaiba.id,
      draftCardId: kaibaOptions[0].id,
      waveNumber: 1,
      pickStep: 1,
    });
    expect(app.drafts.findById(draft.id).currentPickStep).toBe(2);
    expect(app.drafts.pickOptions(draft.id, yugi.id)).toHaveLength(8);
    expect(
      app.db
        .prepare(
          `
            select player_id, draft_card_id, wave_number, pick_step
            from draft_picks
            where draft_id = ?
            order by id asc
          `,
        )
        .all(draft.id),
    ).toEqual([
      {
        player_id: yugi.id,
        draft_card_id: yugiOptions[0].id,
        wave_number: 1,
        pick_step: 1,
      },
      {
        player_id: kaiba.id,
        draft_card_id: kaibaOptions[0].id,
        wave_number: 1,
        pick_step: 1,
      },
    ]);
  });

  it("limits each player prompt to 8 pick options", () => {
    const app = setup();
    const yugi = app.players.upsert("guild-1", "user-1", "Yugi");
    const kaiba = app.players.upsert("guild-1", "user-2", "Kaiba");
    const joey = app.players.upsert("guild-1", "user-3", "Joey");
    const draft = app.drafts.create("guild-1", "channel-1", "cube night", {}, "user-1", yugi.id);

    app.drafts.join(draft.id, kaiba.id);
    app.drafts.join(draft.id, joey.id);
    seedCatalogCards(app.db, 24);
    app.drafts.start(draft.id);

    expect(app.drafts.pickOptions(draft.id, yugi.id)).toHaveLength(8);
    expect(app.drafts.pickOptions(draft.id, kaiba.id)).toHaveLength(8);
    expect(app.drafts.pickOptions(draft.id, joey.id)).toHaveLength(8);
  });

  it("validates joined players, active wave cards, and one pick per player per step", () => {
    const app = setup();
    const yugi = app.players.upsert("guild-1", "user-1", "Yugi");
    const kaiba = app.players.upsert("guild-1", "user-2", "Kaiba");
    const joey = app.players.upsert("guild-1", "user-3", "Joey");
    const draft = app.drafts.create("guild-1", "channel-1", "cube night", {}, "user-1", yugi.id);

    app.drafts.join(draft.id, kaiba.id);

    for (let id = 1; id <= 16; id += 1) {
      app.db.prepare(
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
      ).run(
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

    app.drafts.start(draft.id);

    const [firstOption, secondOption] = app.drafts.pickOptions(draft.id, yugi.id);

    expect(() => app.drafts.pickOptions(draft.id, joey.id)).toThrow("Player has not joined this draft");
    expect(() => app.drafts.pickCard(draft.id, joey.id, firstOption.id)).toThrow("Player has not joined this draft");

    app.drafts.pickCard(draft.id, yugi.id, firstOption.id);

    expect(() => app.drafts.pickCard(draft.id, yugi.id, secondOption.id)).toThrow(
      "Player has already picked this step",
    );
    expect(() => app.drafts.pickCard(draft.id, kaiba.id, firstOption.id)).toThrow("Card has already been picked");

    app.db.prepare("update drafts set status = 'completed' where id = ?").run(draft.id);

    expect(() => app.drafts.pickOptions(draft.id, yugi.id)).toThrow("Draft must be active");
    expect(() => app.drafts.pickCard(draft.id, kaiba.id, secondOption.id)).toThrow("Draft must be active");

    app.db.prepare("update drafts set status = 'active', current_wave_number = 2 where id = ?").run(draft.id);

    expect(() => app.drafts.pickCard(draft.id, kaiba.id, secondOption.id)).toThrow(
      "Card is not in the current wave",
    );
  });

  it("opens the next wave after the current wave is fully picked when players still need cards", () => {
    const app = setup();
    const yugi = app.players.upsert("guild-1", "user-1", "Yugi");
    const kaiba = app.players.upsert("guild-1", "user-2", "Kaiba");
    const draft = app.drafts.create("guild-1", "channel-1", "cube night", {}, "user-1", yugi.id);

    app.drafts.join(draft.id, kaiba.id);
    seedCatalogCards(app.db, 16);
    app.drafts.start(draft.id);

    app.db.prepare("delete from draft_cards where draft_id = ?").run(draft.id);
    app.db.prepare("update drafts set current_wave_number = 1, current_pick_step = 8 where id = ?").run(draft.id);
    app.db.prepare("update draft_players set pick_count = 7, finished_at = null where draft_id = ?").run(draft.id);

    const yugiCardId = insertDraftCard(app.db, draft.id, 1, 1);
    const kaibaCardId = insertDraftCard(app.db, draft.id, 1, 2);

    app.drafts.pickCard(draft.id, yugi.id, yugiCardId);
    app.drafts.pickCard(draft.id, kaiba.id, kaibaCardId);

    expect(app.drafts.findById(draft.id)).toMatchObject({
      status: "active",
      currentWaveNumber: 2,
      currentPickStep: 1,
    });
    expect(app.drafts.currentWaveCards(draft.id)).toHaveLength(16);
    expect(app.drafts.currentWaveCards(draft.id).every((card) => card.waveNumber === 2)).toBe(true);
  });

  it("completes the draft as soon as every player reaches 40 picks even if wave cards remain", () => {
    const app = setup();
    const yugi = app.players.upsert("guild-1", "user-1", "Yugi");
    const kaiba = app.players.upsert("guild-1", "user-2", "Kaiba");
    const draft = app.drafts.create("guild-1", "channel-1", "cube night", {}, "user-1", yugi.id);

    app.drafts.join(draft.id, kaiba.id);
    seedCatalogCards(app.db, 16);
    app.drafts.start(draft.id);

    app.db.prepare("delete from draft_cards where draft_id = ?").run(draft.id);
    app.db.prepare("update drafts set current_wave_number = 5, current_pick_step = 1 where id = ?").run(draft.id);
    app.db.prepare("update draft_players set pick_count = 39, finished_at = null where draft_id = ?").run(draft.id);

    const yugiCardId = insertDraftCard(app.db, draft.id, 5, 1);
    const kaibaCardId = insertDraftCard(app.db, draft.id, 5, 2);
    insertDraftCard(app.db, draft.id, 5, 3);
    insertDraftCard(app.db, draft.id, 5, 4);

    app.drafts.pickCard(draft.id, yugi.id, yugiCardId);

    expect(app.drafts.pickOptions(draft.id, yugi.id)).toEqual([]);
    expect(app.drafts.findById(draft.id)).toMatchObject({
      status: "active",
      currentWaveNumber: 5,
      currentPickStep: 1,
    });
    expect(
      app.db.prepare("select pick_count, finished_at from draft_players where draft_id = ? and player_id = ?").get(draft.id, yugi.id),
    ).toEqual({
      pick_count: 40,
      finished_at: expect.any(String),
    });

    app.drafts.pickCard(draft.id, kaiba.id, kaibaCardId);

    expect(app.drafts.findById(draft.id)).toMatchObject({
      status: "completed",
      currentWaveNumber: 5,
      currentPickStep: 1,
    });
    expect(app.db.prepare("select ended_at from drafts where id = ?").get(draft.id)).toEqual({
      ended_at: expect.any(String),
    });
    expect(
      app.db.prepare("select pick_count, finished_at from draft_players where draft_id = ? and player_id = ?").get(draft.id, kaiba.id),
    ).toEqual({
      pick_count: 40,
      finished_at: expect.any(String),
    });
    expect(
      app.db.prepare("select count(*) as count from draft_cards where draft_id = ? and wave_number = ? and picked_by_player_id is null").get(draft.id, 5),
    ).toEqual({ count: 2 });
  });

  it("rejects pickCard calls from players who already finished at 40 cards", () => {
    const app = setup();
    const yugi = app.players.upsert("guild-1", "user-1", "Yugi");
    const kaiba = app.players.upsert("guild-1", "user-2", "Kaiba");
    const draft = app.drafts.create("guild-1", "channel-1", "cube night", {}, "user-1", yugi.id);

    app.drafts.join(draft.id, kaiba.id);
    seedCatalogCards(app.db, 16);
    app.drafts.start(draft.id);

    app.db.prepare("delete from draft_cards where draft_id = ?").run(draft.id);
    app.db.prepare("update drafts set current_wave_number = 5, current_pick_step = 1 where id = ?").run(draft.id);
    app.db.prepare("update draft_players set pick_count = 40, finished_at = current_timestamp where draft_id = ? and player_id = ?").run(draft.id, yugi.id);

    const yugiCardId = insertDraftCard(app.db, draft.id, 5, 1);

    expect(() => app.drafts.pickCard(draft.id, yugi.id, yugiCardId)).toThrow("Player has already finished drafting");
  });

  it("exports a completed player's drafted main deck as YDK", () => {
    const app = setup();
    const yugi = app.players.upsert("guild-1", "user-1", "Yugi");
    const kaiba = app.players.upsert("guild-1", "user-2", "Kaiba");
    const draft = app.drafts.create("guild-1", "channel-1", "cube night", {}, "user-1", yugi.id);

    app.drafts.join(draft.id, kaiba.id);
    seedCatalogCards(app.db, 40);

    app.db.prepare("update drafts set status = 'completed' where id = ?").run(draft.id);
    app.db.prepare("update draft_players set pick_count = 40, finished_at = current_timestamp where draft_id = ?").run(draft.id);

    const insertPick = app.db.prepare(
      `
        insert into draft_picks (draft_id, player_id, draft_card_id, wave_number, pick_step, picked_at)
        values (?, ?, ?, ?, ?, current_timestamp)
      `,
    );
    const markDraftCardPicked = app.db.prepare(
      `
        update draft_cards
        set picked_by_player_id = ?, picked_at = current_timestamp
        where id = ?
      `,
    );

    for (let id = 1; id <= 40; id += 1) {
      const draftCardId = insertDraftCard(app.db, draft.id, Math.ceil(id / 8), id);
      markDraftCardPicked.run(yugi.id, draftCardId);
      insertPick.run(draft.id, yugi.id, draftCardId, Math.ceil(id / 8), ((id - 1) % 8) + 1);
    }

    expect(app.drafts.exportYdk(draft.id, yugi.id)).toBe(
      [
        "#created by Yugioh Discord Bot",
        "#main",
        ...Array.from({ length: 40 }, (_, index) => String(index + 1)),
        "#extra",
        "!side",
      ].join("\n"),
    );
  });

  it("rejects YDK export before a player's deck reaches 40 picks", () => {
    const app = setup();
    const yugi = app.players.upsert("guild-1", "user-1", "Yugi");
    const kaiba = app.players.upsert("guild-1", "user-2", "Kaiba");
    const draft = app.drafts.create("guild-1", "channel-1", "cube night", {}, "user-1", yugi.id);

    app.drafts.join(draft.id, kaiba.id);
    seedCatalogCards(app.db, 39);

    app.db.prepare("update drafts set status = 'active' where id = ?").run(draft.id);
    app.db.prepare(
      "update draft_players set pick_count = 39, finished_at = null where draft_id = ? and player_id = ?",
    ).run(draft.id, yugi.id);

    const insertPick = app.db.prepare(
      `
        insert into draft_picks (draft_id, player_id, draft_card_id, wave_number, pick_step, picked_at)
        values (?, ?, ?, ?, ?, current_timestamp)
      `,
    );
    const markDraftCardPicked = app.db.prepare(
      `
        update draft_cards
        set picked_by_player_id = ?, picked_at = current_timestamp
        where id = ?
      `,
    );

    for (let id = 1; id <= 39; id += 1) {
      const draftCardId = insertDraftCard(app.db, draft.id, Math.ceil(id / 8), id);
      markDraftCardPicked.run(yugi.id, draftCardId);
      insertPick.run(draft.id, yugi.id, draftCardId, Math.ceil(id / 8), ((id - 1) % 8) + 1);
    }

    expect(() => app.drafts.exportYdk(draft.id, yugi.id)).toThrow("Deck is not complete yet");
  });
});
