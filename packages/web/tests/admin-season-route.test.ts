import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.fn();
const tempDirs: string[] = [];
vi.mock("@/lib/auth", () => ({ auth }));

async function seed() {
  const tempDir = mkdtempSync(join(tmpdir(), "yugioh-admin-season-"));
  const dbPath = join(tempDir, "test.sqlite");
  tempDirs.push(tempDir);
  process.env.DATABASE_PATH = dbPath;
  process.env.DISCORD_GUILD_ID = "guild-1";
  const Database = (await import("better-sqlite3")).default;
  const { migrate } = await import("@yugidraft/shared/db");
  const db = new Database(dbPath);
  migrate(db);
  db.close();
}

describe("POST /api/admin/season", () => {
  beforeEach(() => { vi.resetModules(); auth.mockReset(); auth.mockResolvedValue({ user: { id: "u1", name: "Admin" } }); });
  afterEach(() => {
    delete process.env.DATABASE_PATH; delete process.env.DISCORD_GUILD_ID;
    while (tempDirs.length) { const d = tempDirs.pop(); if (d) rmSync(d, { recursive: true, force: true }); }
  });

  it("401 when unauthenticated", async () => {
    await seed();
    auth.mockResolvedValue(null);
    const { POST } = await import("../app/api/admin/season/route");
    const res = await POST(new Request("http://x/api/admin/season", {
      method: "POST", body: JSON.stringify({ action: "start" }),
    }));
    expect(res.status).toBe(401);
  });

  it("start then end manages the active season", async () => {
    await seed();
    const { POST } = await import("../app/api/admin/season/route");
    const startRes = await POST(new Request("http://x/api/admin/season", {
      method: "POST", body: JSON.stringify({ action: "start" }),
    }));
    expect((await startRes.json()).season.number).toBeGreaterThanOrEqual(1);

    const endRes = await POST(new Request("http://x/api/admin/season", {
      method: "POST", body: JSON.stringify({ action: "end" }),
    }));
    expect((await endRes.json()).season.status).toBe("ended");
  });
});
