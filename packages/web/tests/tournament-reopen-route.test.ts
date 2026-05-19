import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { migrate } from "@yugidraft/shared/db";
import { createTournamentService, createMatchService } from "@yugidraft/shared/services";

const auth = vi.fn();
vi.mock("@/lib/auth", () => ({ auth }));
const tempDirs: string[] = [];

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), "reopen-"));
  tempDirs.push(dir);
  const path = join(dir, "bot.sqlite");
  process.env.DATABASE_PATH = path;
  process.env.DISCORD_GUILD_ID = "g1";
  const db = new Database(path);
  migrate(db);
  return db;
}

function player(db: Database.Database, discordId: string, name: string) {
  return Number(
    db.prepare("insert into players (guild_id, discord_user_id, display_name) values ('g1', ?, ?)")
      .run(discordId, name).lastInsertRowid,
  );
}

describe("POST /api/tournaments/[slug]/reopen", () => {
  beforeEach(() => {
    vi.resetModules();
    auth.mockReset();
    auth.mockResolvedValue({ user: { id: "u-creator", name: "Host" } });
  });
  afterEach(() => {
    delete process.env.DATABASE_PATH;
    delete process.env.DISCORD_GUILD_ID;
    while (tempDirs.length) {
      const d = tempDirs.pop();
      if (d) rmSync(d, { recursive: true, force: true });
    }
  });

  async function setupCompletedRR(db: Database.Database) {
    const t = createTournamentService(db);
    const m = createMatchService(db);
    const a = player(db, "u-a", "Alice");
    const b = player(db, "u-b", "Bob");
    const tour = t.create("g1", "RR", "round_robin", "u-creator");
    db.prepare("update tournaments set web_slug = 'slug1' where id = ?").run(tour.id);
    t.join(tour.id, a);
    t.join(tour.id, b);
    t.start(tour.id);
    const tm = db.prepare("select * from tournament_matches where tournament_id = ?").get(tour.id) as any;
    const rep = t.reportTournamentMatch(tm.id, a, a);
    m.approve(rep.id, b);
    return { tm };
  }

  it("401 when unauthenticated", async () => {
    freshDb();
    auth.mockResolvedValue(null);
    const { POST } = await import("../app/api/tournaments/[slug]/reopen/route");
    const res = await POST(
      new Request("http://localhost/x", { method: "POST", body: JSON.stringify({ tournamentMatchId: 1 }) }),
      { params: Promise.resolve({ slug: "slug1" }) },
    );
    expect(res.status).toBe(401);
  });

  it("reopens for the host", async () => {
    const db = freshDb();
    const { tm } = await setupCompletedRR(db);
    const { POST } = await import("../app/api/tournaments/[slug]/reopen/route");
    const res = await POST(
      new Request("http://localhost/x", { method: "POST", body: JSON.stringify({ tournamentMatchId: tm.id }) }),
      { params: Promise.resolve({ slug: "slug1" }) },
    );
    expect(res.status).toBe(200);
    const after = db.prepare("select status from tournament_matches where id = ?").get(tm.id) as any;
    expect(after.status).toBe("open");
  });

  it("403 for a non-host", async () => {
    const db = freshDb();
    const { tm } = await setupCompletedRR(db);
    auth.mockResolvedValue({ user: { id: "u-a", name: "Alice" } });
    const { POST } = await import("../app/api/tournaments/[slug]/reopen/route");
    const res = await POST(
      new Request("http://localhost/x", { method: "POST", body: JSON.stringify({ tournamentMatchId: tm.id }) }),
      { params: Promise.resolve({ slug: "slug1" }) },
    );
    expect(res.status).toBe(403);
  });
});
