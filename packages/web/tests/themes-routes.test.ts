import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.fn();
const tempDirs: string[] = [];

vi.mock("@/lib/auth", () => ({ auth }));

async function setupDb() {
  const tempDir = mkdtempSync(join(tmpdir(), "yugioh-themes-routes-"));
  const dbPath = join(tempDir, "themes.sqlite");
  tempDirs.push(tempDir);
  process.env.DATABASE_PATH = dbPath;
  process.env.DISCORD_GUILD_ID = "guild-1";

  const Database = (await import("better-sqlite3")).default;
  const { migrate } = await import("@yugidraft/shared/db");
  const db = new Database(dbPath);
  migrate(db);
  const ins = db.prepare(
    `insert into card_catalog (ygoprodeck_id,name,type,frame_type,image_url,image_url_small,card_sets_json,cached_at)
     values (?,?,?,?,?,?,?,?)`,
  );
  ins.run(1, "Main A", "Normal Monster", "normal", "i", "i", "[]", "t");
  ins.run(2, "Xyz B", "XYZ Monster", "xyz", "i", "i", "[]", "t");
  db.close();
}

describe("theme API routes", () => {
  beforeEach(() => {
    vi.resetModules();
    auth.mockReset();
    auth.mockResolvedValue({ user: { id: "creator", name: "Yugi" } });
  });

  afterEach(() => {
    delete process.env.DATABASE_PATH;
    delete process.env.DISCORD_GUILD_ID;
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  it("creates a blank theme then imports passcodes routed to main/extra", async () => {
    await setupDb();

    const { POST: createTheme } = await import("../app/api/themes/route");
    const created = await createTheme(
      new Request("http://x/api/themes", {
        method: "POST",
        body: JSON.stringify({ kind: "blank", name: "Custom" }),
      }) as any,
    );
    expect(created.status).toBe(201);
    const { theme } = await created.json();

    const { POST: mutate } = await import("../app/api/themes/[id]/cards/route");
    const res = await mutate(
      new Request("http://x", { method: "POST", body: JSON.stringify({ op: "import", codes: [1, 2] }) }) as any,
      { params: Promise.resolve({ id: String(theme.id) }) },
    );
    const body = await res.json();
    expect(body.pools.main.map((c: any) => c.catalogCardId)).toEqual([1]);
    expect(body.pools.extra.map((c: any) => c.catalogCardId)).toEqual([2]);
  });

  it("lists themes for the guild", async () => {
    await setupDb();
    const { POST: createTheme, GET: listThemes } = await import("../app/api/themes/route");
    await createTheme(
      new Request("http://x", { method: "POST", body: JSON.stringify({ kind: "blank", name: "Stun" }) }) as any,
    );
    const res = await listThemes();
    const body = await res.json();
    expect(body.themes.map((t: any) => t.name)).toContain("Stun");
  });
});
