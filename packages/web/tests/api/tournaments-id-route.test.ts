import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.fn();
const tempDirs: string[] = [];

vi.mock("@/lib/auth", () => ({ auth }));

describe("GET /api/tournaments/[slug]", () => {
  beforeEach(() => {
    vi.resetModules();
    auth.mockReset();
    auth.mockResolvedValue({ user: { id: "user-1", name: "Yugi" } });
  });

  afterEach(() => {
    delete process.env.DATABASE_PATH;
    delete process.env.DISCORD_GUILD_ID;
    while (tempDirs.length > 0) {
      const d = tempDirs.pop();
      if (d) rmSync(d, { recursive: true, force: true });
    }
  });

  it("looks up tournament by slug, not numeric id", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "tourney-route-"));
    const dbPath = join(tempDir, "t.sqlite");
    tempDirs.push(tempDir);
    process.env.DATABASE_PATH = dbPath;
    process.env.DISCORD_GUILD_ID = "guild-1";

    const Database = (await import("better-sqlite3")).default;
    const { migrate } = await import("../../../shared/src/db/schema");
    const seedDb = new Database(dbPath);
    migrate(seedDb);
    seedDb
      .prepare(
        "insert into tournaments (guild_id, name, format, status, created_by_user_id, web_slug) values (?, ?, ?, 'pending', ?, ?)",
      )
      .run("guild-1", "Locals", "round_robin", "user-1", "abcd1234");
    seedDb.close();

    const { GET } = await import("../../app/api/tournaments/[slug]/route");
    const res = await GET(new Request("http://localhost/api/tournaments/abcd1234"), {
      params: Promise.resolve({ slug: "abcd1234" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.name).toBe("Locals");
    expect(body.webSlug).toBe("abcd1234");
  });

  it("returns 404 for an unknown slug", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "tourney-route-"));
    const dbPath = join(tempDir, "t.sqlite");
    tempDirs.push(tempDir);
    process.env.DATABASE_PATH = dbPath;
    process.env.DISCORD_GUILD_ID = "guild-1";

    const Database = (await import("better-sqlite3")).default;
    const { migrate } = await import("../../../shared/src/db/schema");
    const seedDb = new Database(dbPath);
    migrate(seedDb);
    seedDb.close();

    const { GET } = await import("../../app/api/tournaments/[slug]/route");
    const res = await GET(new Request("http://localhost/api/tournaments/missing"), {
      params: Promise.resolve({ slug: "missing" }),
    });
    expect(res.status).toBe(404);
  });
});
