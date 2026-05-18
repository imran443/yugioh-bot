import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { migrate } from "@yugidraft/shared/db";
import { createTournamentService } from "@yugidraft/shared/services";

const auth = vi.fn();
const announceToBot = vi.fn(async () => ({ ok: true as const }));
vi.mock("@/lib/auth", () => ({ auth }));
vi.mock("@/lib/announce-bot", () => ({ announceToBot }));
const tempDirs: string[] = [];

function scenario() {
  const dir = mkdtempSync(join(tmpdir(), "mr-"));
  tempDirs.push(dir);
  process.env.DATABASE_PATH = join(dir, "bot.sqlite");
  process.env.DISCORD_GUILD_ID = "g1";
  const db = new Database(process.env.DATABASE_PATH);
  migrate(db);
  const aId = Number(db.prepare("insert into players (guild_id, discord_user_id, display_name) values ('g1','u-a','A')").run().lastInsertRowid);
  const bId = Number(db.prepare("insert into players (guild_id, discord_user_id, display_name) values ('g1','u-b','B')").run().lastInsertRowid);
  const t = createTournamentService(db);
  const tour = t.create("g1", "RR", "round_robin", "u-creator");
  db.prepare("update tournaments set web_slug = 'slug1' where id = ?").run(tour.id);
  t.join(tour.id, aId); t.join(tour.id, bId); t.start(tour.id);
  const tm = db.prepare("select * from tournament_matches where tournament_id = ?").get(tour.id) as any;
  const rep = t.reportTournamentMatch(tm.id, aId, aId);
  return { db, matchId: rep.id };
}

describe("approve/deny emit match-resolved", () => {
  beforeEach(() => {
    vi.resetModules();
    auth.mockReset();
    announceToBot.mockClear();
    auth.mockResolvedValue({ user: { id: "u-b", name: "B" } }); // opponent resolves
  });
  afterEach(() => {
    delete process.env.DATABASE_PATH;
    delete process.env.DISCORD_GUILD_ID;
    while (tempDirs.length) { const d = tempDirs.pop(); if (d) rmSync(d, { recursive: true, force: true }); }
  });

  it("approve emits match-resolved", async () => {
    const { matchId } = scenario();
    const { POST } = await import("../app/api/matches/[id]/approve/route");
    const res = await POST(new Request("http://localhost/x", { method: "POST" }), { params: Promise.resolve({ id: String(matchId) }) });
    expect(res.status).toBe(200);
    expect(announceToBot).toHaveBeenCalledWith(
      expect.any(Object),
      { kind: "match-resolved", matchId },
    );
  });

  it("deny emits match-resolved", async () => {
    const { matchId } = scenario();
    const { POST } = await import("../app/api/matches/[id]/deny/route");
    const res = await POST(new Request("http://localhost/x", { method: "POST" }), { params: Promise.resolve({ id: String(matchId) }) });
    expect(res.status).toBe(200);
    expect(announceToBot).toHaveBeenCalledWith(
      expect.any(Object),
      { kind: "match-resolved", matchId },
    );
  });
});
