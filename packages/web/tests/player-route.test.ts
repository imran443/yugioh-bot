import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.fn();
const tempDirs: string[] = [];
vi.mock("@/lib/auth", () => ({ auth }));

async function seed() {
  const tempDir = mkdtempSync(join(tmpdir(), "yugioh-player-"));
  const dbPath = join(tempDir, "test.sqlite");
  tempDirs.push(tempDir);
  process.env.DATABASE_PATH = dbPath;
  process.env.DISCORD_GUILD_ID = "guild-1";
  const Database = (await import("better-sqlite3")).default;
  const { migrate } = await import("@yugidraft/shared/db");
  const { createScoringService } = await import("@yugidraft/shared/services");
  const db = new Database(dbPath);
  migrate(db);
  const insP = db.prepare("insert into players (guild_id, discord_user_id, display_name) values (?, ?, ?)");
  const p1 = Number(insP.run("guild-1", "u1", "Yugi").lastInsertRowid);
  const p2 = Number(insP.run("guild-1", "u2", "Kaiba").lastInsertRowid);
  const scoring = createScoringService(db);
  scoring.recordMatchResult(
    Number(
      db.prepare(
        `insert into matches (guild_id, player_one_id, player_two_id, winner_id, reporter_id, status, source)
         values ('guild-1', ?, ?, ?, ?, 'approved', 'casual')`,
      ).run(p1, p2, p1, p1).lastInsertRowid,
    ),
  );
  db.close();
  return { p1, p2 };
}

describe("GET /api/player/[id]", () => {
  beforeEach(() => { vi.resetModules(); auth.mockReset(); auth.mockResolvedValue({ user: { id: "u1", name: "Yugi" } }); });
  afterEach(() => {
    delete process.env.DATABASE_PATH; delete process.env.DISCORD_GUILD_ID;
    while (tempDirs.length) { const d = tempDirs.pop(); if (d) rmSync(d, { recursive: true, force: true }); }
  });

  it("401 when unauthenticated", async () => {
    await seed();
    auth.mockResolvedValue(null);
    const { GET } = await import("../app/api/player/[id]/route");
    const res = await GET(new Request("http://x/api/player/1?scope=season"), {
      params: Promise.resolve({ id: "1" }),
    });
    expect(res.status).toBe(401);
  });

  it("returns the profile payload for a player", async () => {
    const { p1 } = await seed();
    const { GET } = await import("../app/api/player/[id]/route");
    const res = await GET(new Request("http://x/api/player/" + p1 + "?scope=season"), {
      params: Promise.resolve({ id: String(p1) }),
    });
    const body = await res.json();
    expect(body.winnings).toBeGreaterThan(0);
    expect(body.careerWinnings).toBeGreaterThan(0);
    expect(body.rank.name).toBeTruthy();
    expect(Array.isArray(body.recent)).toBe(true);
  });
});
