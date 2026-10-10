import { fixtureUserId, fixtureDiscordId, seedFixtureUsers } from "./fixtures/identity";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { migrate } from "@yugidraft/shared/db";
import { createDuelService } from "@yugidraft/shared/services";

const auth = vi.fn();
vi.mock("@/lib/session-identity", async () => {
  const { sessionFixture } = await import("./fixtures/session");
  return sessionFixture(auth);
});
const tempDirs: string[] = [];

function seed() {
  const dir = mkdtempSync(join(tmpdir(), "duel-unready-route-"));
  tempDirs.push(dir);
  process.env.DATABASE_PATH = join(dir, "bot.sqlite");
  process.env.DISCORD_GUILD_ID = "g1";
  process.env.DISCORD_TOKEN = "bot-token";
  process.env.DUEL_INTERNAL_URL = "http://duel.test:4003";
  process.env.DUEL_INTERNAL_SECRET = "s3cret";
  const db = new Database(process.env.DATABASE_PATH);
  migrate(db);
  seedFixtureUsers(db, FIXTURE_KEYS);
  const host = Number(db.prepare(`insert into players (guild_id, user_id, discord_user_id, display_name) values ('g1', ${fixtureUserId("u-host")}, '${fixtureDiscordId("u-host")}', 'Yugi')`).run().lastInsertRowid);
  const session = createDuelService(db).create({ guildId: "g1", organizerPlayerId: host, name: "Table", mode: "normal" });
  db.close();
  return { slug: session.slug, host };
}

function post(slug: string) {
  return [
    new Request(`http://localhost/api/duels/${slug}/unready`, { method: "POST" }),
    { params: Promise.resolve({ slug }) },
  ] as const;
}

describe("POST /api/duels/[slug]/unready", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let hostReply: () => Response;
  const hostCalls = () => fetchMock.mock.calls.filter((call) => String(call[0]).startsWith("http://duel.test:4003"));
  beforeEach(() => {
    vi.resetModules();
    auth.mockReset();
    auth.mockResolvedValue({ user: { id: String(fixtureUserId("u-host")), discordUserId: fixtureDiscordId("u-host"), name: "Yugi" } });
    hostReply = () => Response.json({ session: { status: "lobby", seats: [{ ready: false }] } });
    fetchMock = vi.fn(async (url: unknown) => (String(url).startsWith("http://duel.test:4003") ? hostReply() : new Response("{}", { status: 200 })));
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    for (const key of ["DATABASE_PATH", "DISCORD_GUILD_ID", "DISCORD_TOKEN", "DUEL_INTERNAL_URL", "DUEL_INTERNAL_SECRET"]) delete process.env[key];
    vi.unstubAllGlobals();
    while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
  });

  it("takes Ready back through the host as the signed-in player and returns the session", async () => {
    const s = seed();
    const { POST } = await import("../app/api/duels/[slug]/unready/route");
    const res = await POST(...post(s.slug));
    expect(res.status).toBe(200);
    expect(JSON.parse(hostCalls()[0][1].body as string)).toEqual({ op: "unready", slug: s.slug, guildId: "g1", playerId: s.host, userId: fixtureUserId("u-host") });
    expect(await res.json()).toEqual({ session: { status: "lobby", seats: [{ ready: false }] } });
  });

  it("passes a host's opening refusal through without retrying", async () => {
    const s = seed();
    hostReply = () => Response.json({ error: "The game is already starting" }, { status: 409 });
    const { POST } = await import("../app/api/duels/[slug]/unready/route");
    const res = await POST(...post(s.slug));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "The game is already starting" });
    expect(hostCalls()).toHaveLength(1);
  });

  it("refuses a signed-out request before contacting the host", async () => {
    const s = seed();
    auth.mockResolvedValue(null);
    const { POST } = await import("../app/api/duels/[slug]/unready/route");
    expect((await POST(...post(s.slug))).status).toBeGreaterThanOrEqual(401);
    expect(hostCalls()).toHaveLength(0);
  });

  it("refuses a missing duel before contacting the host", async () => {
    seed();
    const { POST } = await import("../app/api/duels/[slug]/unready/route");
    expect((await POST(...post("missing"))).status).toBe(404);
    expect(hostCalls()).toHaveLength(0);
  });
});

const FIXTURE_KEYS = ["u-host"] as const;

// Session resolution is mocked; authorization still runs through the real web boundary.
