import { fixtureUserId, fixtureDiscordId, seedFixtureUsers } from "./fixtures/identity";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { migrate } from "@yugidraft/shared/db";
import { createDuelService } from "@yugidraft/shared/services";
import { NextRequest } from "next/server";
import { makeDeck, makeSeries } from "./helpers/duel-series";

const auth = vi.fn();
vi.mock("@/lib/session-identity", async () => {
  const { sessionFixture } = await import("./fixtures/session");
  return sessionFixture(auth);
});
const tempDirs: string[] = [];

function seed() {
  const dir = mkdtempSync(join(tmpdir(), "duel-series-first-route-"));
  tempDirs.push(dir);
  process.env.DATABASE_PATH = join(dir, "bot.sqlite");
  process.env.DISCORD_GUILD_ID = "g1";
  process.env.DISCORD_TOKEN = "bot-token";
  process.env.DUEL_INTERNAL_URL = "http://duel.test:4003";
  process.env.DUEL_INTERNAL_SECRET = "s3cret";
  const db = new Database(process.env.DATABASE_PATH);
  migrate(db);
  seedFixtureUsers(db, FIXTURE_KEYS);
  const insert = db.prepare("insert into players (guild_id, user_id, discord_user_id, display_name) values ('g1', ?, ?, ?)");
  const host = Number(insert.run(fixtureUserId("u-host"), fixtureDiscordId("u-host"), "Yugi").lastInsertRowid);
  insert.run(fixtureUserId("u-other"), fixtureDiscordId("u-other"), "Kaiba");
  const duels = createDuelService(db);
  const session = duels.create({ guildId: "g1", organizerPlayerId: host, name: "Table", mode: "normal" });
  return { slug: session.slug };
}

function post(slug: string, body: unknown) {
  return [
    new Request(`http://localhost/api/duels/${slug}/series/first`, { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) }),
    { params: Promise.resolve({ slug }) },
  ] as const;
}

describe("POST /api/duels/[slug]/series/first", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let hostReply: () => Response;
  const hostCalls = () => fetchMock.mock.calls.filter((call) => String(call[0]).startsWith("http://duel.test:4003"));
  beforeEach(() => {
    vi.resetModules();
    auth.mockReset();
    auth.mockResolvedValue({ user: { id: String(fixtureUserId("u-host")), discordUserId: fixtureDiscordId("u-host"), name: "Yugi" } });
    hostReply = () => Response.json({ session: { status: "lobby" } });
    // The Discord member check answers 200; the duel host answers with `hostReply`.
    fetchMock = vi.fn(async (url: unknown) => (String(url).startsWith("http://duel.test:4003") ? hostReply() : new Response("{}", { status: 200 })));
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    for (const key of ["DATABASE_PATH", "DISCORD_GUILD_ID", "DISCORD_TOKEN", "DUEL_INTERNAL_URL", "DUEL_INTERNAL_SECRET"]) delete process.env[key];
    vi.unstubAllGlobals();
    while (tempDirs.length) {
      const d = tempDirs.pop();
      if (d) rmSync(d, { recursive: true, force: true });
    }
  });

  function sentPayload() {
    return JSON.parse(hostCalls()[0][1].body as string) as Record<string, unknown>;
  }

  it("sends the loser's choice to the duel host as the signed-in player", async () => {
    const s = seed();
    const { POST } = await import("../app/api/duels/[slug]/series/first/route");
    const res = await POST(...post(s.slug, { choice: "second" }));
    expect(res.status).toBe(200);
    expect(sentPayload()).toMatchObject({ op: "series-first", slug: s.slug, guildId: "g1", choice: "second" });
  });

  it.each(["first", "second"] as const)("forwards %s alone and preserves the not-ready response", async (choice) => {
    const s = seed();
    const series = makeSeries({ status: "between_games", firstChooser: 0, firstChoice: choice, sideReady: [false, true], vsBot: true });
    hostReply = () => Response.json({ series, nextSlug: null });
    const { POST } = await import("../app/api/duels/[slug]/series/first/route");
    const res = await POST(...post(s.slug, { choice, ready: true }));
    expect(await res.json()).toEqual({ series, nextSlug: null });
    expect(hostCalls()).toHaveLength(1);
    expect(sentPayload()).toEqual({ op: "series-first", slug: s.slug, guildId: "g1", userId: fixtureUserId("u-host"), playerId: expect.any(Number), choice });
  });

  it("forwards a side change without Ready and preserves readiness", async () => {
    const s = seed();
    const deck = makeDeck();
    const series = makeSeries({ status: "between_games", sideReady: [false, true] });
    hostReply = () => Response.json({ series });
    const { POST } = await import("../app/api/duels/[slug]/series/side/route");
    const request = new NextRequest(`http://localhost/api/duels/${s.slug}/series/side`, { method: "POST", body: JSON.stringify({ deck, ready: true }) });
    const res = await POST(request, { params: Promise.resolve({ slug: s.slug }) });
    expect(await res.json()).toEqual({ series });
    expect(hostCalls()).toHaveLength(1);
    expect(sentPayload()).toEqual({ op: "series-side", slug: s.slug, guildId: "g1", userId: fixtureUserId("u-host"), playerId: expect.any(Number), deck });
  });

  it.each([null, "game-2"])("only the Ready route requests readiness and returns nextSlug %s", async (nextSlug) => {
    const s = seed();
    const series = makeSeries({ status: nextSlug ? "active" : "between_games", sideReady: nextSlug ? [true, true] : [true, false] });
    hostReply = () => Response.json({ series, nextSlug });
    const { POST } = await import("../app/api/duels/[slug]/series/ready/route");
    const res = await POST(...post(s.slug, {}));
    expect(await res.json()).toEqual({ series, nextSlug });
    expect(sentPayload()).toEqual({ op: "series-ready", slug: s.slug, guildId: "g1", userId: fixtureUserId("u-host"), playerId: expect.any(Number) });
  });

  it("refuses a bad body without calling the host", async () => {
    const s = seed();
    const { POST } = await import("../app/api/duels/[slug]/series/first/route");
    expect((await POST(...post(s.slug, { choice: "third" }))).status).toBe(400);
    expect((await POST(...post(s.slug, {}))).status).toBe(400);
    expect((await POST(...post(s.slug, "not json"))).status).toBe(400);
    expect(hostCalls()).toHaveLength(0);
  });

  it("passes a host refusal through", async () => {
    const s = seed();
    hostReply = () => Response.json({ error: "Only the loser of the last game chooses" }, { status: 409 });
    const { POST } = await import("../app/api/duels/[slug]/series/first/route");
    const res = await POST(...post(s.slug, { choice: "first" }));
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain("Only the loser");
  });

  it("refuses a signed-out request", async () => {
    const s = seed();
    auth.mockResolvedValue(null);
    const { POST } = await import("../app/api/duels/[slug]/series/first/route");
    expect((await POST(...post(s.slug, { choice: "first" }))).status).toBeGreaterThanOrEqual(401);
    expect(hostCalls()).toHaveLength(0);
  });
});

const FIXTURE_KEYS = ["u-host", "u-other"] as const;

// Session resolution is mocked; authorization still runs through the real web boundary.
