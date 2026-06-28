import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.fn();
const tempDirs: string[] = [];

vi.mock("@/lib/auth", () => ({ auth }));
vi.mock("@/lib/notify", () => ({ announcer: { announce: vi.fn() } }));

describe("POST /api/drafts (theme mode)", () => {
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
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  it("creates a theme draft and persists theme config without a card pool", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "yugioh-theme-create-"));
    const dbPath = join(tempDir, "theme-create.sqlite");
    tempDirs.push(tempDir);

    process.env.DATABASE_PATH = dbPath;
    process.env.DISCORD_GUILD_ID = "guild-1";
    process.env.DISCORD_DEFAULT_CHANNEL_ID = "channel-1";

    const Database = (await import("better-sqlite3")).default;
    const { migrate } = await import("@yugidraft/shared/db");
    const db = new Database(dbPath);
    migrate(db);
    // two themes to allow
    db.prepare("insert into themes (guild_id, name, created_by_user_id, created_at, updated_at) values ('guild-1','Blue-Eyes','u','t','t')").run();
    db.prepare("insert into themes (guild_id, name, created_by_user_id, created_at, updated_at) values ('guild-1','Dark Magician','u','t','t')").run();
    db.close();

    const { POST } = await import("../app/api/drafts/route");
    const request = new Request("http://localhost/api/drafts", {
      method: "POST",
      body: JSON.stringify({
        name: "Theme Night",
        config: { mode: "theme", allowedThemeIds: [1, 2], themePackSize: 4, extraDeckEnabled: false },
      }),
    }) as NextRequest;
    const response = await POST(request);
    expect(response.status).toBe(201);

    const verifyDb = new Database(dbPath);
    const row = verifyDb.prepare("select config_json from drafts where name = ?").get("Theme Night") as { config_json: string };
    const config = JSON.parse(row.config_json);
    expect(config.mode).toBe("theme");
    expect(config.allowedThemeIds).toEqual([1, 2]);
    expect(config.themePackSize).toBe(4);
    expect(config.uniqueThemes).toBe(true); // default applied
    verifyDb.close();
  });
});
