import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleButton, type ButtonInteractionLike } from "../../src/interactions/buttons.js";
import { migrate } from "../../src/db/schema.js";
import { createPlayerRepository } from "../../src/repositories/players.js";
import { createCardCatalogService } from "../../src/services/card-catalog.js";
import { createDraftImageService } from "../../src/services/draft-images.js";
import { createDraftService } from "../../src/services/drafts.js";
import { createMatchService } from "../../src/services/matches.js";
import { createTournamentService } from "../../src/services/tournaments.js";

type ButtonDependencies = Parameters<typeof handleButton>[1];
type _DraftButtonDependencyChecks = [
  ButtonDependencies["drafts"],
  ButtonDependencies["cards"],
  ButtonDependencies["draftImages"],
  ButtonDependencies["notifier"],
];

function createFakeDraftImageService() {
  return {
    async renderNumberedGrid(_cards: { ygoprodeckId: number; imageUrl: string; imageUrlSmall?: string }[]) {
      return { filename: "draft-picks.png", buffer: Buffer.from("fake-png-buffer") };
    },
  };
}

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
    matches: createMatchService(db),
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

function fakeButton(input: Partial<ButtonInteractionLike> = {}) {
  const replies: Array<{ content: string; ephemeral?: boolean; components?: readonly unknown[]; files?: readonly unknown[] }> = [];
  const modals: unknown[] = [];
  const interaction: ButtonInteractionLike = {
    customId: "join_tournament:1",
    channelId: "channel-1",
    guildId: "guild-1",
    user: { id: "user-1", username: "Yugi" },
    reply: (message) => {
      replies.push(typeof message === "string" ? { content: message } : message);
    },
    showModal: (modal) => {
      modals.push(modal);
    },
    ...input,
  };

  return { interaction, replies, modals };
}

describe("button interactions", () => {
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
  it("joins a pending tournament and announces publicly", async () => {
    const app = setup();
    const tournament = app.tournaments.create("guild-1", "locals", "round_robin", "creator-1");
    const { interaction, replies } = fakeButton({ customId: `join_tournament:${tournament.id}` });

    await handleButton(interaction, app);

    const player = app.players.findByDiscordId("guild-1", "user-1")!;
    expect(app.tournaments.participants(tournament.id)).toEqual([player.id]);
    expect(replies[0]).toEqual({ content: "Yugi joined event: locals." });
  });

  it("rejects joining a tournament you are already in", async () => {
    const app = setup();
    const tournament = app.tournaments.create("guild-1", "locals", "round_robin", "creator-1");
    const player = app.players.upsert("guild-1", "user-1", "Yugi");
    app.tournaments.join(tournament.id, player.id);
    const { interaction } = fakeButton({ customId: `join_tournament:${tournament.id}` });

    await expect(handleButton(interaction, app)).rejects.toThrow("You have already joined this tournament");
  });

  it("rejects non-join button custom IDs", async () => {
    const app = setup();
    const { interaction } = fakeButton({ customId: "other:1" });

    await expect(handleButton(interaction, app)).rejects.toThrow("Unsupported button interaction");
  });

  it("shows dashboard help privately", async () => {
    const app = setup();
    const { interaction, replies } = fakeButton({ customId: "dashboard_help" });

    await handleButton(interaction, app);

    expect(replies[0]).toMatchObject({
      content: expect.stringContaining("Tournament commands"),
      ephemeral: true,
    });
  });

  it("opens a create event modal from the dashboard", async () => {
    const app = setup();
    const { interaction, replies } = fakeButton({ customId: "dashboard_create_event" });

    await handleButton(interaction, app);

    expect(replies[0]).toMatchObject({
      content: "Choose a tournament format:",
      ephemeral: true,
    });
    expect(JSON.stringify(replies[0])).toContain("dashboard_create_event_format");
    expect(JSON.stringify(replies[0])).toContain("round_robin");
    expect(JSON.stringify(replies[0])).toContain("single_elim");
  });

  it("opens a create draft modal from the dashboard", async () => {
    const app = setup();
    const { interaction, modals } = fakeButton({ customId: "draft_create" });

    await handleButton(interaction, app);

    expect(JSON.stringify(modals[0])).toContain("draft_create_modal");
    expect(JSON.stringify(modals[0])).toContain("name");
    expect(JSON.stringify(modals[0])).toContain("sets");
    expect(JSON.stringify(modals[0])).toContain("includes");
    expect(JSON.stringify(modals[0])).toContain("excludes");
    expect(JSON.stringify(modals[0])).toContain("Create Draft");
  });

  it("lists open drafts from the dashboard with join buttons", async () => {
    const app = setup();
    const yugi = app.players.upsert("guild-1", "user-7", "Yugi");
    const draft = app.drafts.create("guild-1", "channel-1", "cube night", {}, "user-7", yugi.id);
    const { interaction, replies } = fakeButton({ customId: "draft_open" });

    await handleButton(interaction, app);

    expect(replies[0]).toMatchObject({
      content: expect.stringContaining("Open drafts:"),
      ephemeral: true,
    });
    expect(JSON.stringify(replies[0])).toContain(`join_draft:${draft.id}`);
    expect(JSON.stringify(replies[0])).toContain("cube night");
  });

  it("shows no open drafts message when none exist", async () => {
    const app = setup();
    const { interaction, replies } = fakeButton({ customId: "draft_open" });

    await handleButton(interaction, app);

    expect(replies[0]).toEqual({ content: "No open drafts right now.", ephemeral: true });
  });

  it("lists completed drafts from the dashboard with export buttons", async () => {
    const app = setup();
    const yugi = app.players.upsert("guild-1", "user-7", "Yugi");
    const draft = app.drafts.create("guild-1", "channel-1", "cube night", {}, "user-7", yugi.id);
    app.db.prepare("update drafts set status = 'completed' where id = ?").run(draft.id);
    const { interaction, replies } = fakeButton({ customId: "draft_export" });

    await handleButton(interaction, app);

    expect(replies[0]).toMatchObject({
      content: expect.stringContaining("Completed drafts:"),
      ephemeral: true,
    });
    expect(JSON.stringify(replies[0])).toContain(`draft_export:${draft.id}`);
    expect(JSON.stringify(replies[0])).toContain("cube night");
  });

  it("shows no completed drafts message when none exist", async () => {
    const app = setup();
    const { interaction, replies } = fakeButton({ customId: "draft_export" });

    await handleButton(interaction, app);

    expect(replies[0]).toEqual({ content: "No completed drafts to export.", ephemeral: true });
  });

  it("joins a pending draft from the public signup button and announces publicly", async () => {
    const app = setup();
    const yugi = app.players.upsert("guild-1", "user-7", "Yugi");
    const draft = app.drafts.create("guild-1", "channel-1", "cube night", {}, "user-7", yugi.id);
    const { interaction, replies } = fakeButton({
      customId: `join_draft:${draft.id}`,
      user: { id: "user-9", username: "Kaiba" },
    });

    await handleButton(interaction, app);

    expect(app.drafts.players(draft.id)).toEqual([
      { playerId: yugi.id, displayName: "Yugi" },
      { playerId: expect.any(Number), displayName: "Kaiba" },
    ]);
    expect(replies[0]).toEqual({ content: "Kaiba joined draft: cube night." });
  });

  it("rejects joining a draft you are already in", async () => {
    const app = setup();
    const yugi = app.players.upsert("guild-1", "user-7", "Yugi");
    const draft = app.drafts.create("guild-1", "channel-1", "cube night", {}, "user-7", yugi.id);
    const { interaction } = fakeButton({
      customId: `join_draft:${draft.id}`,
      user: { id: "user-7", username: "Yugi" },
    });

    await expect(handleButton(interaction, app)).rejects.toThrow("You have already joined this draft");
  });

  it("starts a draft from the dashboard and sends pick prompts to all joined players", async () => {
    const app = setup();
    const yugi = app.players.upsert("guild-1", "user-7", "Yugi");
    const kaiba = app.players.upsert("guild-1", "user-9", "Kaiba");
    const draft = app.drafts.create("guild-1", "channel-1", "cube night", {}, "user-7", yugi.id);
    app.drafts.join(draft.id, kaiba.id);
    seedDraftCatalog(app, 16);
    const { interaction, replies } = fakeButton({
      customId: `draft_start:${draft.id}`,
      user: { id: "user-7", username: "Yugi" },
    });

    await handleButton(interaction, app);

    expect(app.drafts.findById(draft.id)).toMatchObject({
      status: "active",
      currentWaveNumber: 1,
      currentPickStep: 1,
    });
    expect(replies[0]).toEqual({ content: "Started draft: cube night.", ephemeral: true });
    expect(app.notifierCalls).toEqual([
      { channelId: "channel-1", userId: "user-7", draftId: draft.id, draftName: "cube night" },
      { channelId: "channel-1", userId: "user-9", draftId: draft.id, draftName: "cube night" },
    ]);
  });

  it("rejects non-creators starting drafts from the dashboard", async () => {
    const app = setup();
    const yugi = app.players.upsert("guild-1", "user-7", "Yugi");
    const draft = app.drafts.create("guild-1", "channel-1", "cube night", {}, "user-7", yugi.id);
    seedDraftCatalog(app, 8);

    await expect(
      handleButton(
        fakeButton({
          customId: `draft_start:${draft.id}`,
          user: { id: "user-9", username: "Kaiba" },
        }).interaction,
        app,
      ),
    ).rejects.toThrow("Only the draft creator can do that");
  });

  it("shows a draft pick grid with image attachment when image service succeeds", async () => {
    const app = setup();
    const yugi = app.players.upsert("guild-1", "user-7", "Yugi");
    const kaiba = app.players.upsert("guild-1", "user-9", "Kaiba");
    const draft = app.drafts.create("guild-1", "channel-1", "cube night", {}, "user-7", yugi.id);
    app.drafts.join(draft.id, kaiba.id);
    seedDraftCatalog(app, 16);
    app.drafts.start(draft.id);
    const { interaction, replies } = fakeButton({
      customId: `draft_pick:${draft.id}`,
      user: { id: "user-7", username: "Yugi" },
    });

    await handleButton(interaction, { ...app, draftImages: createFakeDraftImageService() });

    expect(replies[0].ephemeral).toBe(true);
    expect(replies[0].files).toBeDefined();
    expect(replies[0].files!.length).toBe(1);
    expect(replies[0].content).toContain("Pick a card");
    expect(JSON.stringify(replies[0])).toContain("draft_pick_card");
    expect(JSON.stringify(replies[0])).toContain("Card 1");
    expect(JSON.stringify(replies[0])).toContain("Card 8");
  });

  it("falls back to text list when image service throws", async () => {
    const app = setup();
    const yugi = app.players.upsert("guild-1", "user-7", "Yugi");
    const kaiba = app.players.upsert("guild-1", "user-9", "Kaiba");
    const draft = app.drafts.create("guild-1", "channel-1", "cube night", {}, "user-7", yugi.id);
    app.drafts.join(draft.id, kaiba.id);
    seedDraftCatalog(app, 16);
    app.drafts.start(draft.id);
    const { interaction, replies } = fakeButton({
      customId: `draft_pick:${draft.id}`,
      user: { id: "user-7", username: "Yugi" },
    });

    await handleButton(interaction, app);

    expect(replies[0].ephemeral).toBe(true);
    expect(replies[0].files).toBeUndefined();
    expect(replies[0].content).toContain("Card 1");
    expect(replies[0].content).toContain("Card 8");
    expect(JSON.stringify(replies[0])).toContain("draft_pick_card");
  });

  it("lists open events with join buttons", async () => {
    const app = setup();
    const locals = app.tournaments.create("guild-1", "locals", "round_robin", "creator-1");
    app.tournaments.create("guild-1", "win-a-mat", "single_elim", "creator-1");
    const { interaction, replies } = fakeButton({ customId: "dashboard_open_events" });

    await handleButton(interaction, app);

    expect(replies[0]).toMatchObject({
      content: expect.stringContaining("Open events"),
      ephemeral: true,
    });
    expect(replies[0].content).toContain("locals");
    expect(JSON.stringify(replies[0])).toContain(`join_tournament:${locals.id}`);
  });

  it("lists the user's tournaments", async () => {
    const app = setup();
    const tournament = app.tournaments.create("guild-1", "locals", "round_robin", "creator-1");
    const player = app.players.upsert("guild-1", "user-1", "Yugi");
    app.tournaments.join(tournament.id, player.id);
    const { interaction, replies } = fakeButton({ customId: "dashboard_my_events" });

    await handleButton(interaction, app);

    expect(replies[0]).toMatchObject({ content: expect.stringContaining("Your events"), ephemeral: true });
    expect(replies[0].content).toContain("locals");
  });

  it("limits the user's tournament list to fit Discord replies", async () => {
    const app = setup();
    const player = app.players.upsert("guild-1", "user-1", "Yugi");

    for (let index = 1; index <= 30; index += 1) {
      const tournament = app.tournaments.create(
        "guild-1",
        `event-${index.toString().padStart(2, "0")}-${"x".repeat(80)}`,
        "round_robin",
        "creator-1",
      );
      app.tournaments.join(tournament.id, player.id);
    }

    const { interaction, replies } = fakeButton({ customId: "dashboard_my_events" });

    await handleButton(interaction, app);

    expect(replies[0].content).toContain("...and 20 more event(s).");
    expect(replies[0].content.length).toBeLessThanOrEqual(2000);
  });

  it("shows dashboard stats privately", async () => {
    const app = setup();
    const { interaction, replies } = fakeButton({ customId: "dashboard_stats" });

    await handleButton(interaction, app);

    expect(replies[0]).toEqual({ content: "Yugi: 0W - 0L (0% win rate)", ephemeral: true });
  });

  it("starts dashboard match reporting for a user's active tournament", async () => {
    const app = setup();
    const yugi = app.players.upsert("guild-1", "user-1", "Yugi");
    const kaiba = app.players.upsert("guild-1", "user-2", "Kaiba");
    const tournament = app.tournaments.create("guild-1", "locals", "round_robin", "creator-1");
    app.tournaments.join(tournament.id, yugi.id);
    app.tournaments.join(tournament.id, kaiba.id);
    app.tournaments.start(tournament.id);
    const openMatch = app.tournaments.openMatches(tournament.id)[0];
    const { interaction, replies } = fakeButton({ customId: "dashboard_report_match" });

    await handleButton(interaction, app);

    expect(replies[0]).toMatchObject({ content: expect.stringContaining("Choose a match"), ephemeral: true });
    expect(replies[0].content).toContain("Kaiba");
    expect(JSON.stringify(replies[0])).toContain(`dashboard_report_match:${openMatch.id}`);
  });

  it("reports a dashboard match result from buttons", async () => {
    const app = setup();
    const yugi = app.players.upsert("guild-1", "user-1", "Yugi");
    const kaiba = app.players.upsert("guild-1", "user-2", "Kaiba");
    const tournament = app.tournaments.create("guild-1", "locals", "round_robin", "creator-1");
    app.tournaments.join(tournament.id, yugi.id);
    app.tournaments.join(tournament.id, kaiba.id);
    app.tournaments.start(tournament.id);
    const openMatch = app.tournaments.openMatches(tournament.id)[0];
    const { interaction, replies } = fakeButton({ customId: `dashboard_report_result:${openMatch.id}:win` });

    await handleButton(interaction, app);

    expect(replies[0]).toEqual({
      content: expect.stringContaining("Match reported as win"),
      ephemeral: true,
    });
    expect(app.tournaments.openMatches(tournament.id)[0].status).toBe("pending_approval");
  });

  it("rejects stale dashboard match result buttons", async () => {
    const app = setup();
    const yugi = app.players.upsert("guild-1", "user-1", "Yugi");
    const kaiba = app.players.upsert("guild-1", "user-2", "Kaiba");
    const tournament = app.tournaments.create("guild-1", "locals", "round_robin", "creator-1");
    app.tournaments.join(tournament.id, yugi.id);
    app.tournaments.join(tournament.id, kaiba.id);
    app.tournaments.start(tournament.id);
    const openMatch = app.tournaments.openMatches(tournament.id)[0];
    app.tournaments.report(tournament.id, yugi.id, kaiba.id, yugi.id);
    const { interaction } = fakeButton({ customId: `dashboard_report_result:${openMatch.id}:win` });

    await expect(handleButton(interaction, app)).rejects.toThrow("Tournament match is not open");
  });

  it("shows pending approvals with approve and deny buttons", async () => {
    const app = setup();
    const yugi = app.players.upsert("guild-1", "user-1", "Yugi");
    const kaiba = app.players.upsert("guild-1", "user-2", "Kaiba");
    const match = app.matches.report({
      guildId: "guild-1",
      reporterId: yugi.id,
      opponentId: kaiba.id,
      winnerId: yugi.id,
      source: "casual",
    });
    const { interaction, replies } = fakeButton({
      customId: "dashboard_pending_approvals",
      user: { id: "user-2", username: "Kaiba" },
    });

    await handleButton(interaction, app);

    expect(replies[0].content).toContain(`Match #${match.id}`);
    expect(JSON.stringify(replies[0])).toContain(`dashboard_approve:${match.id}`);
    expect(JSON.stringify(replies[0])).toContain(`dashboard_deny:${match.id}`);
  });

  it("approves a match from the dashboard", async () => {
    const app = setup();
    const yugi = app.players.upsert("guild-1", "user-1", "Yugi");
    const kaiba = app.players.upsert("guild-1", "user-2", "Kaiba");
    const match = app.matches.report({
      guildId: "guild-1",
      reporterId: yugi.id,
      opponentId: kaiba.id,
      winnerId: yugi.id,
      source: "casual",
    });
    const { interaction, replies } = fakeButton({
      customId: `dashboard_approve:${match.id}`,
      user: { id: "user-2", username: "Kaiba" },
    });

    await handleButton(interaction, app);

    expect(replies[0]).toEqual({ content: `Approved match #${match.id}.`, ephemeral: true });
    expect(app.matches.stats(yugi.id)).toEqual({ wins: 1, losses: 0 });
  });

  it("shows creator tools for tournaments created by the user", async () => {
    const app = setup();
    const tournament = app.tournaments.create("guild-1", "locals", "round_robin", "user-1");
    const { interaction, replies } = fakeButton({ customId: "dashboard_creator_tools" });

    await handleButton(interaction, app);

    expect(replies[0].content).toContain("Creator tools");
    expect(replies[0].content).toContain("locals");
    expect(JSON.stringify(replies[0])).toContain(`dashboard_start:${tournament.id}`);
    expect(JSON.stringify(replies[0])).toContain(`dashboard_cancel:${tournament.id}`);
  });

  it("lets creators choose which event to manage when they own multiple events", async () => {
    const app = setup();
    const locals = app.tournaments.create("guild-1", "locals", "round_robin", "user-1");
    const weekly = app.tournaments.create("guild-1", "weekly", "single_elim", "user-1");
    const { interaction, replies } = fakeButton({ customId: "dashboard_creator_tools" });

    await handleButton(interaction, app);

    expect(replies[0].content).toContain("Choose an event to manage");
    expect(JSON.stringify(replies[0])).toContain(`dashboard_creator_event:${locals.id}`);
    expect(JSON.stringify(replies[0])).toContain(`dashboard_creator_event:${weekly.id}`);
  });

  it("paginates creator tools when a creator owns more than five events", async () => {
    const app = setup();
    const tournaments = [];

    for (let index = 1; index <= 6; index += 1) {
      tournaments.push(app.tournaments.create("guild-1", `event-${index}`, "round_robin", "user-1"));
    }

    const firstPage = fakeButton({ customId: "dashboard_creator_tools" });
    await handleButton(firstPage.interaction, app);

    expect(JSON.stringify(firstPage.replies[0])).toContain("dashboard_creator_tools_page:5");
    expect(JSON.stringify(firstPage.replies[0])).not.toContain(`dashboard_creator_event:${tournaments[5].id}`);

    const secondPage = fakeButton({ customId: "dashboard_creator_tools_page:5" });
    await handleButton(secondPage.interaction, app);

    expect(secondPage.replies[0].content).toContain("event-6");
    expect(JSON.stringify(secondPage.replies[0])).toContain(`dashboard_creator_event:${tournaments[5].id}`);
    expect(JSON.stringify(secondPage.replies[0])).toContain("dashboard_creator_tools_page:0");
  });

  it("paginates creator tools beyond autocomplete limits", async () => {
    const app = setup();
    const tournaments = [];

    for (let index = 1; index <= 26; index += 1) {
      tournaments.push(app.tournaments.create("guild-1", `event-${index}`, "round_robin", "user-1"));
    }

    const { interaction, replies } = fakeButton({ customId: "dashboard_creator_tools_page:25" });

    await handleButton(interaction, app);

    expect(replies[0].content).toContain("event-26");
    expect(JSON.stringify(replies[0])).toContain(`dashboard_creator_event:${tournaments[25].id}`);
  });

  it("shows creator actions for a selected creator event", async () => {
    const app = setup();
    const tournament = app.tournaments.create("guild-1", "locals", "round_robin", "user-1");
    const { interaction, replies } = fakeButton({ customId: `dashboard_creator_event:${tournament.id}` });

    await handleButton(interaction, app);

    expect(replies[0].content).toContain("Creator tools: locals");
    expect(JSON.stringify(replies[0])).toContain(`dashboard_start:${tournament.id}`);
    expect(JSON.stringify(replies[0])).toContain(`dashboard_cancel:${tournament.id}`);
  });

  it("rejects non-creators from dashboard cancel", async () => {
    const app = setup();
    const tournament = app.tournaments.create("guild-1", "locals", "round_robin", "creator-1");
    const { interaction } = fakeButton({ customId: `dashboard_cancel:${tournament.id}` });

    await expect(handleButton(interaction, app)).rejects.toThrow("Only the event creator can do that");
  });

  it("requires a guild", async () => {
    const app = setup();
    const { interaction } = fakeButton({ guildId: null });

    await expect(handleButton(interaction, app)).rejects.toThrow("This interaction can only be used in a server");
  });

  it("rejects button clicks from a different guild", async () => {
    const app = setup();
    const tournament = app.tournaments.create("guild-1", "locals", "round_robin", "creator-1");
    const { interaction } = fakeButton({
      customId: `join_tournament:${tournament.id}`,
      guildId: "guild-2",
    });

    await expect(handleButton(interaction, app)).rejects.toThrow("Tournament not found in this server");
    expect(app.players.findByDiscordId("guild-2", "user-1")).toBeUndefined();
    expect(app.tournaments.participants(tournament.id)).toEqual([]);
  });

  it("exports a completed draft deck from button", async () => {
    const app = setup();
    const yugi = app.players.upsert("guild-1", "user-7", "Yugi");
    const kaiba = app.players.upsert("guild-1", "user-9", "Kaiba");
    const draft = app.drafts.create("guild-1", "channel-1", "cube night", {}, "user-7", yugi.id);
    app.drafts.join(draft.id, kaiba.id);
    seedDraftCatalog(app, 16);
    app.drafts.start(draft.id);

    for (let step = 1; step <= 40; step += 1) {
      const yugiOptions = app.drafts.pickOptions(draft.id, yugi.id);
      const kaibaOptions = app.drafts.pickOptions(draft.id, kaiba.id);
      if (yugiOptions.length > 0) app.drafts.pickCard(draft.id, yugi.id, yugiOptions[0].id);
      if (kaibaOptions.length > 0) app.drafts.pickCard(draft.id, kaiba.id, kaibaOptions[1]?.id ?? kaibaOptions[0].id);
    }

    const { interaction, replies } = fakeButton({
      customId: `draft_export:${draft.id}`,
      user: { id: "user-7", username: "Yugi" },
    });

    await handleButton(interaction, app);

    const reply = replies[0] as { content: string; files?: readonly unknown[] };
    expect(reply.content).toContain("Exported cube night");
    expect(reply.files).toBeDefined();
    expect((reply.files![0] as { name: string }).name).toBe("cube-night.ydk");
  });
});
