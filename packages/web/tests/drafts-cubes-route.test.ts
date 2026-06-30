import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.fn();
const tempDirs: string[] = [];

vi.mock("@/lib/auth", () => ({ auth }));

async function seedBlankThemeDraft() {
  const tempDir = mkdtempSync(join(tmpdir(), "yugioh-draft-cubes-"));
  const dbPath = join(tempDir, "cubes.sqlite");
  tempDirs.push(tempDir);
  process.env.DATABASE_PATH = dbPath;
  process.env.DISCORD_GUILD_ID = "guild-1";

  const Database = (await import("better-sqlite3")).default;
  const { migrate } = await import("@yugidraft/shared/db");
  const db = new Database(dbPath);
  migrate(db);
  db.prepare("insert into players (guild_id, discord_user_id, display_name) values ('guild-1','u1','P1')").run();
  const config = { mode: "theme", allowedCubeIds: [], themePackSize: 3, cardsPerPlayer: 40, extraDeckEnabled: false, pickSeconds: 45 };
  db.prepare(
    "insert into drafts (guild_id, channel_id, name, status, created_by_user_id, config_json, web_slug, current_wave_number, current_pick_step) values ('guild-1','c','Theme Night','pending','u1',?,?,0,0)",
  ).run(JSON.stringify(config), "theme-slug");
  db.close();
}

describe("POST/DELETE /api/drafts/[slug]/cubes (draft cubes)", () => {
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

  it("adds a blank cube to the draft and then removes it", async () => {
    await seedBlankThemeDraft();
    const { POST, DELETE } = await import("../app/api/drafts/[slug]/cubes/route");

    const addRes = await POST(
      new Request("http://localhost/api/drafts/theme-slug/cubes", { method: "POST", body: JSON.stringify({ kind: "blank", name: "Stun" }) }) as any,
      { params: Promise.resolve({ slug: "theme-slug" }) },
    );
    expect(addRes.status).toBe(201);
    const added = await addRes.json();
    expect(added.cube.name).toBe("Stun");
    expect(added.allowedCubeIds).toContain(added.cube.id);

    // config_json reflects the new allowed cube
    const Database = (await import("better-sqlite3")).default;
    const verify = new Database(process.env.DATABASE_PATH!);
    const cfg = JSON.parse((verify.prepare("select config_json from drafts where web_slug='theme-slug'").get() as any).config_json);
    expect(cfg.allowedCubeIds).toContain(added.cube.id);
    verify.close();

    const delRes = await DELETE(
      new Request("http://localhost/api/drafts/theme-slug/cubes", { method: "DELETE", body: JSON.stringify({ cubeId: added.cube.id }) }) as any,
      { params: Promise.resolve({ slug: "theme-slug" }) },
    );
    expect(delRes.status).toBe(200);
    const removed = await delRes.json();
    expect(removed.allowedCubeIds).not.toContain(added.cube.id);
  }, 30000);

  it("attaches an existing library cube and detaching keeps it in the library", async () => {
    await seedBlankThemeDraft();
    const Database = (await import("better-sqlite3")).default;
    const seed = new Database(process.env.DATABASE_PATH!);
    const libCubeId = Number(
      seed.prepare("insert into cubes (guild_id, name, created_by_user_id, created_at, updated_at) values ('guild-1','Goat format','u1','t','t')").run().lastInsertRowid,
    );
    seed.close();

    const { POST, DELETE } = await import("../app/api/drafts/[slug]/cubes/route");

    const attachRes = await POST(
      new Request("http://localhost/api/drafts/theme-slug/cubes", { method: "POST", body: JSON.stringify({ kind: "existing", cubeId: libCubeId }) }) as any,
      { params: Promise.resolve({ slug: "theme-slug" }) },
    );
    expect(attachRes.status).toBe(201);
    const attached = await attachRes.json();
    expect(attached.allowedCubeIds).toContain(libCubeId);

    // Detach — removed from the draft but the cube row survives.
    const detachRes = await DELETE(
      new Request("http://localhost/api/drafts/theme-slug/cubes", { method: "DELETE", body: JSON.stringify({ cubeId: libCubeId }) }) as any,
      { params: Promise.resolve({ slug: "theme-slug" }) },
    );
    expect(detachRes.status).toBe(200);

    const verify = new Database(process.env.DATABASE_PATH!);
    const stillThere = verify.prepare("select id from cubes where id = ?").get(libCubeId);
    const cfg = JSON.parse((verify.prepare("select config_json from drafts where web_slug='theme-slug'").get() as any).config_json);
    verify.close();
    expect(stillThere).toBeTruthy(); // detach kept the library cube
    expect(cfg.allowedCubeIds).not.toContain(libCubeId);
  }, 30000);

  it("rejects a non-host", async () => {
    await seedBlankThemeDraft();
    auth.mockResolvedValue({ user: { id: "someone-else" } });
    const { POST } = await import("../app/api/drafts/[slug]/cubes/route");
    const res = await POST(
      new Request("http://localhost/api/drafts/theme-slug/cubes", { method: "POST", body: JSON.stringify({ kind: "blank", name: "X" }) }) as any,
      { params: Promise.resolve({ slug: "theme-slug" }) },
    );
    expect(res.status).toBe(403);
  }, 30000);
});
