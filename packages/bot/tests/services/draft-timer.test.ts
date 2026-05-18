import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { migrate } from "../../src/db/schema.js";
import { createPlayerRepository } from "../../src/repositories/players.js";
import { createCardCatalogService } from "../../src/services/card-catalog.js";
import { createDraftImageService } from "../../src/services/draft-images.js";
import { createDraftService } from "../../src/services/drafts.js";
import { createDraftTimerService } from "../../src/services/draft-timer.js";
import { createTournamentService } from "@yugidraft/shared/services";

function seedDraftCatalog(app: ReturnType<typeof setup>, count: number) {
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
  db.exec(`
    create table if not exists card_sets (
      set_name text primary key not null,
      synced_at text not null,
      card_count integer,
      set_code text
    );
  `);
  migrate(db);
  const updateStatusCalls: Array<{ draftId: number }> = [];

  return {
    db,
    players: createPlayerRepository(db),
    tournaments: createTournamentService(db),
    drafts: createDraftService(db),
    cards: createCardCatalogService(db),
    draftImages: createDraftImageService({ cacheDir: "./data/test-card-images" }),
    messenger: {
      async postStatus(_draft: { id: number }) {
        // no-op
      },
      async updateStatus(draft: { id: number }) {
        updateStatusCalls.push({ draftId: draft.id });
      },
    },
    updateStatusCalls,
  };
}

describe("draft timer service", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("expires overdue picks and updates status", async () => {
    const app = setup();
    const yugi = app.players.upsert("guild-1", "user-7", "Yugi");
    const kaiba = app.players.upsert("guild-1", "user-9", "Kaiba");
    const draft = app.drafts.create("guild-1", "channel-1", "cube night", {}, "user-7", yugi.id);
    app.drafts.join(draft.id, kaiba.id);
    seedDraftCatalog(app, 80);
    app.drafts.start(draft.id);

    const timer = createDraftTimerService({ drafts: app.drafts, messenger: app.messenger, wsCfg: { url: "", secret: "" } });
    const now = new Date(Date.now() + 60000); // 60s after start, past default 45s deadline

    await timer.tick(now);

    const updatedDraft = app.drafts.findById(draft.id);
    expect(updatedDraft.currentPickStep).toBe(2);
    expect(app.updateStatusCalls.length).toBeGreaterThanOrEqual(1);
  });

  it("does not expire picks before deadline", async () => {
    const app = setup();
    const yugi = app.players.upsert("guild-1", "user-7", "Yugi");
    const kaiba = app.players.upsert("guild-1", "user-9", "Kaiba");
    const draft = app.drafts.create("guild-1", "channel-1", "cube night", {}, "user-7", yugi.id);
    app.drafts.join(draft.id, kaiba.id);
    seedDraftCatalog(app, 80);
    app.drafts.start(draft.id);

    const timer = createDraftTimerService({ drafts: app.drafts, messenger: app.messenger, wsCfg: { url: "", secret: "" } });
    const now = new Date(Date.now() + 1000); // 1s after start, before 45s deadline

    await timer.tick(now);

    const updatedDraft = app.drafts.findById(draft.id);
    expect(updatedDraft.currentPickStep).toBe(1);
    expect(app.updateStatusCalls).toEqual([]);
  });

  it("recovers drafts on startup tick", async () => {
    const app = setup();
    const yugi = app.players.upsert("guild-1", "user-7", "Yugi");
    const kaiba = app.players.upsert("guild-1", "user-9", "Kaiba");
    const draft = app.drafts.create("guild-1", "channel-1", "cube night", {}, "user-7", yugi.id);
    app.drafts.join(draft.id, kaiba.id);
    seedDraftCatalog(app, 80);
    app.drafts.start(draft.id);

    // Simulate bot being offline by not ticking
    const timer = createDraftTimerService({ drafts: app.drafts, messenger: app.messenger, wsCfg: { url: "", secret: "" } });
    const now = new Date(Date.now() + 300000); // 5 minutes after start

    await timer.tick(now);

    const updatedDraft = app.drafts.findById(draft.id);
    expect(updatedDraft.currentPickStep).toBeGreaterThan(1);
    expect(app.updateStatusCalls.length).toBeGreaterThanOrEqual(1);
  });

  it("checks overdue drafts every second while running", () => {
    const app = setup();
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");

    const timer = createDraftTimerService({ drafts: app.drafts, messenger: app.messenger, wsCfg: { url: "", secret: "" } });
    timer.start();

    expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 1000);

    timer.stop();
    setIntervalSpy.mockRestore();
  });
});
