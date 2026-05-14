import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.fn();
const tempDirs: string[] = [];

vi.mock("@/lib/auth", () => ({ auth }));

async function seedTournamentWithParticipants(dbPath: string) {
  const Database = (await import("better-sqlite3")).default;
  const { migrate } = await import("../../../shared/src/db/schema");
  const seedDb = new Database(dbPath);
  migrate(seedDb);
  seedDb.prepare("insert into players (guild_id, discord_user_id, display_name) values ('g1', 'u-org', 'Org'), ('g1', 'u-vict', 'Vict')").run();
  seedDb.prepare("insert into tournaments (guild_id, name, format, status, created_by_user_id, web_slug) values ('g1', 'T', 'round_robin', 'pending', 'u-org', 'slug-1')").run();
  const tId = (seedDb.prepare("select id from tournaments where web_slug = 'slug-1'").get() as any).id;
  const victId = (seedDb.prepare("select id from players where discord_user_id = 'u-vict'").get() as any).id;
  seedDb.prepare("insert into tournament_participants (tournament_id, player_id) values (?, ?)").run(tId, victId);
  seedDb.close();
  return { victId };
}

describe("POST /api/tournaments/[slug]/kick", () => {
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

  it("organizer can kick a participant", async () => {
    auth.mockResolvedValue({ user: { id: "u-org", name: "Org" } });

    const tempDir = mkdtempSync(join(tmpdir(), "tourney-kick-"));
    const dbPath = join(tempDir, "t.sqlite");
    tempDirs.push(tempDir);
    process.env.DATABASE_PATH = dbPath;

    const { victId } = await seedTournamentWithParticipants(dbPath);

    const { POST } = await import("../../app/api/tournaments/[slug]/kick/route");
    const res = await POST(
      new Request("http://localhost/api/tournaments/slug-1/kick", {
        method: "POST",
        body: JSON.stringify({ playerId: victId }),
      }),
      { params: Promise.resolve({ slug: "slug-1" }) },
    );
    expect(res.status).toBe(200);

    const Database = (await import("better-sqlite3")).default;
    const verifyDb = new Database(dbPath);
    const count = (verifyDb.prepare("select count(*) as c from tournament_participants").get() as any).c;
    verifyDb.close();
    expect(count).toBe(0);
  });

  it("non-organizer cannot kick", async () => {
    auth.mockResolvedValue({ user: { id: "u-vict", name: "Vict" } });

    const tempDir = mkdtempSync(join(tmpdir(), "tourney-kick-2-"));
    const dbPath = join(tempDir, "t.sqlite");
    tempDirs.push(tempDir);
    process.env.DATABASE_PATH = dbPath;

    await seedTournamentWithParticipants(dbPath);

    const { POST } = await import("../../app/api/tournaments/[slug]/kick/route");
    const res = await POST(
      new Request("http://localhost/api/tournaments/slug-1/kick", {
        method: "POST",
        body: JSON.stringify({ playerId: 999 }),
      }),
      { params: Promise.resolve({ slug: "slug-1" }) },
    );
    expect(res.status).toBe(403);
  });
});
