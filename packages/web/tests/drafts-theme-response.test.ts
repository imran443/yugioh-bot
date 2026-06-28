import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const tempDirs: string[] = [];

describe("theme draft GET response (buildDraftResponse)", () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => {
    delete process.env.DATABASE_PATH;
    delete process.env.DISCORD_GUILD_ID;
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  it("exposes phase, themeProgress and allowedThemes for an active theme draft", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "yugioh-theme-resp-"));
    const dbPath = join(tempDir, "resp.sqlite");
    tempDirs.push(tempDir);
    process.env.DATABASE_PATH = dbPath;
    process.env.DISCORD_GUILD_ID = "guild-1";

    const Database = (await import("better-sqlite3")).default;
    const { migrate } = await import("@yugidraft/shared/db");
    const { createDraftService, createThemesService, createCardCatalogService } = await import("@yugidraft/shared/services");
    const db = new Database(dbPath);
    migrate(db);

    const themes = createThemesService(db, createCardCatalogService(db, { fetch: async () => ({ ok: true, async json() { return { data: [] }; } }) as Response }));
    const ins = db.prepare("insert into card_catalog (ygoprodeck_id,name,type,frame_type,image_url,image_url_small,card_sets_json,cached_at) values (?,?,?,?,?,?,?,?)");
    let cardId = 1;
    const themeIds: number[] = [];
    for (let t = 0; t < 2; t++) {
      const theme = themes.createBlank("guild-1", `Theme${t}`, "u1");
      for (let i = 0; i < 42; i++) {
        ins.run(cardId, `M${cardId}`, "Normal Monster", "normal", "http://img/" + cardId, "http://img/" + cardId, "[]", "t");
        themes.addCard(theme.id, cardId, "main", 1);
        cardId++;
      }
      themeIds.push(theme.id);
    }

    const p1 = Number(db.prepare("insert into players (guild_id, discord_user_id, display_name) values ('guild-1','u1','P1')").run().lastInsertRowid);
    const p2 = Number(db.prepare("insert into players (guild_id, discord_user_id, display_name) values ('guild-1','u2','P2')").run().lastInsertRowid);

    const drafts = createDraftService(db);
    const draft = drafts.create(
      "guild-1",
      "c",
      "Theme Night",
      { mode: "theme", allowedThemeIds: themeIds, themeSelection: "random", extraDeckEnabled: false, cardsPerPlayer: 40, themePackSize: 3 },
      "u1",
      p1,
    );
    drafts.join(draft.id, p2);
    drafts.start(draft.id);
    db.close();

    const { buildDraftResponse } = await import("../app/api/drafts/[slug]/helpers");
    const res = (await buildDraftResponse(draft.webSlug!, "u1")) as any;

    expect(res.status).toBe("active");
    expect(res.phase).toBe("main");
    expect(res.themeProgress).toMatchObject({ main: 0, mainTotal: 40, extra: 0, extraTotal: 0 });
    expect(res.allowedThemes).toHaveLength(2);
    expect(res.allowedThemes[0].mainCount).toBe(42);
    expect(res.currentPack).toHaveLength(3);
  }, 30000);
});
