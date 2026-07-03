import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.fn();
const tempDirs: string[] = [];

vi.mock("@/lib/auth", () => ({ auth }));

type SeedCube = { main: number; extra: number };

async function seedDraft(cubes: SeedCube[], configOverrides: Record<string, unknown> = {}) {
  const tempDir = mkdtempSync(join(tmpdir(), "yugioh-theme-lobby-"));
  const dbPath = join(tempDir, "lobby.sqlite");
  tempDirs.push(tempDir);
  process.env.DATABASE_PATH = dbPath;
  process.env.DISCORD_GUILD_ID = "guild-1";

  const Database = (await import("better-sqlite3")).default;
  const { migrate } = await import("@yugidraft/shared/db");
  const db = new Database(dbPath);
  migrate(db);

  const p1 = Number(db.prepare("insert into players (guild_id, discord_user_id, display_name) values ('guild-1','u1','P1')").run().lastInsertRowid);
  const p2 = Number(db.prepare("insert into players (guild_id, discord_user_id, display_name) values ('guild-1','u2','P2')").run().lastInsertRowid);

  const insCard = db.prepare(
    "insert into card_catalog (ygoprodeck_id,name,type,frame_type,image_url,image_url_small,card_sets_json,cached_at) values (?,?,?,?,?,?,?,?)",
  );
  let cardId = 1;
  const cubeIds: number[] = [];
  for (const t of cubes) {
    const cubeId = Number(db.prepare("insert into cubes (guild_id, name, created_by_user_id, created_at, updated_at) values ('guild-1', ?, 'u', 't', 't')").run(`Theme${cubeIds.length}`).lastInsertRowid);
    for (let i = 0; i < t.main; i++) {
      insCard.run(cardId, `M${cardId}`, "Normal Monster", "normal", "i", "i", "[]", "t");
      db.prepare("insert into cube_cards (cube_id, catalog_card_id, pool, max_copies) values (?, ?, 'main', 1)").run(cubeId, cardId);
      cardId++;
    }
    for (let i = 0; i < t.extra; i++) {
      insCard.run(cardId, `X${cardId}`, "XYZ Monster", "xyz", "i", "i", "[]", "t");
      db.prepare("insert into cube_cards (cube_id, catalog_card_id, pool, max_copies) values (?, ?, 'extra', 1)").run(cubeId, cardId);
      cardId++;
    }
    cubeIds.push(cubeId);
  }

  const config = {
    mode: "theme",
    allowedCubeIds: cubeIds,
    themeSelection: "player_pick",
    uniqueThemes: true,
    themePackSize: 3,
    cardsPerPlayer: 40,
    extraDeckEnabled: true,
    extraDeckSize: 15,
    burnUnpicked: false,
    pickSeconds: 45,
    ...configOverrides,
  };
  const draftId = Number(
    db
      .prepare(
        "insert into drafts (guild_id, channel_id, name, status, created_by_user_id, config_json, web_slug, current_wave_number, current_pick_step) values ('guild-1','c','Theme Night','pending','u1',?,?,0,0)",
      )
      .run(JSON.stringify(config), "theme-slug").lastInsertRowid,
  );
  db.prepare("insert into draft_players (draft_id, player_id) values (?, ?)").run(draftId, p1);
  db.prepare("insert into draft_players (draft_id, player_id) values (?, ?)").run(draftId, p2);
  db.close();

  return { cubeIds, p1, p2 };
}

describe("theme lobby routes", () => {
  beforeEach(() => {
    vi.resetModules();
    auth.mockReset();
  });
  afterEach(() => {
    delete process.env.DATABASE_PATH;
    delete process.env.DISCORD_GUILD_ID;
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  it("claims a cube and rejects a second claim of the same cube (uniqueThemes)", async () => {
    const { cubeIds } = await seedDraft([{ main: 42, extra: 0 }, { main: 42, extra: 0 }]);
    const { POST } = await import("../app/api/drafts/[slug]/claim-cube/route");

    auth.mockResolvedValue({ user: { id: "u1", name: "P1" } });
    const res1 = await POST(new Request("http://localhost/api/drafts/theme-slug/claim-cube", { method: "POST", body: JSON.stringify({ cubeId: cubeIds[0] }) }) as any, { params: Promise.resolve({ slug: "theme-slug" }) });
    expect(res1.status).toBe(200);

    auth.mockResolvedValue({ user: { id: "u2", name: "P2" } });
    const res2 = await POST(new Request("http://localhost/api/drafts/theme-slug/claim-cube", { method: "POST", body: JSON.stringify({ cubeId: cubeIds[0] }) }) as any, { params: Promise.resolve({ slug: "theme-slug" }) });
    expect(res2.status).toBe(409);
  }, 30000);

  it("preflight reports an error for a main-short cube and a warning for a thin-extra cube", async () => {
    await seedDraft([{ main: 5, extra: 0 }, { main: 42, extra: 0 }]);
    auth.mockResolvedValue({ user: { id: "u1", name: "P1" } });
    const { GET } = await import("../app/api/drafts/[slug]/preflight/route");
    const res = await GET(new Request("http://x") as any, { params: Promise.resolve({ slug: "theme-slug" }) });
    const body = await res.json();
    expect(body.errors.length).toBeGreaterThan(0); // Theme0 main-short
    expect(body.errors.some((e: string) => /main/i.test(e))).toBe(true);
    expect(body.warnings.length).toBeGreaterThan(0); // Theme1 has 0 extra but extra enabled
  }, 30000);
});
