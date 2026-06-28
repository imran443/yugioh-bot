import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.fn();
const tempDirs: string[] = [];

vi.mock("@/lib/auth", () => ({ auth }));

async function seedBlankThemeDraft() {
  const tempDir = mkdtempSync(join(tmpdir(), "yugioh-theme-cubes-"));
  const dbPath = join(tempDir, "cubes.sqlite");
  tempDirs.push(tempDir);
  process.env.DATABASE_PATH = dbPath;
  process.env.DISCORD_GUILD_ID = "guild-1";

  const Database = (await import("better-sqlite3")).default;
  const { migrate } = await import("@yugidraft/shared/db");
  const db = new Database(dbPath);
  migrate(db);
  db.prepare("insert into players (guild_id, discord_user_id, display_name) values ('guild-1','u1','P1')").run();
  const config = { mode: "theme", allowedThemeIds: [], themePackSize: 3, cardsPerPlayer: 40, extraDeckEnabled: false, pickSeconds: 45 };
  db.prepare(
    "insert into drafts (guild_id, channel_id, name, status, created_by_user_id, config_json, web_slug, current_wave_number, current_pick_step) values ('guild-1','c','Theme Night','pending','u1',?,?,0,0)",
  ).run(JSON.stringify(config), "theme-slug");
  db.close();
}

describe("POST/DELETE /api/drafts/[slug]/themes (theme cubes)", () => {
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

  it("adds a blank theme cube to the draft and then removes it", async () => {
    await seedBlankThemeDraft();
    const { POST, DELETE } = await import("../app/api/drafts/[slug]/themes/route");

    const addRes = await POST(
      new Request("http://localhost/api/drafts/theme-slug/themes", { method: "POST", body: JSON.stringify({ kind: "blank", name: "Stun" }) }) as any,
      { params: Promise.resolve({ slug: "theme-slug" }) },
    );
    expect(addRes.status).toBe(201);
    const added = await addRes.json();
    expect(added.theme.name).toBe("Stun");
    expect(added.allowedThemeIds).toContain(added.theme.id);

    // config_json reflects the new allowed theme
    const Database = (await import("better-sqlite3")).default;
    const verify = new Database(process.env.DATABASE_PATH!);
    const cfg = JSON.parse((verify.prepare("select config_json from drafts where web_slug='theme-slug'").get() as any).config_json);
    expect(cfg.allowedThemeIds).toContain(added.theme.id);
    verify.close();

    const delRes = await DELETE(
      new Request("http://localhost/api/drafts/theme-slug/themes", { method: "DELETE", body: JSON.stringify({ themeId: added.theme.id }) }) as any,
      { params: Promise.resolve({ slug: "theme-slug" }) },
    );
    expect(delRes.status).toBe(200);
    const removed = await delRes.json();
    expect(removed.allowedThemeIds).not.toContain(added.theme.id);
  }, 30000);

  it("rejects a non-host", async () => {
    await seedBlankThemeDraft();
    auth.mockResolvedValue({ user: { id: "someone-else" } });
    const { POST } = await import("../app/api/drafts/[slug]/themes/route");
    const res = await POST(
      new Request("http://localhost/api/drafts/theme-slug/themes", { method: "POST", body: JSON.stringify({ kind: "blank", name: "X" }) }) as any,
      { params: Promise.resolve({ slug: "theme-slug" }) },
    );
    expect(res.status).toBe(403);
  }, 30000);
});
