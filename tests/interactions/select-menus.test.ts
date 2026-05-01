import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { migrate } from "../../src/db/schema.js";
import {
  handleSelectMenu,
  type SelectMenuInteractionLike,
} from "../../src/interactions/select-menus.js";
import { createPlayerRepository } from "../../src/repositories/players.js";
import { createCardCatalogService } from "../../src/services/card-catalog.js";
import { createDraftImageService } from "../../src/services/draft-images.js";
import { createDraftService } from "../../src/services/drafts.js";
import { createTournamentService } from "../../src/services/tournaments.js";

type SelectMenuDependencies = Parameters<typeof handleSelectMenu>[1];
type _DraftSelectMenuDependencyChecks = [
  SelectMenuDependencies["drafts"],
  SelectMenuDependencies["cards"],
  SelectMenuDependencies["draftImages"],
  SelectMenuDependencies["notifier"],
];

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
  migrate(db);
  const notifierCalls: Array<{ channelId: string; userId: string; draftId: number; draftName: string }> = [];

  return {
    db,
    players: createPlayerRepository(db),
    tournaments: createTournamentService(db),
    drafts: createDraftService(db),
    cards: createCardCatalogService(db),
    draftImages: createDraftImageService({ cacheDir: "./data/test-card-images" }),
    notifier: {
      sendPickPrompt: async (input: { channelId: string; userId: string; draftId: number; draftName: string }) => {
        notifierCalls.push(input);
      },
    },
    notifierCalls,
  };
}

function fakeSelectMenu(input: Partial<SelectMenuInteractionLike> = {}) {
  const replies: Array<{ content: string; ephemeral?: boolean; components?: readonly unknown[]; files?: readonly unknown[] }> = [];
  const modals: unknown[] = [];
  const interaction: SelectMenuInteractionLike = {
    customId: "dashboard_create_event_format",
    channelId: "channel-1",
    guildId: "guild-1",
    user: { id: "user-1", username: "Yugi" },
    values: ["round_robin"],
    showModal: (modal) => {
      modals.push(modal);
    },
    reply: (message) => {
      replies.push(message);
    },
    ...input,
  };

  return { interaction, modals, replies };
}

describe("select menu interactions", () => {
  beforeEach(() => {
    let counter = 0;
    vi.spyOn(Math, "random").mockImplementation(() => {
      const result = counter / 16;
      counter = (counter + 1) % 16;
      return result;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });
  it("opens a name-only create event modal after choosing a format", async () => {
    const app = setup();
    const { interaction, modals } = fakeSelectMenu({ values: ["single_elim"] });

    await handleSelectMenu(interaction, app);

    expect(JSON.stringify(modals[0])).toContain("dashboard_create_event:single_elim");
    expect(JSON.stringify(modals[0])).toContain("name");
    expect(JSON.stringify(modals[0])).not.toContain("format");
  });

  it("rejects unsupported format selections", async () => {
    const app = setup();
    const { interaction } = fakeSelectMenu({ values: ["swiss"] });

    await expect(handleSelectMenu(interaction, app)).rejects.toThrow("Unsupported tournament format");
  });

  it("records a draft pick from select menu and replies with card name", async () => {
    const app = setup();
    const yugi = app.players.upsert("guild-1", "user-7", "Yugi");
    const kaiba = app.players.upsert("guild-1", "user-9", "Kaiba");
    const draft = app.drafts.create("guild-1", "channel-1", "cube night", {}, "user-7", yugi.id);
    app.drafts.join(draft.id, kaiba.id);
    seedDraftCatalog(app, 16);
    app.drafts.start(draft.id);
    const waveCards = app.drafts.currentWaveCards(draft.id);
    const { interaction, replies } = fakeSelectMenu({
      customId: `draft_pick_card:${draft.id}`,
      user: { id: "user-7", username: "Yugi" },
      values: [String(waveCards[0].id)],
    });

    await handleSelectMenu(interaction, app);

    expect(replies[0].content).toContain("Card 1");
    expect(replies[0].ephemeral).toBe(true);
    expect(app.notifierCalls).toEqual([]);
  });

  it("sends next pick prompts after the final player picks a step", async () => {
    const app = setup();
    const yugi = app.players.upsert("guild-1", "user-7", "Yugi");
    const kaiba = app.players.upsert("guild-1", "user-9", "Kaiba");
    const draft = app.drafts.create("guild-1", "channel-1", "cube night", {}, "user-7", yugi.id);
    app.drafts.join(draft.id, kaiba.id);
    seedDraftCatalog(app, 16);
    app.drafts.start(draft.id);
    const waveCards = app.drafts.currentWaveCards(draft.id);

    await handleSelectMenu(
      fakeSelectMenu({
        customId: `draft_pick_card:${draft.id}`,
        user: { id: "user-7", username: "Yugi" },
        values: [String(waveCards[0].id)],
      }).interaction,
      app,
    );

    expect(app.notifierCalls).toEqual([]);

    await handleSelectMenu(
      fakeSelectMenu({
        customId: `draft_pick_card:${draft.id}`,
        user: { id: "user-9", username: "Kaiba" },
        values: [String(waveCards[1].id)],
      }).interaction,
      app,
    );

    expect(app.notifierCalls).toEqual([
      { channelId: "channel-1", userId: "user-7", draftId: draft.id, draftName: "cube night" },
      { channelId: "channel-1", userId: "user-9", draftId: draft.id, draftName: "cube night" },
    ]);
  });

  it("records draft picks from direct message prompts", async () => {
    const app = setup();
    const yugi = app.players.upsert("guild-1", "user-7", "Yugi");
    const kaiba = app.players.upsert("guild-1", "user-9", "Kaiba");
    const draft = app.drafts.create("guild-1", "channel-1", "cube night", {}, "user-7", yugi.id);
    app.drafts.join(draft.id, kaiba.id);
    seedDraftCatalog(app, 16);
    app.drafts.start(draft.id);
    const waveCards = app.drafts.currentWaveCards(draft.id);
    const { interaction, replies } = fakeSelectMenu({
      customId: `draft_pick_card:${draft.id}`,
      guildId: null,
      user: { id: "user-7", username: "Yugi" },
      values: [String(waveCards[0].id)],
    });

    await handleSelectMenu(interaction, app);

    expect(replies[0].content).toContain("Card 1");
    expect(replies[0].ephemeral).toBe(true);
  });

  it("tells a player they already picked when they try again", async () => {
    const app = setup();
    const yugi = app.players.upsert("guild-1", "user-7", "Yugi");
    const kaiba = app.players.upsert("guild-1", "user-9", "Kaiba");
    const draft = app.drafts.create("guild-1", "channel-1", "cube night", {}, "user-7", yugi.id);
    app.drafts.join(draft.id, kaiba.id);
    seedDraftCatalog(app, 16);
    app.drafts.start(draft.id);
    const waveCards = app.drafts.currentWaveCards(draft.id);

    await handleSelectMenu(
      fakeSelectMenu({
        customId: `draft_pick_card:${draft.id}`,
        user: { id: "user-7", username: "Yugi" },
        values: [String(waveCards[0].id)],
      }).interaction,
      app,
    );

    const { interaction, replies } = fakeSelectMenu({
      customId: `draft_pick_card:${draft.id}`,
      user: { id: "user-7", username: "Yugi" },
      values: [String(waveCards[1].id)],
    });

    await handleSelectMenu(interaction, app);

    expect(replies[0].content).toContain("already picked");
    expect(replies[0].ephemeral).toBe(true);
  });
});
