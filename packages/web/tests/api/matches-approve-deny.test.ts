import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.fn();
const tempDirs: string[] = [];

vi.mock("@/lib/auth", () => ({ auth }));

async function makeTempDb() {
  const tempDir = mkdtempSync(join(tmpdir(), "match-approve-"));
  const dbPath = join(tempDir, "t.sqlite");
  tempDirs.push(tempDir);
  process.env.DATABASE_PATH = dbPath;
  process.env.DISCORD_GUILD_ID = "g1";

  const Database = (await import("better-sqlite3")).default;
  const { migrate } = await import("../../../shared/src/db/schema");
  const db = new Database(dbPath);
  migrate(db);

  db.prepare("insert into players (guild_id, discord_user_id, display_name) values ('g1','reporter','Yugi')").run();
  db.prepare("insert into players (guild_id, discord_user_id, display_name) values ('g1','opponent','Kaiba')").run();

  const reporter = (db.prepare("select id from players where discord_user_id='reporter'").get() as any).id;
  const opponent = (db.prepare("select id from players where discord_user_id='opponent'").get() as any).id;

  const r = db
    .prepare(
      "insert into matches (guild_id, player_one_id, player_two_id, winner_id, reporter_id, status, source) values ('g1', ?, ?, ?, ?, 'pending', 'casual')",
    )
    .run(reporter, opponent, reporter, reporter);

  db.close();
  return { dbPath, matchId: Number(r.lastInsertRowid) };
}

describe("POST /api/matches/[id]/approve", () => {
  beforeEach(() => {
    vi.resetModules();
    auth.mockReset();
  });

  afterEach(() => {
    delete process.env.DATABASE_PATH;
    delete process.env.DISCORD_GUILD_ID;
    while (tempDirs.length > 0) {
      const d = tempDirs.pop();
      if (d) rmSync(d, { recursive: true, force: true });
    }
  });

  it("returns 401 when not authenticated", async () => {
    auth.mockResolvedValue(null);
    await makeTempDb();
    const { POST } = await import("../../app/api/matches/[id]/approve/route");
    const res = await POST(new Request("http://localhost/api/matches/1/approve"), {
      params: Promise.resolve({ id: "1" }),
    });
    expect(res.status).toBe(401);
  });

  it("returns 404 when match does not exist", async () => {
    auth.mockResolvedValue({ user: { id: "opponent", name: "Kaiba" } });
    await makeTempDb();
    const { POST } = await import("../../app/api/matches/[id]/approve/route");
    const res = await POST(new Request("http://localhost/api/matches/999/approve"), {
      params: Promise.resolve({ id: "999" }),
    });
    expect(res.status).toBe(404);
  });

  it("returns 404 when the current user has no player record in the guild", async () => {
    auth.mockResolvedValue({ user: { id: "stranger", name: "Stranger" } });
    const { matchId } = await makeTempDb();
    const { POST } = await import("../../app/api/matches/[id]/approve/route");
    const res = await POST(new Request(`http://localhost/api/matches/${matchId}/approve`), {
      params: Promise.resolve({ id: String(matchId) }),
    });
    expect(res.status).toBe(404);
  });

  it("returns 400 when the reporter tries to approve their own match", async () => {
    auth.mockResolvedValue({ user: { id: "reporter", name: "Yugi" } });
    const { matchId } = await makeTempDb();
    const { POST } = await import("../../app/api/matches/[id]/approve/route");
    const res = await POST(new Request(`http://localhost/api/matches/${matchId}/approve`), {
      params: Promise.resolve({ id: String(matchId) }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/opponent/i);
  });

  it("approves the match when the opponent calls it", async () => {
    auth.mockResolvedValue({ user: { id: "opponent", name: "Kaiba" } });
    const { matchId } = await makeTempDb();
    const { POST } = await import("../../app/api/matches/[id]/approve/route");
    const res = await POST(new Request(`http://localhost/api/matches/${matchId}/approve`), {
      params: Promise.resolve({ id: String(matchId) }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("approved");
  });
});

describe("POST /api/matches/[id]/deny", () => {
  beforeEach(() => {
    vi.resetModules();
    auth.mockReset();
  });

  afterEach(() => {
    delete process.env.DATABASE_PATH;
    delete process.env.DISCORD_GUILD_ID;
    while (tempDirs.length > 0) {
      const d = tempDirs.pop();
      if (d) rmSync(d, { recursive: true, force: true });
    }
  });

  it("returns 401 when not authenticated", async () => {
    auth.mockResolvedValue(null);
    await makeTempDb();
    const { POST } = await import("../../app/api/matches/[id]/deny/route");
    const res = await POST(new Request("http://localhost/api/matches/1/deny"), {
      params: Promise.resolve({ id: "1" }),
    });
    expect(res.status).toBe(401);
  });

  it("returns 400 when the reporter tries to deny their own match", async () => {
    auth.mockResolvedValue({ user: { id: "reporter", name: "Yugi" } });
    const { matchId } = await makeTempDb();
    const { POST } = await import("../../app/api/matches/[id]/deny/route");
    const res = await POST(new Request(`http://localhost/api/matches/${matchId}/deny`), {
      params: Promise.resolve({ id: String(matchId) }),
    });
    expect(res.status).toBe(400);
  });

  it("denies the match when the opponent calls it", async () => {
    auth.mockResolvedValue({ user: { id: "opponent", name: "Kaiba" } });
    const { matchId } = await makeTempDb();
    const { POST } = await import("../../app/api/matches/[id]/deny/route");
    const res = await POST(new Request(`http://localhost/api/matches/${matchId}/deny`), {
      params: Promise.resolve({ id: String(matchId) }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("denied");
  });
});
