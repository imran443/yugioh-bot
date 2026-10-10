import { fixtureUserId, fixtureDiscordId, seedFixtureUsers } from "./fixtures/identity";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.fn();
const broadcaster = { draft: vi.fn() };
const tempDirs: string[] = [];

vi.mock("@/lib/session-identity", async () => {
  const { sessionFixture } = await import("./fixtures/session");
  return sessionFixture(auth);
});
vi.mock("@/lib/notify", () => ({ broadcaster }));

describe("POST /api/drafts/[slug]/pick (theme mode bots)", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("THEME_DRAFTS", "0");
    auth.mockReset();
    broadcaster.draft.mockReset();
    auth.mockResolvedValue({ user: { id: String(fixtureUserId("u1")), discordUserId: fixtureDiscordId("u1"), name: "P1" } });
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    delete process.env.DATABASE_PATH;
    delete process.env.DISCORD_GUILD_ID;
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps an existing theme draft picking, finishing, showing its summary and exporting when off", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "yugioh-theme-pick-"));
    const dbPath = join(tempDir, "pick.sqlite");
    tempDirs.push(tempDir);
    process.env.DATABASE_PATH = dbPath;
    process.env.DISCORD_GUILD_ID = "guild-1";

    const Database = (await import("better-sqlite3")).default;
    const { migrate } = await import("@yugidraft/shared/db");
    const { createDraftService, createCubeService, createCardCatalogService } = await import("@yugidraft/shared/services");
    const db = new Database(dbPath);
    migrate(db);
    seedFixtureUsers(db, FIXTURE_KEYS);

    const cubes = createCubeService(db, createCardCatalogService(db, { fetch: async () => ({ ok: true, async json() { return { data: [] }; } }) as Response }));
    const ins = db.prepare("insert into card_catalog (ygoprodeck_id,name,type,frame_type,image_url,image_url_small,card_sets_json,cached_at) values (?,?,?,?,?,?,?,?)");
    let cardId = 1;
    const cubeIds: number[] = [];
    for (let t = 0; t < 2; t++) {
      const cube = cubes.createBlank("guild-1", `Theme${t}`, fixtureUserId("u1"));
      for (let i = 0; i < 42; i++) {
        ins.run(cardId, `M${cardId}`, "Normal Monster", "normal", "i", "i", "[]", "t");
        cubes.addCard(cube.id, cardId, "main", 1);
        cardId++;
      }
      cubeIds.push(cube.id);
    }

    const human = Number(db.prepare(`insert into players (guild_id, user_id, discord_user_id, display_name) values ('guild-1', ${fixtureUserId("u1")}, '${fixtureDiscordId("u1")}', 'P1')`).run().lastInsertRowid);
    const bot = Number(db.prepare(`insert into players (guild_id, user_id, discord_user_id, display_name) values ('guild-1', ${fixtureUserId("bot_player_dev_1")}, 'bot_player_dev_1', 'Bot 1')`).run().lastInsertRowid);

    const drafts = createDraftService(db);
    const draft = drafts.create(
      "guild-1",
      "c",
      "Theme Night",
      { mode: "theme", allowedCubeIds: cubeIds, themeSelection: "random", extraDeckEnabled: false, cardsPerPlayer: 40, themePackSize: 3 },
      fixtureUserId("u1"),
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
    expect(body.phase).toBe("main");
    expect(broadcaster.draft.mock.calls).toStrictEqual([
      [{ kind: "pick", slug: draft.webSlug, playerId: human, packRound: 1, pickStep: 1 }],
      [{ kind: "resync", slug: draft.webSlug, packRound: 2, pickStep: 1 }],
    ]);

    // The bot recorded a pick for round 1.
    const verify = new Database(dbPath);
    const botPicks = verify.prepare("select count(*) as n from draft_picks where draft_id = ? and player_id = ? and wave_number = 1").get(draft.id, bot) as { n: number };
    expect(botPicks.n).toBe(1);
    const continued = createDraftService(verify);
    for (let round = 2; round <= 40; round += 1) {
      const option = continued.currentPackOptions(draft.id, human)[0];
      expect(option).toBeDefined();
      const response = await POST(new Request("http://localhost/pick", {
        method: "POST", body: JSON.stringify({ cardId: option.id }),
      }) as NextRequest, { params: Promise.resolve({ slug: draft.webSlug! }) });
      expect(response.status).toBe(200);
    }
    expect(continued.findById(draft.id).status).toBe("completed");
    expect(verify.prepare("select count(*) as n from draft_picks where draft_id = ?").get(draft.id)).toEqual({ n: 80 });
    const context = { params: Promise.resolve({ slug: draft.webSlug! }) };
    const { GET: summary } = await import("../app/api/drafts/[slug]/route");
    const summaryResponse = await summary(new Request("http://localhost/summary"), context);
    expect(summaryResponse.status).toBe(200);
    expect((await summaryResponse.json()).status).toBe("completed");
    const { GET: exportDeck } = await import("../app/api/drafts/[slug]/export/route");
    const exported = await exportDeck(new Request("http://localhost/export"), context);
    expect(exported.status).toBe(200);
    const ydk = await exported.text();
    expect(ydk).toContain("#main");
    expect(ydk).toContain("#extra");
    expect(ydk.split("#main\n")[1].split("#extra")[0].trim().split("\n")).toHaveLength(40);
    verify.close();
  }, 30000);
});

const FIXTURE_KEYS = ["u1", "bot_player_dev_1"] as const;

// Session resolution is mocked; authorization still runs through the real web boundary.
