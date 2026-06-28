import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { migrate } from "../../src/db/index.js";
import { createDraftService } from "../../src/services/drafts.js";
import { createThemesService } from "../../src/services/themes.js";
import { createCardCatalogService } from "../../src/services/card-catalog.js";
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

  const config: DraftConfig = { mode: "theme", allowedThemeIds: themeIds, ...opts.config };
  const draft = drafts.create(guildId, "c", "theme night", config, "host", playerIds[0]);
  for (let i = 1; i < playerIds.length; i++) {
    drafts.join(draft.id, playerIds[i]);
  }

  return { db, drafts, themesService, draftId: draft.id, playerIds, themeIds };
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
