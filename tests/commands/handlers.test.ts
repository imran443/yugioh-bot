import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { handleCommand, type CommandInteractionLike } from "../../src/commands/handlers.js";
import { migrate } from "../../src/db/schema.js";
import { createPlayerRepository } from "../../src/repositories/players.js";
import { createCardCatalogService } from "../../src/services/card-catalog.js";
import { createDraftImageService } from "../../src/services/draft-images.js";
import { createDraftService } from "../../src/services/drafts.js";
import { createDraftTemplateService } from "../../src/services/draft-templates.js";
import { createMatchService } from "../../src/services/matches.js";
import { createTournamentService } from "../../src/services/tournaments.js";

const mockSetNames = ["Legend of Blue Eyes White Dragon", "Metal Raiders", "Pharaoh's Servant"];

function mockCardsForSet(setName: string, startId: number, count: number) {
  return Array.from({ length: count }, (_, index) => ({
    id: startId + index,
    name: `${setName} Card ${index + 1}`,
    type: "Spellcaster / Normal Monster",
    frameType: "normal",
    card_images: [{ image_url: `https://img/full/${startId + index}`, image_url_small: `https://img/small/${startId + index}` }],
    card_sets: [{ set_name: setName }],
  }));
}

type CommandDependencies = Parameters<typeof handleCommand>[1];
type _DraftCommandDependencyChecks = [
  CommandDependencies["drafts"],
  CommandDependencies["cards"],
  CommandDependencies["templates"],
  CommandDependencies["draftImages"],
  CommandDependencies["messenger"],
];

type FakeUser = { id: string; username: string };
type FakeRole = { id: string; name: string };

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

function setup(options: { cardsBySet?: Record<string, unknown[]>; fetchCalls?: string[] } = {}) {
  const db = new Database(":memory:");
  migrate(db);
  const players = createPlayerRepository(db);
  const matches = createMatchService(db);
  const tournaments = createTournamentService(db);
  const drafts = createDraftService(db);
  const cards = createCardCatalogService(db, {
    fetch: async (input) => {
      const url = new URL(String(input));
      options.fetchCalls?.push(String(url));

      if (url.pathname.endsWith("cardsets.php")) {
        return {
          ok: true,
          async json() {
            return mockSetNames.map((set_name) => ({ set_name }));
          },
        } as Response;
      }

      if (url.pathname.endsWith("cardinfo.php") && url.searchParams.has("cardset")) {
        return {
          ok: true,
          async json() {
            return { data: options.cardsBySet?.[url.searchParams.get("cardset") ?? ""] ?? [] };
          },
        } as Response;
      }

      return { ok: true, async json() { return { data: [] }; } } as Response;
    },
  });
  const templates = createDraftTemplateService(db);
  const draftImages = createDraftImageService({ cacheDir: "./data/test-card-images" });
  const postStatusCalls: Array<{ draftId: number }> = [];
  const updateStatusCalls: Array<{ draftId: number }> = [];
  const messenger = {
    async postStatus(draft: { id: number }) {
      postStatusCalls.push({ draftId: draft.id });
    },
    async updateStatus(draft: { id: number }) {
      updateStatusCalls.push({ draftId: draft.id });
    },
  };

  return { db, matches, players, tournaments, drafts, cards, templates, draftImages, messenger, postStatusCalls, updateStatusCalls };
}

function fakeInteraction(input: {
  commandName: string;
  user: FakeUser;
  subcommand?: string;
  subcommandGroup?: string | null;
  roles?: Record<string, FakeRole>;
  users?: Record<string, FakeUser>;
  strings?: Record<string, string>;
}) {
  const replies: Array<string | { content: string; ephemeral?: boolean; components?: readonly unknown[]; files?: readonly unknown[] }> = [];
  const interaction: CommandInteractionLike = {
    commandName: input.commandName,
    channelId: "channel-1",
    guildId: "guild-1",
    user: input.user,
    options: {
      getSubcommand: () => input.subcommand ?? "",
      getSubcommandGroup: () => input.subcommandGroup ?? null,
      getString: (name) => input.strings?.[name] ?? null,
      getRole: (name) => input.roles?.[name] ?? null,
      getUser: (name) => input.users?.[name] ?? null,
    },
    reply: (message) => {
      replies.push(message);
    },
  };

  return { interaction, replies };
}

describe("command handlers", () => {
  it("/help lists duel and tournament commands", async () => {
    const app = setup();
    const yugi = { id: "user-1", username: "Yugi" };
    const { interaction, replies } = fakeInteraction({ commandName: "help", user: yugi });

    await handleCommand(interaction, app);

    expect(replies[0]).toEqual(expect.stringContaining("Duel commands"));
    expect(replies[0]).toEqual(expect.stringContaining("/duel"));
    expect(replies[0]).toEqual(expect.stringContaining("/approve"));
    expect(replies[0]).toEqual(expect.stringContaining("/deny"));
    expect(replies[0]).toEqual(expect.stringContaining("/stats"));
    expect(replies[0]).toEqual(expect.stringContaining("/rankings"));
    expect(replies[0]).toEqual(expect.stringContaining("Tournament commands"));
    expect(replies[0]).toEqual(expect.stringContaining("/event create"));
    expect(replies[0]).toEqual(expect.stringContaining("/event dashboard"));
    expect(replies[0]).toEqual(expect.stringContaining("/event signup"));
    expect(replies[0]).toEqual(expect.stringContaining("/event join"));
    expect(replies[0]).toEqual(expect.stringContaining("/event list"));
    expect(replies[0]).toEqual(expect.stringContaining("/event start"));
    expect(replies[0]).toEqual(expect.stringContaining("/event show"));
    expect(replies[0]).toEqual(expect.stringContaining("/event participants"));
    expect(replies[0]).toEqual(expect.stringContaining("/event report"));
    expect(replies[0]).toEqual(expect.stringContaining("/event cancel"));
  });

  it("/event dashboard replies privately with dashboard buttons", async () => {
    const app = setup();
    const yugi = { id: "user-1", username: "Yugi" };
    const { interaction, replies } = fakeInteraction({
      commandName: "event",
      subcommand: "dashboard",
      user: yugi,
    });

    await handleCommand(interaction, app);

    expect(replies[0]).toMatchObject({
      content: expect.stringContaining("Tournament Dashboard"),
      ephemeral: true,
    });
    expect(JSON.stringify(replies[0])).toContain("dashboard_create_event");
    expect(JSON.stringify(replies[0])).toContain("dashboard_open_events");
    expect(JSON.stringify(replies[0])).toContain("dashboard_report_match");
    expect(JSON.stringify(replies[0])).toContain("dashboard_pending_approvals");
  });

  it("/draft dashboard replies privately with draft buttons", async () => {
    const app = setup();
    const yugi = { id: "user-1", username: "Yugi" };
    const { interaction, replies } = fakeInteraction({
      commandName: "draft",
      subcommand: "dashboard",
      user: yugi,
    });

    await handleCommand(interaction, app);

    expect(replies[0]).toMatchObject({
      content: expect.stringContaining("Draft Dashboard"),
      ephemeral: true,
    });
    expect(JSON.stringify(replies[0])).toContain("draft_create");
    expect(JSON.stringify(replies[0])).toContain("draft_open");
    expect(JSON.stringify(replies[0])).toContain("draft_export");
  });

  it("/draft create creates a draft with sets, includes, and excludes", async () => {
    const app = setup();
    const yugi = { id: "user-1", username: "Yugi" };
    const { interaction, replies } = fakeInteraction({
      commandName: "draft",
      subcommand: "create",
      user: yugi,
      strings: {
        name: "cube night",
        set1: "Metal Raiders",
        set2: "Legend of Blue Eyes White Dragon",
        includes: "Dark Magician",
        excludes: "Blue-Eyes White Dragon",
      },
    });

    await handleCommand(interaction, app);

    expect(replies[0]).toMatchObject({
      content: expect.stringContaining("Signups are open for cube night"),
    });
    expect(JSON.stringify(replies[0])).toContain("join_draft");

    const draft = app.drafts.findByName("guild-1", "cube night");

    expect(draft).toBeDefined();
    expect(draft?.config).toEqual({
      setNames: ["Metal Raiders", "Legend of Blue Eyes White Dragon"],
      includeNames: ["Dark Magician"],
      excludeNames: ["Blue-Eyes White Dragon"],
      packSize: 8,
      packsPerPlayer: 5,
      pickSeconds: 45,
      alternatePassDirection: true,
      randomizeSeats: false,
    });
  });

  it("/draft create trims and deduplicates set options", async () => {
    const app = setup();
    const { interaction } = fakeInteraction({
      commandName: "draft",
      subcommand: "create",
      user: { id: "user-1", username: "Yugi" },
      strings: {
        name: "trimmed draft",
        set1: " Metal Raiders ",
        set2: "Metal Raiders",
        set3: "Legend of Blue Eyes White Dragon",
      },
    });

    await handleCommand(interaction, app);

    expect(app.drafts.findByName("guild-1", "trimmed draft")?.config.setNames).toEqual([
      "Metal Raiders",
      "Legend of Blue Eyes White Dragon",
    ]);
  });

  it("/draft create creates a draft with no optional fields", async () => {
    const app = setup();
    const yugi = { id: "user-1", username: "Yugi" };
    const { interaction, replies } = fakeInteraction({
      commandName: "draft",
      subcommand: "create",
      user: yugi,
      strings: { name: "empty draft" },
    });

    await handleCommand(interaction, app);

    expect(replies[0]).toMatchObject({
      content: expect.stringContaining("Signups are open for empty draft"),
    });
    expect(JSON.stringify(replies[0])).toContain("join_draft");

    const draft = app.drafts.findByName("guild-1", "empty draft");

    expect(draft).toBeDefined();
    expect(draft?.config).toEqual({
      setNames: [],
      includeNames: [],
      excludeNames: [],
      packSize: 8,
      packsPerPlayer: 5,
      pickSeconds: 45,
      alternatePassDirection: true,
      randomizeSeats: false,
    });
  });

  it("/draft join joins a pending draft by name", async () => {
    const app = setup();
    const yugi = app.players.upsert("guild-1", "user-7", "Yugi");
    const draft = app.drafts.create("guild-1", "channel-1", "cube night", {}, "user-7", yugi.id);
    const { interaction, replies } = fakeInteraction({
      commandName: "draft",
      subcommand: "join",
      user: { id: "user-9", username: "Kaiba" },
      strings: { name: "cube night" },
    });

    await handleCommand(interaction, app);

    expect(app.drafts.players(draft.id)).toEqual([
      { playerId: yugi.id, displayName: "Yugi" },
      { playerId: expect.any(Number), displayName: "Kaiba" },
    ]);
    expect(replies[0]).toBe("Joined draft: cube night.");
  });

  it("/draft start requires the creator and sends pick prompts to all joined players", async () => {
    const app = setup();
    const yugi = app.players.upsert("guild-1", "user-7", "Yugi");
    const kaiba = app.players.upsert("guild-1", "user-9", "Kaiba");
    const draft = app.drafts.create("guild-1", "channel-1", "cube night", {}, "user-7", yugi.id);
    app.drafts.join(draft.id, kaiba.id);
    seedDraftCatalog(app, 16);
    const { interaction, replies } = fakeInteraction({
      commandName: "draft",
      subcommand: "start",
      user: { id: "user-7", username: "Yugi" },
      strings: { name: "cube night" },
    });

    await handleCommand(interaction, app);

    expect(app.drafts.findById(draft.id)).toMatchObject({
      status: "active",
      currentPackRound: 1,
      currentPickStep: 1,
    });
    expect(replies[0]).toBe("Started draft: cube night.");
    expect(app.postStatusCalls).toEqual([{ draftId: draft.id }]);
  });

  it("/draft start syncs set-backed pools before opening the first wave", async () => {
    const app = setup({
      cardsBySet: {
        "Metal Raiders": mockCardsForSet("Metal Raiders", 1000, 8),
        "Legend of Blue Eyes White Dragon": mockCardsForSet("Legend of Blue Eyes White Dragon", 2000, 8),
      },
    });
    const yugi = { id: "user-7", username: "Yugi" };

    await handleCommand(
      fakeInteraction({
        commandName: "draft",
        subcommand: "create",
        user: yugi,
        strings: {
          name: "retro draft",
          set1: "Metal Raiders",
          set2: "Legend of Blue Eyes White Dragon",
        },
      }).interaction,
      app,
    );

    await handleCommand(
      fakeInteraction({
        commandName: "draft",
        subcommand: "join",
        user: { id: "user-9", username: "Kaiba" },
        strings: { name: "retro draft" },
      }).interaction,
      app,
    );

    await handleCommand(
      fakeInteraction({
        commandName: "draft",
        subcommand: "start",
        user: yugi,
        strings: { name: "retro draft" },
      }).interaction,
      app,
    );

    const draft = app.drafts.findByName("guild-1", "retro draft")!;

    expect(draft.status).toBe("active");
    expect(app.db.prepare("select count(*) as count from draft_cards where draft_id = ?").get(draft.id)).toEqual({ count: 16 });
  });

  it("/draft start rejects non-creators", async () => {
    const app = setup();
    const yugi = app.players.upsert("guild-1", "user-7", "Yugi");
    app.players.upsert("guild-1", "user-9", "Kaiba");
    app.drafts.create("guild-1", "channel-1", "cube night", {}, "user-7", yugi.id);

    await expect(
      handleCommand(
        fakeInteraction({
          commandName: "draft",
          subcommand: "start",
          user: { id: "user-9", username: "Kaiba" },
          strings: { name: "cube night" },
        }).interaction,
        app,
      ),
    ).rejects.toThrow("Only the draft creator can do that");
  });

  it("/draft export returns a ydk attachment when deck is complete", async () => {
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

    const { interaction, replies } = fakeInteraction({
      commandName: "draft",
      subcommand: "export",
      user: { id: "user-7", username: "Yugi" },
      strings: { name: "cube night" },
    });

    await handleCommand(interaction, app);

    const reply = replies[0] as { content: string; files?: readonly unknown[] };
    expect(reply.content).toContain("Exported cube night");
    expect(reply.files).toBeDefined();
    expect((reply.files![0] as { name: string }).name).toBe("cube-night.ydk");
  });

  it("/draft export rejects incomplete decks", async () => {
    const app = setup();
    const yugi = app.players.upsert("guild-1", "user-7", "Yugi");
    const kaiba = app.players.upsert("guild-1", "user-9", "Kaiba");
    const draft = app.drafts.create("guild-1", "channel-1", "cube night", {}, "user-7", yugi.id);
    app.drafts.join(draft.id, kaiba.id);
    seedDraftCatalog(app, 16);
    app.drafts.start(draft.id);

    await expect(
      handleCommand(
        fakeInteraction({
          commandName: "draft",
          subcommand: "export",
          user: { id: "user-7", username: "Yugi" },
          strings: { name: "cube night" },
        }).interaction,
        app,
      ),
    ).rejects.toThrow("Deck is not complete yet");
  });

  it("/draft cancel cancels a pending draft by name", async () => {
    const app = setup();
    const yugi = app.players.upsert("guild-1", "user-7", "Yugi");
    app.drafts.create("guild-1", "channel-1", "cube night", {}, "user-7", yugi.id);
    const { interaction, replies } = fakeInteraction({
      commandName: "draft",
      subcommand: "cancel",
      user: { id: "user-7", username: "Yugi" },
      strings: { name: "cube night" },
    });

    await handleCommand(interaction, app);

    const draft = app.drafts.findByName("guild-1", "cube night");

    expect(draft?.status).toBe("cancelled");
    expect(replies[0]).toBe("Cancelled draft: cube night.");
  });

  it("/draft cancel rejects non-creators", async () => {
    const app = setup();
    const yugi = app.players.upsert("guild-1", "user-7", "Yugi");
    app.drafts.create("guild-1", "channel-1", "cube night", {}, "user-7", yugi.id);

    await expect(
      handleCommand(
        fakeInteraction({
          commandName: "draft",
          subcommand: "cancel",
          user: { id: "user-9", username: "Kaiba" },
          strings: { name: "cube night" },
        }).interaction,
        app,
      ),
    ).rejects.toThrow("Only the draft creator can do that");
  });

  it("/draft show displays draft details and participants", async () => {
    const app = setup();
    const yugi = app.players.upsert("guild-1", "user-7", "Yugi");
    const kaiba = app.players.upsert("guild-1", "user-9", "Kaiba");
    const draft = app.drafts.create("guild-1", "channel-1", "cube night", {}, "user-7", yugi.id);
    app.drafts.join(draft.id, kaiba.id);
    const { interaction, replies } = fakeInteraction({
      commandName: "draft",
      subcommand: "show",
      user: { id: "user-1", username: "Yugi" },
      strings: { name: "cube night" },
    });

    await handleCommand(interaction, app);

    expect(replies[0]).toEqual(expect.stringContaining("cube night"));
    expect(replies[0]).toEqual(expect.stringContaining("Yugi"));
    expect(replies[0]).toEqual(expect.stringContaining("Kaiba"));
    expect(replies[0]).toEqual(expect.stringContaining("pending"));
  });

  it("/draft show caps participant lists", async () => {
    const app = setup();
    const yugi = app.players.upsert("guild-1", "user-7", "Yugi");
    app.drafts.create("guild-1", "channel-1", "big draft", {}, "user-7", yugi.id);

    for (let index = 0; index < 30; index += 1) {
      await handleCommand(
        fakeInteraction({
          commandName: "draft",
          subcommand: "join",
          user: { id: `user-${index + 100}`, username: `Player ${index + 1}` },
          strings: { name: "big draft" },
        }).interaction,
        app,
      );
    }

    const { interaction, replies } = fakeInteraction({
      commandName: "draft",
      subcommand: "show",
      user: { id: "user-1", username: "Yugi" },
      strings: { name: "big draft" },
    });

    await handleCommand(interaction, app);

    expect(replies[0]).toEqual(expect.stringContaining("Players (31):"));
    expect(replies[0]).toEqual(expect.stringContaining("...and 6 more player(s)."));
    expect(replies[0]).not.toEqual(expect.stringContaining("Player 30"));
  });

  it("/draft join replies clearly for duplicate joins", async () => {
    const app = setup();
    const yugi = app.players.upsert("guild-1", "user-7", "Yugi");
    app.drafts.create("guild-1", "channel-1", "cube night", {}, "user-7", yugi.id);
    const { interaction, replies } = fakeInteraction({
      commandName: "draft",
      subcommand: "join",
      user: { id: "user-7", username: "Yugi" },
      strings: { name: "cube night" },
    });

    await handleCommand(interaction, app);

    expect(replies[0]).toEqual({ content: "You have already joined this draft.", ephemeral: true });
  });

  it("/draft sets lists available card sets from the API", async () => {
    const app = setup();
    await app.cards.syncSets();
    const { interaction, replies } = fakeInteraction({
      commandName: "draft",
      subcommand: "sets",
      user: { id: "user-1", username: "Yugi" },
    });

    await handleCommand(interaction, app);

    expect(replies[0]).toBe(
      [
        "Available sets:",
        ...mockSetNames.map((set) => `- ${set}`),
      ].join("\n"),
    );
  });

  it("/draft sets filters card sets by query", async () => {
    const app = setup();
    await app.cards.syncSets();
    const { interaction, replies } = fakeInteraction({
      commandName: "draft",
      subcommand: "sets",
      user: { id: "user-1", username: "Yugi" },
      strings: { query: "metal" },
    });

    await handleCommand(interaction, app);

    expect(replies[0]).toBe('Sets matching "metal":\n- Metal Raiders');
  });

  it("/duel creates a pending match and /approve finalizes it", async () => {
    const app = setup();
    const yugi = { id: "user-1", username: "Yugi" };
    const kaiba = { id: "user-2", username: "Kaiba" };

    await handleCommand(
      fakeInteraction({
        commandName: "duel",
        user: yugi,
        users: { player: kaiba },
        strings: { result: "win" },
      }).interaction,
      app,
    );

    const kaibaPlayer = app.players.findByDiscordId("guild-1", kaiba.id)!;
    expect(app.matches.latestPendingForPlayer(kaibaPlayer.id)?.status).toBe("pending");

    await handleCommand(fakeInteraction({ commandName: "approve", user: kaiba }).interaction, app);

    const yugiPlayer = app.players.findByDiscordId("guild-1", yugi.id)!;
    expect(app.matches.stats(yugiPlayer.id)).toEqual({ wins: 1, losses: 0 });
  });

  it("/stats replies with a player's record", async () => {
    const app = setup();
    const yugi = { id: "user-1", username: "Yugi" };
    const { interaction, replies } = fakeInteraction({ commandName: "stats", user: yugi });

    await handleCommand(interaction, app);

    expect(replies[0]).toContain("Yugi: 0W - 0L");
  });

  it("/stats with a tournament replies with tournament-only approved stats", async () => {
    const app = setup();
    const yugi = { id: "user-1", username: "Yugi" };
    const kaiba = { id: "user-2", username: "Kaiba" };

    await handleCommand(
      fakeInteraction({ commandName: "duel", user: yugi, users: { player: kaiba }, strings: { result: "loss" } })
        .interaction,
      app,
    );
    await handleCommand(fakeInteraction({ commandName: "approve", user: kaiba }).interaction, app);
    await handleCommand(
      fakeInteraction({
        commandName: "event",
        subcommand: "create",
        user: yugi,
        users: { player1: yugi, player2: kaiba },
        strings: { name: "locals", format: "round_robin" },
      }).interaction,
      app,
    );
    await handleCommand(
      fakeInteraction({ commandName: "event", subcommand: "start", user: yugi, strings: { name: "locals" } })
        .interaction,
      app,
    );
    await handleCommand(
      fakeInteraction({
        commandName: "event",
        subcommand: "report",
        user: yugi,
        users: { player: kaiba },
        strings: { name: "locals", result: "win" },
      }).interaction,
      app,
    );
    await handleCommand(fakeInteraction({ commandName: "approve", user: kaiba }).interaction, app);

    const { interaction, replies } = fakeInteraction({
      commandName: "stats",
      user: yugi,
      strings: { tournament: "locals" },
    });

    await handleCommand(interaction, app);

    expect(replies[0]).toBe("Yugi in locals: 1W - 0L (100% win rate)");
  });

  it("/stats without a tournament uses the only active tournament for the target player", async () => {
    const app = setup();
    const yugi = { id: "user-1", username: "Yugi" };
    const kaiba = { id: "user-2", username: "Kaiba" };

    await handleCommand(
      fakeInteraction({ commandName: "duel", user: yugi, users: { player: kaiba }, strings: { result: "loss" } })
        .interaction,
      app,
    );
    await handleCommand(fakeInteraction({ commandName: "approve", user: kaiba }).interaction, app);
    await handleCommand(
      fakeInteraction({
        commandName: "event",
        subcommand: "create",
        user: yugi,
        users: { player1: yugi, player2: kaiba },
        strings: { name: "locals", format: "round_robin" },
      }).interaction,
      app,
    );
    await handleCommand(
      fakeInteraction({ commandName: "event", subcommand: "start", user: yugi, strings: { name: "locals" } })
        .interaction,
      app,
    );
    await handleCommand(
      fakeInteraction({
        commandName: "event",
        subcommand: "report",
        user: yugi,
        users: { player: kaiba },
        strings: { name: "locals", result: "win" },
      }).interaction,
      app,
    );
    await handleCommand(fakeInteraction({ commandName: "approve", user: kaiba }).interaction, app);

    const { interaction, replies } = fakeInteraction({ commandName: "stats", user: yugi });

    await handleCommand(interaction, app);

    expect(replies[0]).toBe("Yugi in locals: 1W - 0L (100% win rate)");
  });

  it("/stats player applies active tournament context to the target player", async () => {
    const app = setup();
    const yugi = { id: "user-1", username: "Yugi" };
    const kaiba = { id: "user-2", username: "Kaiba" };

    await handleCommand(
      fakeInteraction({
        commandName: "event",
        subcommand: "create",
        user: yugi,
        users: { player1: yugi, player2: kaiba },
        strings: { name: "locals", format: "round_robin" },
      }).interaction,
      app,
    );
    await handleCommand(
      fakeInteraction({ commandName: "event", subcommand: "start", user: yugi, strings: { name: "locals" } })
        .interaction,
      app,
    );
    await handleCommand(
      fakeInteraction({
        commandName: "event",
        subcommand: "report",
        user: yugi,
        users: { player: kaiba },
        strings: { name: "locals", result: "win" },
      }).interaction,
      app,
    );
    await handleCommand(fakeInteraction({ commandName: "approve", user: kaiba }).interaction, app);

    const { interaction, replies } = fakeInteraction({ commandName: "stats", user: yugi, users: { player: kaiba } });

    await handleCommand(interaction, app);

    expect(replies[0]).toBe("Kaiba in locals: 0W - 1L (0% win rate)");
  });

  it("/stats without a tournament falls back to lifetime stats when the player has no active tournaments", async () => {
    const app = setup();
    const yugi = { id: "user-1", username: "Yugi" };
    const kaiba = { id: "user-2", username: "Kaiba" };

    await handleCommand(
      fakeInteraction({ commandName: "duel", user: yugi, users: { player: kaiba }, strings: { result: "win" } })
        .interaction,
      app,
    );
    await handleCommand(fakeInteraction({ commandName: "approve", user: kaiba }).interaction, app);

    const { interaction, replies } = fakeInteraction({ commandName: "stats", user: yugi });

    await handleCommand(interaction, app);

    expect(replies[0]).toBe("Yugi: 1W - 0L (100% win rate)");
  });

  it("/stats without a tournament asks for scope when the player has multiple active tournaments", async () => {
    const app = setup();
    const yugi = { id: "user-1", username: "Yugi" };
    const kaiba = { id: "user-2", username: "Kaiba" };

    for (const name of ["locals", "regionals"]) {
      await handleCommand(
        fakeInteraction({
          commandName: "event",
          subcommand: "create",
          user: yugi,
          users: { player1: yugi, player2: kaiba },
          strings: { name, format: "round_robin" },
        }).interaction,
        app,
      );
      await handleCommand(
        fakeInteraction({ commandName: "event", subcommand: "start", user: yugi, strings: { name } }).interaction,
        app,
      );
    }

    const { interaction, replies } = fakeInteraction({ commandName: "stats", user: yugi });

    await handleCommand(interaction, app);

    expect(replies[0]).toBe("Yugi is in multiple active tournaments. Specify one with tournament: locals, regionals");
  });

  it("/stats with an unknown tournament rejects the name", async () => {
    const app = setup();
    const yugi = { id: "user-1", username: "Yugi" };

    await expect(
      handleCommand(
        fakeInteraction({ commandName: "stats", user: yugi, strings: { tournament: "missing" } }).interaction,
        app,
      ),
    ).rejects.toThrow("Tournament not found: missing");
  });

  it("/event list shows active tournaments before pending tournaments", async () => {
    const app = setup();
    const yugi = { id: "user-1", username: "Yugi" };
    const kaiba = { id: "user-2", username: "Kaiba" };

    await handleCommand(
      fakeInteraction({
        commandName: "event",
        subcommand: "create",
        user: yugi,
        users: { player1: yugi, player2: kaiba },
        strings: { name: "active cup", format: "round_robin" },
      }).interaction,
      app,
    );
    await handleCommand(
      fakeInteraction({
        commandName: "event",
        subcommand: "create",
        user: yugi,
        users: { player1: yugi },
        strings: { name: "pending cup", format: "single_elim" },
      }).interaction,
      app,
    );
    await handleCommand(
      fakeInteraction({ commandName: "event", subcommand: "start", user: yugi, strings: { name: "active cup" } })
        .interaction,
      app,
    );
    await handleCommand(
      fakeInteraction({
        commandName: "event",
        subcommand: "report",
        user: yugi,
        users: { player: kaiba },
        strings: { name: "active cup", result: "win" },
      }).interaction,
      app,
    );

    const { interaction, replies } = fakeInteraction({ commandName: "event", subcommand: "list", user: yugi });

    await handleCommand(interaction, app);

    expect(replies[0]).toBe(
      "Active events:\n- active cup (round_robin): 0 open match(es)\nPending events:\n- pending cup (single_elim): 1 participant(s)",
    );
  });

  it("/event list limits active and pending sections with summary counts", async () => {
    const app = setup();
    const yugi = { id: "user-1", username: "Yugi" };
    const kaiba = { id: "user-2", username: "Kaiba" };

    for (let index = 1; index <= 11; index += 1) {
      await handleCommand(
        fakeInteraction({
          commandName: "event",
          subcommand: "create",
          user: yugi,
          users: { player1: yugi, player2: kaiba },
          strings: { name: `active ${index}`, format: "round_robin" },
        }).interaction,
        app,
      );
      await handleCommand(
        fakeInteraction({
          commandName: "event",
          subcommand: "start",
          user: yugi,
          strings: { name: `active ${index}` },
        }).interaction,
        app,
      );
      await handleCommand(
        fakeInteraction({
          commandName: "event",
          subcommand: "create",
          user: yugi,
          strings: { name: `pending ${index}`, format: "single_elim" },
        }).interaction,
        app,
      );
    }

    const { interaction, replies } = fakeInteraction({ commandName: "event", subcommand: "list", user: yugi });

    await handleCommand(interaction, app);

    const reply = replies[0] as string;
    expect(reply).toContain("- active 5 (round_robin): 1 open match(es)");
    expect(reply).not.toContain("- active 6");
    expect(reply).toContain("...and 6 more active event(s).");
    expect(reply).toContain("- pending 5 (single_elim): 0 participant(s)");
    expect(reply).not.toContain("- pending 6");
    expect(reply).toContain("...and 6 more pending event(s).");
    expect(reply.length).toBeLessThanOrEqual(2000);
  });

  it("/event list stays below Discord's reply limit with max-length tournament names", async () => {
    const app = setup();
    const yugi = { id: "user-1", username: "Yugi" };
    const kaiba = { id: "user-2", username: "Kaiba" };

    for (let index = 1; index <= 6; index += 1) {
      const activeName = `active-${String(index).padStart(2, "0")}-${"a".repeat(90)}`;
      const pendingName = `pending-${String(index).padStart(2, "0")}-${"p".repeat(89)}`;

      await handleCommand(
        fakeInteraction({
          commandName: "event",
          subcommand: "create",
          user: yugi,
          users: { player1: yugi, player2: kaiba },
          strings: { name: activeName, format: "round_robin" },
        }).interaction,
        app,
      );
      await handleCommand(
        fakeInteraction({
          commandName: "event",
          subcommand: "start",
          user: yugi,
          strings: { name: activeName },
        }).interaction,
        app,
      );
      await handleCommand(
        fakeInteraction({
          commandName: "event",
          subcommand: "create",
          user: yugi,
          strings: { name: pendingName, format: "single_elim" },
        }).interaction,
        app,
      );
    }

    const { interaction, replies } = fakeInteraction({ commandName: "event", subcommand: "list", user: yugi });

    await handleCommand(interaction, app);

    const reply = replies[0] as string;
    expect(reply).toContain("...and 1 more active event(s).");
    expect(reply).toContain("...and 1 more pending event(s).");
    expect(reply).not.toContain("active-06");
    expect(reply).not.toContain("pending-06");
    expect(reply.length).toBeLessThan(2000);
  });

  it("/event participants lists tournament participants with count and numbered names", async () => {
    const app = setup();
    const yugi = { id: "user-1", username: "Yugi" };
    const kaiba = { id: "user-2", username: "Kaiba" };
    const joey = { id: "user-3", username: "Joey" };

    await handleCommand(
      fakeInteraction({
        commandName: "event",
        subcommand: "create",
        user: yugi,
        users: { player1: yugi, player2: kaiba, player3: joey },
        strings: { name: "locals", format: "round_robin" },
      }).interaction,
      app,
    );

    const { interaction, replies } = fakeInteraction({
      commandName: "event",
      subcommand: "participants",
      user: yugi,
      strings: { name: "locals" },
    });

    await handleCommand(interaction, app);

    expect(replies[0]).toBe("locals participants (3):\n1. Yugi\n2. Kaiba\n3. Joey");
  });

  it("/event participants says when the tournament has no participants", async () => {
    const app = setup();
    const yugi = { id: "user-1", username: "Yugi" };

    await handleCommand(
      fakeInteraction({
        commandName: "event",
        subcommand: "create",
        user: yugi,
        strings: { name: "locals", format: "round_robin" },
      }).interaction,
      app,
    );

    const { interaction, replies } = fakeInteraction({
      commandName: "event",
      subcommand: "participants",
      user: yugi,
      strings: { name: "locals" },
    });

    await handleCommand(interaction, app);

    expect(replies[0]).toBe("locals has no participants yet.");
  });

  it("/event participants caps long lists and summarizes hidden participants", async () => {
    const app = setup();
    const yugi = { id: "user-1", username: "Yugi" };
    const users = Object.fromEntries(
      Array.from({ length: 30 }, (_, index) => {
        const playerNumber = index + 1;

        return [
          `player${playerNumber}`,
          { id: `user-${playerNumber}`, username: `Player ${playerNumber}` },
        ];
      }),
    );

    await handleCommand(
      fakeInteraction({
        commandName: "event",
        subcommand: "create",
        user: yugi,
        strings: { name: "locals", format: "round_robin" },
      }).interaction,
      app,
    );

    const tournament = app.tournaments.findByName("guild-1", "locals")!;
    for (const user of Object.values(users)) {
      const player = app.players.upsert("guild-1", user.id, user.username);
      app.tournaments.join(tournament.id, player.id);
    }

    const { interaction, replies } = fakeInteraction({
      commandName: "event",
      subcommand: "participants",
      user: yugi,
      strings: { name: "locals" },
    });

    await handleCommand(interaction, app);

    const reply = replies[0] as string;
    expect(reply).toContain("locals participants (30):");
    expect(reply).toContain("25. Player 25");
    expect(reply).not.toContain("26. Player 26");
    expect(reply).toContain("...and 5 more participant(s).");
    expect(reply.length).toBeLessThanOrEqual(2000);
  });

  it("/event signup requires the creator and posts a join button", async () => {
    const app = setup();
    const yugi = { id: "user-1", username: "Yugi" };
    const kaiba = { id: "user-2", username: "Kaiba" };
    const role = { id: "role-1", name: "Duelists" };

    await handleCommand(
      fakeInteraction({
        commandName: "event",
        subcommand: "create",
        user: yugi,
        strings: { name: "locals", format: "round_robin" },
      }).interaction,
      app,
    );

    await expect(
      handleCommand(
        fakeInteraction({ commandName: "event", subcommand: "signup", user: kaiba, strings: { name: "locals" } })
          .interaction,
        app,
      ),
    ).rejects.toThrow("Only the event creator can do that");

    const { interaction, replies } = fakeInteraction({
      commandName: "event",
      subcommand: "signup",
      user: yugi,
      roles: { role },
      strings: { name: "locals" },
    });

    await handleCommand(interaction, app);

    const tournament = app.tournaments.findByName("guild-1", "locals")!;
    expect(replies[0]).toMatchObject({
      content: `<@&${role.id}> Signups are open for locals (round_robin). Click Join Tournament to enter.`,
    });
    expect(replies[0]).not.toHaveProperty("ephemeral", true);
    expect(JSON.parse(JSON.stringify(replies[0])).components[0].components[0].custom_id).toBe(
      `join_tournament:${tournament.id}`,
    );
  });

  it("/event signup only works for pending tournaments", async () => {
    const app = setup();
    const yugi = { id: "user-1", username: "Yugi" };
    const kaiba = { id: "user-2", username: "Kaiba" };

    await handleCommand(
      fakeInteraction({
        commandName: "event",
        subcommand: "create",
        user: yugi,
        users: { player1: yugi, player2: kaiba },
        strings: { name: "locals", format: "round_robin" },
      }).interaction,
      app,
    );
    await handleCommand(
      fakeInteraction({ commandName: "event", subcommand: "start", user: yugi, strings: { name: "locals" } })
        .interaction,
      app,
    );

    await expect(
      handleCommand(
        fakeInteraction({ commandName: "event", subcommand: "signup", user: yugi, strings: { name: "locals" } })
          .interaction,
        app,
      ),
    ).rejects.toThrow("Tournament has already started");
  });

  it("handles event create, join, start, report, and cancel", async () => {
    const app = setup();
    const yugi = { id: "user-1", username: "Yugi" };
    const kaiba = { id: "user-2", username: "Kaiba" };

    await handleCommand(
      fakeInteraction({
        commandName: "event",
        subcommand: "create",
        user: yugi,
        strings: { name: "locals", format: "round_robin" },
      }).interaction,
      app,
    );
    await handleCommand(
      fakeInteraction({ commandName: "event", subcommand: "join", user: yugi, strings: { name: "locals" } })
        .interaction,
      app,
    );
    await handleCommand(
      fakeInteraction({ commandName: "event", subcommand: "join", user: kaiba, strings: { name: "locals" } })
        .interaction,
      app,
    );
    await handleCommand(
      fakeInteraction({ commandName: "event", subcommand: "start", user: yugi, strings: { name: "locals" } })
        .interaction,
      app,
    );

    const tournament = app.tournaments.findByName("guild-1", "locals")!;
    expect(app.tournaments.openMatches(tournament.id)).toHaveLength(1);

    await handleCommand(
      fakeInteraction({
        commandName: "event",
        subcommand: "report",
        user: yugi,
        users: { player: kaiba },
        strings: { name: "locals", result: "win" },
      }).interaction,
      app,
    );

    expect(app.tournaments.openMatches(tournament.id)[0].status).toBe("pending_approval");

    await handleCommand(
      fakeInteraction({ commandName: "event", subcommand: "cancel", user: yugi, strings: { name: "locals" } })
        .interaction,
      app,
    );

    expect(app.tournaments.findByName("guild-1", "locals")?.status).toBe("cancelled");
  });

  it("/event create posts a public join button", async () => {
    const app = setup();
    const yugi = { id: "user-1", username: "Yugi" };
    const { interaction, replies } = fakeInteraction({
      commandName: "event",
      subcommand: "create",
      user: yugi,
      strings: { name: "locals", format: "round_robin" },
    });

    await handleCommand(interaction, app);

    const tournament = app.tournaments.findByName("guild-1", "locals")!;
    expect(replies[0]).toMatchObject({
      content: "Signups are open for locals (round_robin). Click Join Tournament to enter.",
    });
    expect(replies[0]).not.toHaveProperty("ephemeral", true);
    expect(JSON.parse(JSON.stringify(replies[0])).components[0].components[0].custom_id).toBe(
      `join_tournament:${tournament.id}`,
    );
  });

  it("/event join replies clearly for duplicate joins", async () => {
    const app = setup();
    const yugi = app.players.upsert("guild-1", "user-1", "Yugi");
    const tournament = app.tournaments.create("guild-1", "locals", "round_robin", "user-1");
    app.tournaments.join(tournament.id, yugi.id);
    const { interaction, replies } = fakeInteraction({
      commandName: "event",
      subcommand: "join",
      user: { id: "user-1", username: "Yugi" },
      strings: { name: "locals" },
    });

    await handleCommand(interaction, app);

    expect(replies[0]).toEqual({ content: "You have already joined this tournament.", ephemeral: true });
  });

  it("/event create seeds unique provided players", async () => {
    const app = setup();
    const yugi = { id: "user-1", username: "Yugi" };
    const kaiba = { id: "user-2", username: "Kaiba" };
    const joey = { id: "user-3", username: "Joey" };
    const { interaction, replies } = fakeInteraction({
      commandName: "event",
      subcommand: "create",
      user: yugi,
      users: { player1: yugi, player2: kaiba, player3: yugi, player4: joey },
      strings: { name: "locals", format: "round_robin" },
    });

    await handleCommand(interaction, app);

    const tournament = app.tournaments.findByName("guild-1", "locals")!;
    expect(app.tournaments.participants(tournament.id)).toHaveLength(3);
    expect(replies[0]).toMatchObject({
      content:
        "Signups are open for locals (round_robin). Seeded 3 participant(s). Click Join Tournament to enter.",
    });
  });

  it("/event create without seeded players still works", async () => {
    const app = setup();
    const yugi = { id: "user-1", username: "Yugi" };
    const { interaction, replies } = fakeInteraction({
      commandName: "event",
      subcommand: "create",
      user: yugi,
      strings: { name: "locals", format: "round_robin" },
    });

    await handleCommand(interaction, app);

    const tournament = app.tournaments.findByName("guild-1", "locals")!;
    expect(app.tournaments.participants(tournament.id)).toHaveLength(0);
    expect(replies[0]).toMatchObject({
      content: "Signups are open for locals (round_robin). Click Join Tournament to enter.",
    });
  });

  it("prevents non-creators from starting or cancelling events", async () => {
    const app = setup();
    const yugi = { id: "user-1", username: "Yugi" };
    const kaiba = { id: "user-2", username: "Kaiba" };

    await handleCommand(
      fakeInteraction({
        commandName: "event",
        subcommand: "create",
        user: yugi,
        strings: { name: "locals", format: "round_robin" },
      }).interaction,
      app,
    );

    await expect(
      handleCommand(
        fakeInteraction({ commandName: "event", subcommand: "start", user: kaiba, strings: { name: "locals" } })
          .interaction,
        app,
      ),
    ).rejects.toThrow("Only the event creator can do that");

    await expect(
      handleCommand(
        fakeInteraction({ commandName: "event", subcommand: "cancel", user: kaiba, strings: { name: "locals" } })
          .interaction,
        app,
      ),
    ).rejects.toThrow("Only the event creator can do that");
  });
});
