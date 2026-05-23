import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { migrate } from "@yugidraft/shared/db";
import { createTournamentService } from "@yugidraft/shared/services";

const auth = vi.fn();
const announcer = { announce: vi.fn(async (..._args: unknown[]) => ({ ok: true as const })) };
vi.mock("@/lib/auth", () => ({ auth }));
vi.mock("@/lib/notify", () => ({ announcer, broadcaster: { draft: vi.fn(), tournament: vi.fn() } }));
const tempDirs: string[] = [];

describe("report route notifies opponent", () => {
  beforeEach(() => {
    vi.resetModules();
    auth.mockReset();
    announcer.announce.mockClear();
    auth.mockResolvedValue({ user: { id: "u-a", name: "Alice" } });
  });
  afterEach(() => {
    delete process.env.DATABASE_PATH;
    delete process.env.DISCORD_GUILD_ID;
    while (tempDirs.length) {
      const d = tempDirs.pop();
      if (d) rmSync(d, { recursive: true, force: true });
    }
  });

  it("calls announceToBot with match-report-pending", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rep-"));
    tempDirs.push(dir);
    process.env.DATABASE_PATH = join(dir, "bot.sqlite");
    process.env.DISCORD_GUILD_ID = "g1";
    const db = new Database(process.env.DATABASE_PATH);
    migrate(db);
    const aId = Number(db.prepare("insert into players (guild_id, discord_user_id, display_name) values ('g1','u-a','Alice')").run().lastInsertRowid);
    const bId = Number(db.prepare("insert into players (guild_id, discord_user_id, display_name) values ('g1','u-b','Bob')").run().lastInsertRowid);
    const t = createTournamentService(db);
    const tour = t.create("g1", "RR", "round_robin", "u-creator");
    db.prepare("update tournaments set web_slug = 'slug1' where id = ?").run(tour.id);
    t.join(tour.id, aId);
    t.join(tour.id, bId);
    t.start(tour.id);
    const tm = db.prepare("select * from tournament_matches where tournament_id = ?").get(tour.id) as any;

    const { POST } = await import("../app/api/tournaments/[slug]/report/route");
    const res = await POST(
      new Request("http://localhost/x", {
        method: "POST",
        body: JSON.stringify({ tournamentMatchId: tm.id, result: "win" }),
      }),
      { params: Promise.resolve({ slug: "slug1" }) },
    );
    expect(res.status).toBe(200);
    expect(announcer.announce).toHaveBeenCalledTimes(1);
    const payload = announcer.announce.mock.calls[0][0];
    expect(payload).toMatchObject({
      kind: "match-report-pending",
      slug: "slug1",
      reporterDiscordId: "u-a",
      opponentDiscordId: "u-b",
      reporterName: "Alice",
      opponentName: "Bob",
      roundNumber: 1,
      opponentLost: true,
    });
  });
});
