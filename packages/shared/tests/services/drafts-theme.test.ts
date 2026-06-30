import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { migrate } from "../../src/db/index.js";
import { createDraftService } from "../../src/services/drafts.js";
import { createThemesService } from "../../src/services/themes.js";
import { createCardCatalogService } from "../../src/services/card-catalog.js";
import { createDraftTournamentService } from "../../src/services/draft-tournament.js";
import type { DraftConfig } from "../../src/types/index.js";

function emptyCatalog(db: Database.Database) {
  return createCardCatalogService(db, {
    fetch: async () => ({ ok: true, async json() { return { data: [] }; } }) as Response,
  });
}

function insertPlayer(db: Database.Database, guildId: string, discordUserId: string, displayName: string) {
  const result = db
    .prepare("insert into players (guild_id, discord_user_id, display_name) values (?, ?, ?)")
    .run(guildId, discordUserId, displayName);
  return Number(result.lastInsertRowid);
}

let catalogId = 1;
function seedThemeCards(
  db: Database.Database,
  themes: ReturnType<typeof createThemesService>,
  guildId: string,
  name: string,
  mainCount: number,
  extraCount: number,
) {
  const theme = themes.createBlank(guildId, name, "host");
  const insCard = db.prepare(
    `insert into card_catalog (ygoprodeck_id,name,type,frame_type,image_url,image_url_small,card_sets_json,cached_at)
     values (?,?,?,?,?,?,?,?)`,
  );
  for (let i = 0; i < mainCount; i++) {
    const id = catalogId++;
    insCard.run(id, `M${id}`, "Normal Monster", "normal", "i", "i", "[]", "t");
    themes.addCard(theme.id, id, "main", 1);
  }
  for (let i = 0; i < extraCount; i++) {
    const id = catalogId++;
    insCard.run(id, `X${id}`, "XYZ Monster", "xyz", "i", "i", "[]", "t");
    themes.addCard(theme.id, id, "extra", 1);
  }
  return theme.id;
}

/** Build a started-ready theme draft: creates themes, players, the draft, joins everyone. */
function makeThemeDraft(opts: {
  players?: number;
  config: Partial<DraftConfig>;
  themes: Array<{ main: number; extra: number }>;
  /** Theme index assigned to each player (forces host_assigned selection). */
  assign?: number[];
}) {
  const db = new Database(":memory:");
  migrate(db);
  const drafts = createDraftService(db);
  const themesService = createThemesService(db, emptyCatalog(db));
  const guildId = "g";

  const themeIds = opts.themes.map((t, i) => seedThemeCards(db, themesService, guildId, `Theme${i}`, t.main, t.extra));
  const playerCount = opts.players ?? 2;
  const playerIds: number[] = [];
  for (let i = 0; i < playerCount; i++) {
    playerIds.push(insertPlayer(db, guildId, `u${i}`, `P${i}`));
  }

  const config: DraftConfig = { mode: "theme", allowedCubeIds: themeIds, ...opts.config };
  if (opts.assign) {
    config.themeSelection = "host_assigned";
    config.themeAssignments = Object.fromEntries(
      opts.assign.map((themeIndex, playerIndex) => [String(playerIds[playerIndex]), themeIds[themeIndex]]),
    );
  }
  const draft = drafts.create(guildId, "c", "theme night", config, "host", playerIds[0]);
  for (let i = 1; i < playerIds.length; i++) {
    drafts.join(draft.id, playerIds[i]);
  }

  return { db, drafts, themesService, draftId: draft.id, playerIds, themeIds };
}

/** Drive a started theme draft to completion, picking the first option for whoever has one. */
function runToCompletion(
  drafts: ReturnType<typeof createDraftService>,
  draftId: number,
  playerIds: number[],
  maxRounds = 60,
) {
  for (let r = 1; r <= maxRounds && drafts.findById(draftId).status === "active"; r++) {
    for (const pid of playerIds) {
      const opts = drafts.currentPackOptions(draftId, pid);
      if (opts.length > 0) drafts.pickCard(draftId, pid, opts[0].id, "manual");
    }
  }
}

describe("theme draft — config normalization", () => {
  it("normalizes theme-mode defaults", () => {
    const { drafts, draftId } = makeThemeDraft({ config: {}, themes: [{ main: 1, extra: 1 }, { main: 1, extra: 1 }] });
    const draft = drafts.findById(draftId);
    expect(draft.config.themePackSize).toBe(3);
    expect(draft.config.extraDeckEnabled).toBe(true);
    expect(draft.config.extraDeckSize).toBe(15);
    expect(draft.config.burnUnpicked).toBe(false);
    expect(draft.config.themeSelection).toBe("player_pick");
    expect(draft.config.uniqueThemes).toBe(true);
  });

  it("leaves booster config untouched (no theme keys leak in)", () => {
    const db = new Database(":memory:");
    migrate(db);
    const drafts = createDraftService(db);
    const yugi = insertPlayer(db, "g", "u", "Yugi");
    const draft = drafts.create("g", "c", "cube night", { setNames: ["X"] }, "host", yugi);
    expect(draft.config.themePackSize).toBeUndefined();
    expect(draft.config.mode).toBeUndefined();
  });
});

describe("theme draft — start & assignment", () => {
  it("starts a theme draft, assigns distinct themes (random), and opens round 1", () => {
    const { db, drafts, draftId, playerIds } = makeThemeDraft({
      config: { themeSelection: "random", extraDeckEnabled: false },
      themes: [{ main: 60, extra: 0 }, { main: 60, extra: 0 }],
    });
    const started = drafts.start(draftId);
    expect(started.status).toBe("active");
    expect(started.currentPackRound).toBe(1);
    const assigned = db.prepare("select theme_id from draft_player_theme where draft_id = ?").all(draftId) as Array<{ theme_id: number }>;
    expect(new Set(assigned.map((r) => r.theme_id)).size).toBe(2); // distinct
    expect(drafts.currentPackOptions(draftId, playerIds[0])).toHaveLength(3);
  });

  it("blocks start when uniqueThemes and not enough themes for players", () => {
    const { drafts, draftId } = makeThemeDraft({
      players: 2,
      config: { themeSelection: "random", uniqueThemes: true },
      themes: [{ main: 60, extra: 0 }],
    });
    expect(() => drafts.start(draftId)).toThrow();
  });

  it("blocks start when a main pool is too small", () => {
    const { drafts, draftId } = makeThemeDraft({
      config: { themeSelection: "random", extraDeckEnabled: false },
      themes: [{ main: 5, extra: 0 }, { main: 60, extra: 0 }],
    });
    expect(() => drafts.start(draftId)).toThrow(/main/i);
  });
});

describe("theme draft — full draft completion", () => {
  it("runs a full main-only theme draft to completion (2 players)", () => {
    const { drafts, draftId, playerIds } = makeThemeDraft({
      config: { extraDeckEnabled: false, cardsPerPlayer: 40, themePackSize: 3, themeSelection: "random" },
      themes: [{ main: 60, extra: 0 }, { main: 60, extra: 0 }],
    });
    drafts.start(draftId);
    runToCompletion(drafts, draftId, playerIds);
    expect(drafts.findById(draftId).status).toBe("completed");
    expect(drafts.pool(draftId, playerIds[0])).toHaveLength(40);
  });

  it("runs a main + extra theme draft to completion (does not reject extra picks)", () => {
    const { drafts, draftId, playerIds } = makeThemeDraft({
      config: { extraDeckEnabled: true, cardsPerPlayer: 40, extraDeckSize: 15, themePackSize: 3, themeSelection: "random" },
      themes: [{ main: 60, extra: 25 }, { main: 60, extra: 25 }],
    });
    drafts.start(draftId);
    runToCompletion(drafts, draftId, playerIds);
    expect(drafts.findById(draftId).status).toBe("completed");
    expect(drafts.pool(draftId, playerIds[0])).toHaveLength(55);
  });

  it("respects themePackSize != 3", () => {
    const { drafts, draftId, playerIds } = makeThemeDraft({
      config: { themePackSize: 5, extraDeckEnabled: false, themeSelection: "random" },
      themes: [{ main: 60, extra: 0 }, { main: 60, extra: 0 }],
    });
    drafts.start(draftId);
    expect(drafts.currentPackOptions(draftId, playerIds[0])).toHaveLength(5);
  });

  it("returns unpicked cards to the pool when burnUnpicked is false (small pool still completes)", () => {
    const { drafts, draftId, playerIds } = makeThemeDraft({
      config: { burnUnpicked: false, cardsPerPlayer: 40, extraDeckEnabled: false, themePackSize: 3, themeSelection: "random" },
      themes: [{ main: 42, extra: 0 }, { main: 42, extra: 0 }],
    });
    drafts.start(draftId);
    runToCompletion(drafts, draftId, playerIds);
    expect(drafts.findById(draftId).status).toBe("completed");
  });

  it("completes when one player's Extra pool runs dry mid-phase (thin-Extra warning path)", () => {
    const { drafts, draftId, playerIds } = makeThemeDraft({
      config: { extraDeckEnabled: true, cardsPerPlayer: 40, extraDeckSize: 15, themePackSize: 3, burnUnpicked: false },
      themes: [{ main: 60, extra: 25 }, { main: 60, extra: 2 }],
      assign: [0, 1], // p0 full extra, p1 thin extra
    });
    drafts.start(draftId);
    runToCompletion(drafts, draftId, playerIds);
    expect(drafts.findById(draftId).status).toBe("completed");
    expect(drafts.pool(draftId, playerIds[0])).toHaveLength(55);
    const p1 = drafts.pool(draftId, playerIds[1]).length;
    expect(p1).toBeLessThan(55);
    expect(p1).toBeGreaterThanOrEqual(42); // 40 main + the 2 extra it had
  });

  it("completes when ALL themes are thin-Extra (several extra rounds open empty)", () => {
    const { drafts, draftId, playerIds } = makeThemeDraft({
      config: { extraDeckEnabled: true, cardsPerPlayer: 40, extraDeckSize: 15, themePackSize: 3, burnUnpicked: false },
      themes: [{ main: 60, extra: 1 }, { main: 60, extra: 1 }],
      assign: [0, 1],
    });
    drafts.start(draftId);
    runToCompletion(drafts, draftId, playerIds);
    expect(drafts.findById(draftId).status).toBe("completed");
  });
});

describe("theme draft — tournament hand-off", () => {
  it("creates a tournament from a completed theme draft", () => {
    const { db, drafts, draftId, playerIds } = makeThemeDraft({
      config: { extraDeckEnabled: false, cardsPerPlayer: 40, themePackSize: 3, themeSelection: "random" },
      themes: [{ main: 60, extra: 0 }, { main: 60, extra: 0 }],
    });
    drafts.start(draftId);
    runToCompletion(drafts, draftId, playerIds);
    expect(drafts.findById(draftId).status).toBe("completed");

    const tourneys = createDraftTournamentService(db);
    const result = tourneys.createTournamentFromDraft({ draftId, format: "round_robin", createdByUserId: "host" });
    expect(result).toBeTruthy();
    const row = db.prepare("select count(*) as n from tournaments where guild_id = 'g'").get() as { n: number };
    expect(row.n).toBe(1);
  });
});

describe("theme draft — bot auto-pick", () => {
  it("expireCurrentPickStep auto-picks pending players in theme mode", () => {
    const { drafts, draftId, playerIds } = makeThemeDraft({
      config: { pickSeconds: 1, extraDeckEnabled: false, themeSelection: "random" },
      themes: [{ main: 60, extra: 0 }, { main: 60, extra: 0 }],
    });
    drafts.start(draftId);
    const past = new Date(Date.now() + 5000);
    const { autoPickedPlayerIds } = drafts.expireCurrentPickStep(draftId, past);
    expect(autoPickedPlayerIds.length).toBe(2);
    expect(drafts.findById(draftId).currentPackRound).toBe(2); // advanced after all auto-picked
  });
});
