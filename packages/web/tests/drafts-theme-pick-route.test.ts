import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.fn();
const tempDirs: string[] = [];

vi.mock("@/lib/auth", () => ({ auth }));
vi.mock("@/lib/notify", () => ({ broadcaster: { draft: vi.fn() } }));

describe("POST /api/drafts/[slug]/pick (theme mode bots)", () => {
  beforeEach(() => {
    vi.resetModules();
    auth.mockReset();
    auth.mockResolvedValue({ user: { id: "u1", name: "P1" } });
  });
  afterEach(() => {
    delete process.env.DATABASE_PATH;
    delete process.env.DISCORD_GUILD_ID;
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  it("auto-picks a dev bot after the human's pick and advances the round", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "yugioh-theme-pick-"));
    const dbPath = join(tempDir, "pick.sqlite");
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
        ins.run(cardId, `M${cardId}`, "Normal Monster", "normal", "i", "i", "[]", "t");
        themes.addCard(theme.id, cardId, "main", 1);
        cardId++;
      }
      themeIds.push(theme.id);
    }

    const human = Number(db.prepare("insert into players (guild_id, discord_user_id, display_name) values ('guild-1','u1','P1')").run().lastInsertRowid);
    const bot = Number(db.prepare("insert into players (guild_id, discord_user_id, display_name) values ('guild-1','bot_player_dev_1','Bot 1')").run().lastInsertRowid);

    const drafts = createDraftService(db);
    const draft = drafts.create(
      "guild-1",
      "c",
      "Theme Night",
      { mode: "theme", allowedThemeIds: themeIds, themeSelection: "random", extraDeckEnabled: false, cardsPerPlayer: 40, themePackSize: 3 },
      "u1",
      human,
    );
    drafts.join(draft.id, bot);
    drafts.start(draft.id);

    const firstOption = drafts.currentPackOptions(draft.id, human)[0];
    db.close();

    const { POST } = await import("../app/api/drafts/[slug]/pick/route");
    const res = await POST(
      new Request("http://localhost/api/drafts/" + draft.webSlug + "/pick", {
        method: "POST",
        body: JSON.stringify({ cardId: firstOption.id }),
      }) as NextRequest,
      { params: Promise.resolve({ slug: draft.webSlug! }) },
    );
    expect(res.status).toBe(200);
    const body = await res.json();

    // Both players picked round 1 -> advanced to round 2.
    expect(body.packRound).toBe(2);

    // The bot recorded a pick for round 1.
    const verify = new Database(dbPath);
    const botPicks = verify.prepare("select count(*) as n from draft_picks where draft_id = ? and player_id = ? and wave_number = 1").get(draft.id, bot) as { n: number };
    expect(botPicks.n).toBe(1);
    verify.close();
  }, 30000);
});
