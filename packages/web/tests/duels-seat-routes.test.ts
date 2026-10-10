import { fixtureUserId, fixtureDiscordId, seedFixtureUsers } from "./fixtures/identity";
import Database from "better-sqlite3";
import { NextRequest, NextResponse } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { migrate } from "@yugidraft/shared/db";
import { createDuelService } from "@yugidraft/shared/services";

const { requireDuelActor, callDuelHost, notifyDuelChange } = vi.hoisted(() => ({ requireDuelActor: vi.fn(), callDuelHost: vi.fn(), notifyDuelChange: vi.fn() }));
vi.mock("@/lib/session-identity", async () => {
  const { sessionFixture } = await import("./fixtures/session");
  return sessionFixture((() => ({ auth: vi.fn() }))().auth);
});
vi.mock("@/lib/duel-host", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/duel-host")>(), requireDuelActor, callDuelHost,
}));
vi.mock("@/lib/notify-duel", () => ({ notifyDuelChange }));
vi.mock("@/lib/db", () => ({ getDb: () => db }));

let db: Database.Database;
let duels: ReturnType<typeof createDuelService>;
let host: number;
let guest: number;
let viewer: number;
let slug: string;
const deck = { main: new Array(40).fill(1), extra: [], side: [] };

function actor(playerId = guest) {
  requireDuelActor.mockResolvedValue({ ok: true, guildId: "g", playerId, duels });
}

function post(path: string, body?: unknown) {
  return [
    new NextRequest(`http://localhost/api/duels/${slug}/${path}`, {
      method: "POST", body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
    }),
    { params: Promise.resolve({ slug }) },
  ] as const;
}

beforeEach(() => {
  vi.stubEnv("MULTIPLAYER_TABLES", "1");
  db = new Database(":memory:");
  migrate(db);
  seedFixtureUsers(db, FIXTURE_KEYS);
  const insert = db.prepare("insert into players (guild_id, user_id, discord_user_id, display_name) values ('g', ?, ?, ?)");
  host = Number(insert.run(fixtureUserId("host"), fixtureDiscordId("host"), "Host").lastInsertRowid);
  guest = Number(insert.run(fixtureUserId("guest"), fixtureDiscordId("guest"), "Guest").lastInsertRowid);
  viewer = Number(insert.run(fixtureUserId("viewer"), fixtureDiscordId("viewer"), "Viewer").lastInsertRowid);
  duels = createDuelService(db);
  slug = duels.create({ guildId: "g", organizerPlayerId: host, name: "Table", mode: "normal" }).slug;
  requireDuelActor.mockReset();
  callDuelHost.mockReset().mockResolvedValue({ ok: true, data: { multiCoreReady: true } });
  notifyDuelChange.mockReset();
  notifyDuelChange.mockResolvedValue(undefined);
  actor();
});
afterEach(() => {
  db.close();
  vi.unstubAllEnvs();
});

describe("spectator entry", () => {
  it("reads an open table as a spectator without claiming a seat or notifying viewers", async () => {
    const { GET } = await import("../app/api/duels/[slug]/route");
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await GET(new NextRequest(`http://localhost/api/duels/${slug}`), { params: Promise.resolve({ slug }) });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ role: "spectator", mySeat: null, session: { seats: expect.any(Array) } });
    }
    expect(duels.get(slug, "g").seats).toHaveLength(1);
    expect(duels.room(slug, "g", guest).mySeat).toBeNull();
    expect(notifyDuelChange).not.toHaveBeenCalled();
  });

  it("accepts a private invite as a spectator and retains permission after leaving a seat", async () => {
    slug = duels.create({ guildId: "g", organizerPlayerId: host, name: "Private", mode: "domain", settings: { visibility: "private" } }).slug;
    const inviteCode = duels.room(slug, "g", host).inviteCode;
    const { POST } = await import("../app/api/duels/[slug]/invite/route");
    const response = await POST(...post("invite", { inviteCode }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ role: "spectator", mySeat: null, session: { seats: expect.any(Array) } });
    expect(duels.get(slug, "g").seats).toHaveLength(1);
    duels.takeSeat(slug, "g", guest, 1);
    duels.leave(slug, "g", guest);
    expect(duels.room(slug, "g", guest).role).toBe("spectator");
  });
});

describe("POST /api/duels/[slug]/seat", () => {
  it.each([["ffa3", 2], ["ffa4", 3], ["tag", 3]] as const)("takes an extra seat at a %s table (seat %i)", async (format, seat) => {
    slug = duels.create({ guildId: "g", organizerPlayerId: host, name: "Multi table", mode: "normal", format }).slug;
    const { POST } = await import("../app/api/duels/[slug]/seat/route");
    const response = await POST(...post("seat", { seat }));
    expect(response.status).toBe(200);
    expect(duels.room(slug, "g", guest).mySeat).toBe(seat);
    expect(notifyDuelChange).toHaveBeenCalledWith(slug, "g");
  });

  it("takes the requested seat and notifies other viewers", async () => {
    const { POST } = await import("../app/api/duels/[slug]/seat/route");
    const response = await POST(...post("seat", { seat: 1 }));
    expect(response.status).toBe(200);
    expect((await response.json()).session.seats[1]).toMatchObject({ playerId: guest, ready: false });
    expect(notifyDuelChange).toHaveBeenCalledWith(slug, "g");
  });

  it("returns a clear 409 to the losing claimant and leaves them watching", async () => {
    const { POST } = await import("../app/api/duels/[slug]/seat/route");
    await POST(...post("seat", { seat: 1 }));
    actor(viewer);
    notifyDuelChange.mockClear();
    const response = await POST(...post("seat", { seat: 1 }));
    expect(response.status).toBe(409);
    expect((await response.json()).error).toMatch(/seat.*taken.*watching/i);
    expect(duels.room(slug, "g", viewer).mySeat).toBeNull();
    expect(notifyDuelChange).not.toHaveBeenCalled();
  });

  it.each([{}, { seat: 2 }, { seat: -1 }, { seat: 0.5 }, { seat: "1" }, null, [], "invalid JSON"])("rejects an invalid seat body %j", async (body) => {
    const { POST } = await import("../app/api/duels/[slug]/seat/route");
    expect((await POST(...post("seat", body))).status).toBe(400);
    expect(duels.get(slug, "g").seats).toHaveLength(1);
    expect(notifyDuelChange).not.toHaveBeenCalled();
  });

  it.each([401, 403, 503])("preserves actor authentication and guild errors (%i)", async (status) => {
    requireDuelActor.mockResolvedValue({ ok: false, response: NextResponse.json({ error: "Denied" }, { status }) });
    const { POST } = await import("../app/api/duels/[slug]/seat/route");
    expect((await POST(...post("seat", { seat: 1 }))).status).toBe(status);
    expect(notifyDuelChange).not.toHaveBeenCalled();
  });

  it("refuses a private table without an invite grant", async () => {
    slug = duels.create({ guildId: "g", organizerPlayerId: host, name: "Private", mode: "normal", settings: { visibility: "private" } }).slug;
    const { POST } = await import("../app/api/duels/[slug]/seat/route");
    expect((await POST(...post("seat", { seat: 1 }))).status).toBe(403);
  });

  it("refuses claims during RPS and after start", async () => {
    duels.takeSeat(slug, "g", guest, 1);
    duels.setDeck(slug, "g", host, deck);
    duels.setDeck(slug, "g", guest, deck);
    duels.startOpening(slug, "g", host, Date.now());
    actor(viewer);
    const { POST } = await import("../app/api/duels/[slug]/seat/route");
    expect((await POST(...post("seat", { seat: 1 }))).status).toBe(409);
    duels.abortOpening(slug, "g");
    duels.activate(slug, "g", host, ["s"], "v", null);
    expect((await POST(...post("seat", { seat: 1 }))).status).toBe(409);
  });

  it("keeps a successful claim when notification fails", async () => {
    notifyDuelChange.mockRejectedValue(new Error("offline"));
    const { POST } = await import("../app/api/duels/[slug]/seat/route");
    expect((await POST(...post("seat", { seat: 1 }))).status).toBe(200);
    expect(duels.room(slug, "g", guest).mySeat).toBe(1);
  });
});

describe("POST /api/duels/[slug]/leave", () => {
  it("releases a guest seat and deck and notifies viewers", async () => {
    duels.takeSeat(slug, "g", guest, 1);
    duels.setDeck(slug, "g", guest, deck);
    const { POST } = await import("../app/api/duels/[slug]/leave/route");
    expect((await POST(...post("leave"))).status).toBe(200);
    expect(duels.room(slug, "g", guest)).toMatchObject({ role: "spectator", mySeat: null, myDeck: null });
    expect(notifyDuelChange).toHaveBeenCalledWith(slug, "g");
  });

  it("refuses the host and a player in a starting duel", async () => {
    const { POST } = await import("../app/api/duels/[slug]/leave/route");
    actor(host);
    expect((await POST(...post("leave"))).status).toBe(409);
    duels.takeSeat(slug, "g", guest, 1);
    duels.setDeck(slug, "g", host, deck);
    duels.setDeck(slug, "g", guest, deck);
    duels.startOpening(slug, "g", host, Date.now());
    actor();
    expect((await POST(...post("leave"))).status).toBe(409);
    expect(notifyDuelChange).not.toHaveBeenCalled();
  });
});

const FIXTURE_KEYS = ["host", "guest", "viewer"] as const;

// Session resolution is mocked; authorization still runs through the real web boundary.
