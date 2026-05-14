import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.fn();
const tempDirs: string[] = [];

vi.mock("@/lib/auth", () => ({ auth }));

describe("POST /api/tournaments/[slug]/leave", () => {
  beforeEach(() => {
    vi.resetModules();
    auth.mockReset();
  });

  afterEach(() => {
    delete process.env.DATABASE_PATH;
    while (tempDirs.length > 0) {
      const d = tempDirs.pop();
      if (d) rmSync(d, { recursive: true, force: true });
    }
  });

  it("removes the caller from the participants list", async () => {
    auth.mockResolvedValue({ user: { id: "user-leaver", name: "Leaver" } });

    const tempDir = mkdtempSync(join(tmpdir(), "tourney-leave-"));
    const dbPath = join(tempDir, "t.sqlite");
    tempDirs.push(tempDir);
    process.env.DATABASE_PATH = dbPath;

    const Database = (await import("better-sqlite3")).default;
    const { migrate } = await import("../../../shared/src/db/schema");
    const seedDb = new Database(dbPath);
    migrate(seedDb);

    seedDb.prepare("insert into players (guild_id, discord_user_id, display_name) values ('g1', 'user-leaver', 'Leaver')").run();
    const playerId = (seedDb.prepare("select id from players where discord_user_id = ?").get("user-leaver") as any).id;
    seedDb
      .prepare("insert into tournaments (guild_id, name, format, status, created_by_user_id, web_slug) values ('g1', 'T', 'round_robin', 'pending', 'user-org', 'slug-1')")
      .run();
    const tId = (seedDb.prepare("select id from tournaments where web_slug = 'slug-1'").get() as any).id;
    seedDb.prepare("insert into tournament_participants (tournament_id, player_id) values (?, ?)").run(tId, playerId);
    seedDb.close();

    const { POST } = await import("../../app/api/tournaments/[slug]/leave/route");
    const res = await POST(new Request("http://localhost/api/tournaments/slug-1/leave", { method: "POST" }), {
      params: Promise.resolve({ slug: "slug-1" }),
    });
    expect(res.status).toBe(200);

    const verifyDb = new Database(dbPath);
    const count = (verifyDb.prepare("select count(*) as c from tournament_participants").get() as any).c;
    verifyDb.close();
    expect(count).toBe(0);
  });

  it("returns 401 when unauthenticated", async () => {
    auth.mockResolvedValue(null);
    const { POST } = await import("../../app/api/tournaments/[slug]/leave/route");
    const res = await POST(new Request("http://localhost/api/tournaments/slug-1/leave", { method: "POST" }), {
      params: Promise.resolve({ slug: "slug-1" }),
    });
    expect(res.status).toBe(401);
  });
});
