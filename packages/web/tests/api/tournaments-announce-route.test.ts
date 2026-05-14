import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.fn();
const tempDirs: string[] = [];

vi.mock("@/lib/auth", () => ({ auth }));

async function seedTournament(dbPath: string) {
  const Database = (await import("better-sqlite3")).default;
  const { migrate } = await import("../../../shared/src/db/schema");
  const db = new Database(dbPath);
  migrate(db);
  db.prepare("insert into players (guild_id, discord_user_id, display_name) values ('g1', 'u-org', 'Org')").run();
  const orgPlayerId = (db.prepare("select id from players where discord_user_id = 'u-org'").get() as any).id;
  db.prepare("insert into tournaments (guild_id, name, format, status, created_by_user_id, web_slug) values ('g1','My Tournament','round_robin','pending','u-org','slug-1')").run();
  const tId = (db.prepare("select id from tournaments where web_slug = 'slug-1'").get() as any).id;
  db.prepare("insert into tournament_participants (tournament_id, player_id) values (?, ?)").run(tId, orgPlayerId);
  db.close();
}

describe("POST /api/tournaments/[slug]/announce", () => {
  const fetchSpy = vi.fn();

  beforeEach(() => {
    vi.resetModules();
    auth.mockReset();
    fetchSpy.mockReset();
    fetchSpy.mockResolvedValue({ ok: true } as any);
    vi.stubGlobal("fetch", fetchSpy);
    delete process.env.DISCORD_DEFAULT_CHANNEL_ID;
    delete process.env.DISCORD_REMINDER_CHANNEL_ID;
    process.env.BOT_ANNOUNCE_URL = "http://bot:4001";
    process.env.BOT_ANNOUNCE_SECRET = "shh";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.DATABASE_PATH;
    delete process.env.BOT_ANNOUNCE_URL;
    delete process.env.BOT_ANNOUNCE_SECRET;
    while (tempDirs.length > 0) {
      const d = tempDirs.pop();
      if (d) rmSync(d, { recursive: true, force: true });
    }
  });

  it("returns 400 when no announce channel is configured", async () => {
    auth.mockResolvedValue({ user: { id: "u-org", name: "Org" } });
    const tempDir = mkdtempSync(join(tmpdir(), "ta-1-"));
    const dbPath = join(tempDir, "t.sqlite");
    tempDirs.push(tempDir);
    process.env.DATABASE_PATH = dbPath;
    await seedTournament(dbPath);

    const { POST } = await import("../../app/api/tournaments/[slug]/announce/route");
    const res = await POST(new Request("http://localhost/api/tournaments/slug-1/announce", { method: "POST" }), {
      params: Promise.resolve({ slug: "slug-1" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/announcement channel/i);
  });

  it("falls back to DISCORD_DEFAULT_CHANNEL_ID and POSTs to the bot announce endpoint", async () => {
    auth.mockResolvedValue({ user: { id: "u-org", name: "Org" } });
    process.env.DISCORD_DEFAULT_CHANNEL_ID = "channel-default";

    const tempDir = mkdtempSync(join(tmpdir(), "ta-2-"));
    const dbPath = join(tempDir, "t.sqlite");
    tempDirs.push(tempDir);
    process.env.DATABASE_PATH = dbPath;
    await seedTournament(dbPath);

    const { POST } = await import("../../app/api/tournaments/[slug]/announce/route");
    const res = await POST(new Request("http://localhost/api/tournaments/slug-1/announce", { method: "POST" }), {
      params: Promise.resolve({ slug: "slug-1" }),
    });
    expect(res.status).toBe(200);

    await new Promise((r) => setImmediate(r));

    expect(fetchSpy).toHaveBeenCalled();
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe("http://bot:4001/internal/announce/tournament-created");
    const body = JSON.parse((init as any).body as string);
    expect(body.channelId).toBe("channel-default");
    expect(body.organizerUserId).toBe("u-org");
    expect(body.participantCount).toBe(1);
    expect(body.name).toBe("My Tournament");
  });

  it("returns 403 for non-organizer", async () => {
    auth.mockResolvedValue({ user: { id: "u-someone-else", name: "Stranger" } });
    process.env.DISCORD_DEFAULT_CHANNEL_ID = "channel-default";

    const tempDir = mkdtempSync(join(tmpdir(), "ta-3-"));
    const dbPath = join(tempDir, "t.sqlite");
    tempDirs.push(tempDir);
    process.env.DATABASE_PATH = dbPath;
    await seedTournament(dbPath);

    const { POST } = await import("../../app/api/tournaments/[slug]/announce/route");
    const res = await POST(new Request("http://localhost/api/tournaments/slug-1/announce", { method: "POST" }), {
      params: Promise.resolve({ slug: "slug-1" }),
    });
    expect(res.status).toBe(403);
  });
});
