import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.fn();
const tempDirs: string[] = [];

vi.mock("@/lib/auth", () => ({
  auth,
}));

describe("/api/draft-templates", () => {
  beforeEach(() => {
    vi.resetModules();
    auth.mockReset();
    auth.mockResolvedValue({ user: { id: "creator-user", name: "Yugi" } });
  });

  afterEach(() => {
    delete process.env.DATABASE_PATH;
    delete process.env.DISCORD_GUILD_ID;

    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it("saves and lists templates with custom card ids", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "yugioh-draft-templates-route-"));
    const dbPath = join(tempDir, "draft-templates-route.sqlite");
    tempDirs.push(tempDir);

    process.env.DATABASE_PATH = dbPath;
    process.env.DISCORD_GUILD_ID = "guild-1";

    const Database = (await import("better-sqlite3")).default;
    const { migrate } = await import("@yugidraft/shared/db");
    const db = new Database(dbPath);
    migrate(db);
    db.close();

    const { GET, POST } = await import("../app/api/draft-templates/route");
    const saveRequest = new Request("http://localhost/api/draft-templates", {
      method: "POST",
      body: JSON.stringify({
        name: "Goat Cube",
        config: { setNames: [], customCardIds: [46986414, 83764718], packSize: 8 },
      }),
    }) as NextRequest;
    const saveResponse = await POST(saveRequest);

    expect(saveResponse.status).toBe(201);

    const listResponse = await GET();
    expect(listResponse.status).toBe(200);
    await expect(listResponse.json()).resolves.toMatchObject({
      templates: [
        {
          name: "Goat Cube",
          config: { customCardIds: [46986414, 83764718] },
          setNames: [],
          customCardIds: [46986414, 83764718],
        },
      ],
    });

    // Verify pool-only storage: extra numeric config fields are stripped
    const SqliteDb = (await import("better-sqlite3")).default;
    const verifyDb = new SqliteDb(process.env.DATABASE_PATH!);
    const row = verifyDb.prepare("select config_json from draft_templates where name = 'Goat Cube'").get() as { config_json: string };
    verifyDb.close();
    const stored = JSON.parse(row.config_json) as Record<string, unknown>;
    expect(stored).not.toHaveProperty("packSize");
    expect(stored).toHaveProperty("customCardIds");
  });
});
