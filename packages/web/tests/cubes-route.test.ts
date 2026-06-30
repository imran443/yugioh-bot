import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.fn();
const tempDirs: string[] = [];

vi.mock("@/lib/auth", () => ({ auth }));

async function setupDb() {
  const tempDir = mkdtempSync(join(tmpdir(), "yugioh-cubes-routes-"));
  const dbPath = join(tempDir, "cubes.sqlite");
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

async function cubeIdOf(name: string): Promise<number> {
  const Database = (await import("better-sqlite3")).default;
  const db = new Database(process.env.DATABASE_PATH!);
  const row = db.prepare("select id from cubes where name = ?").get(name) as { id: number };
  db.close();
  return row.id;
}

describe("cube API routes", () => {
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

  it("creates a blank cube then imports passcodes routed to main/extra", async () => {
    await setupDb();

    const { POST: createCube } = await import("../app/api/cubes/route");
    const created = await createCube(
      new Request("http://x/api/cubes", {
        method: "POST",
        body: JSON.stringify({ kind: "blank", name: "Custom" }),
      }) as any,
    );
    expect(created.status).toBe(201);
    const { cube } = await created.json();

    const { POST: mutate } = await import("../app/api/cubes/[id]/cards/route");
    const res = await mutate(
      new Request("http://x", { method: "POST", body: JSON.stringify({ op: "import", codes: [1, 2] }) }) as any,
      { params: Promise.resolve({ id: String(cube.id) }) },
    );
    const body = await res.json();
    expect(body.pools.main.map((c: any) => c.catalogCardId)).toEqual([1]);
    expect(body.pools.extra.map((c: any) => c.catalogCardId)).toEqual([2]);
  });

  it("lists cubes for the guild", async () => {
    await setupDb();
    const { POST: createCube, GET: listCubes } = await import("../app/api/cubes/route");
    await createCube(
      new Request("http://x", { method: "POST", body: JSON.stringify({ kind: "blank", name: "Stun" }) }) as any,
    );
    const res = await listCubes();
    const body = await res.json();
    expect(body.cubes.map((c: any) => c.name)).toContain("Stun");
  });

  it("saves a config-backed cube (pool) and rejects a duplicate name", async () => {
    await setupDb();
    const { POST: createCube } = await import("../app/api/cubes/route");

    const first = await createCube(
      new Request("http://x/api/cubes", {
        method: "POST",
        body: JSON.stringify({ name: "Goat Cube", config: { setNames: [], customCardIds: [46986414, 83764718] } }),
      }) as any,
    );
    expect(first.status).toBe(201);
    const { cube } = await first.json();
    expect(cube.name).toBe("Goat Cube");
    expect(cube.config.customCardIds).toEqual([46986414, 83764718]);

    const second = await createCube(
      new Request("http://x/api/cubes", {
        method: "POST",
        body: JSON.stringify({ name: "Goat Cube", config: { setNames: [], customCardIds: [99999999] } }),
      }) as any,
    );
    expect(second.status).toBe(409);
    await expect(second.json()).resolves.toMatchObject({ error: 'A cube named "Goat Cube" already exists' });
  });

  it("creates an empty config-backed cube when the title is unique", async () => {
    await setupDb();
    const { POST: createCube } = await import("../app/api/cubes/route");
    const res = await createCube(
      new Request("http://x/api/cubes", {
        method: "POST",
        body: JSON.stringify({ name: "Empty Cube", config: { setNames: [], customCardIds: [] } }),
      }) as any,
    );
    expect(res.status).toBe(201);
    const { cube } = await res.json();
    expect(cube.name).toBe("Empty Cube");
    expect(cube.config.customCardIds).toEqual([]);
  });

  it("PUT renames a cube and 409s on a name collision", async () => {
    await setupDb();
    const { POST: createCube } = await import("../app/api/cubes/route");
    await createCube(new Request("http://x", { method: "POST", body: JSON.stringify({ kind: "blank", name: "Alpha" }) }) as any);
    await createCube(new Request("http://x", { method: "POST", body: JSON.stringify({ kind: "blank", name: "Beta" }) }) as any);
    const id = await cubeIdOf("Alpha");

    const { PUT } = await import("../app/api/cubes/[id]/route");
    const renamed = await PUT(
      new Request(`http://x/api/cubes/${id}`, { method: "PUT", body: JSON.stringify({ name: "Alpha Prime" }) }) as any,
      { params: Promise.resolve({ id: String(id) }) },
    );
    expect(renamed.status).toBe(200);
    expect(await cubeIdOf("Alpha Prime")).toBe(id);

    const collide = await PUT(
      new Request(`http://x/api/cubes/${id}`, { method: "PUT", body: JSON.stringify({ name: "Beta" }) }) as any,
      { params: Promise.resolve({ id: String(id) }) },
    );
    expect(collide.status).toBe(409);
  });

  it("DELETE removes a cube; 404 on already-gone", async () => {
    await setupDb();
    const { POST: createCube } = await import("../app/api/cubes/route");
    await createCube(new Request("http://x", { method: "POST", body: JSON.stringify({ kind: "blank", name: "Doomed" }) }) as any);
    const id = await cubeIdOf("Doomed");

    const { DELETE } = await import("../app/api/cubes/[id]/route");
    const ok = await DELETE(new Request(`http://x/api/cubes/${id}`, { method: "DELETE" }) as any, { params: Promise.resolve({ id: String(id) }) });
    expect(ok.status).toBe(200);
    const gone = await DELETE(new Request(`http://x/api/cubes/${id}`, { method: "DELETE" }) as any, { params: Promise.resolve({ id: String(id) }) });
    expect(gone.status).toBe(404);
  });
});
