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

describe("POST /api/drafts", () => {
  beforeEach(() => {
    vi.resetModules();
    auth.mockReset();
    auth.mockResolvedValue({ user: { id: "creator-user", name: "Yugi" } });
  });

  afterEach(() => {
    delete process.env.DATABASE_PATH;
    delete process.env.DISCORD_GUILD_ID;
    delete process.env.DISCORD_DEFAULT_CHANNEL_ID;

    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it("creates a draft from custom card ids without selected sets", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "yugioh-drafts-create-route-"));
    const dbPath = join(tempDir, "drafts-create-route.sqlite");
    tempDirs.push(tempDir);

    process.env.DATABASE_PATH = dbPath;
    process.env.DISCORD_GUILD_ID = "guild-1";
    process.env.DISCORD_DEFAULT_CHANNEL_ID = "channel-1";

    const Database = (await import("better-sqlite3")).default;
    const { migrate } = await import("@yugidraft/shared/db");
    const db = new Database(dbPath);
    migrate(db);
    db.close();

    const { POST } = await import("../app/api/drafts/route");
    const request = new Request("http://localhost/api/drafts", {
      method: "POST",
      body: JSON.stringify({
        name: "Custom Pool Draft",
        config: { setNames: [], customCardIds: [46986414, 83764718], packSize: 8, packsPerPlayer: 5 },
      }),
    }) as NextRequest;
    const response = await POST(request);

    expect(response.status).toBe(201);

    const verifyDb = new Database(dbPath);
    const row = verifyDb.prepare("select config_json from drafts where name = ?").get("Custom Pool Draft") as {
      config_json: string;
    };
    expect(JSON.parse(row.config_json).customCardIds).toEqual([46986414, 83764718]);
    verifyDb.close();
  });
});
