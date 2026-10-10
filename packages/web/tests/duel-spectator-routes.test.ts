import { beforeEach, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";
import { verifyDuelConnectionToken } from "@yugidraft/shared/ws";
import { getDuelRoom, duelRoomKey } from "../src/components/duel/api";
import { fixtureUserId, fixtureDiscordId, seedFixtureUsers } from "./fixtures/identity";

const mocks = vi.hoisted(() => ({ actor: vi.fn(), host: vi.fn(), room: vi.fn() }));
vi.mock("@/lib/duel-host", () => ({ requireDuelActor: mocks.actor, callDuelHost: mocks.host,
  redactDuelResult: (data: unknown) => data,
  duelErrorResponse: () => NextResponse.json({ error: "Forbidden" }, { status: 403 }) }));
vi.mock("@/lib/replay-fork-access", () => ({ assertDuelForkAccess: () => ({ kind: "play" }) }));
vi.mock("@/lib/env", () => ({ env: { wsInternalSecret: "spectator-token-test" } }));
import { GET as roomGet } from "../app/api/duels/[slug]/route";
import { GET as connectionGet } from "../app/api/duels/[slug]/connection/route";
const context = { params: Promise.resolve({ slug: "abc" }) };
const request = (spectate = true) => new Request(`http://localhost/api/duels/abc${spectate ? "?spectate=1" : ""}`);
const watched = { role: "spectator", mySeat: null, myDeck: null, mySide: null, session: { status: "active" }, engine: { prompt: null } };
beforeEach(() => {
  vi.clearAllMocks();
  mocks.actor.mockResolvedValue({ ok: true, guildId: "guild", playerId: 7, duels: { room: mocks.room } });
  mocks.room.mockReturnValue({ session: { status: "active" }, mySeat: 0 });
  mocks.host.mockResolvedValue({ ok: true, data: watched });
});

it("requests a public host view for an eliminated player's room", async () => {
  expect(await (await roomGet(request(), context)).json()).toEqual(watched);
  expect(mocks.host).toHaveBeenCalledWith({ op: "view", slug: "abc", guildId: "guild", playerId: 7, spectate: true });
});
it("uses the public final view after completion", async () => {
  mocks.room.mockReturnValue({ session: { status: "completed" }, mySeat: 0, engine: { private: true } });
  expect(await (await roomGet(request(), context)).json()).toEqual(watched);
  expect(mocks.host).toHaveBeenCalledTimes(1);
});
it("issues a spectator token with no seat after the host validates elimination", async () => {
  const result = await (await connectionGet(request(), context)).json();
  expect(verifyDuelConnectionToken(result.token, "spectator-token-test")).toMatchObject({ playerId: 7, slug: "abc", seat: null });
  expect(mocks.host).toHaveBeenCalledWith({ op: "view", slug: "abc", guildId: "guild", playerId: 7, spectate: true });
});
it("propagates a living player's rejected switch without issuing credentials", async () => {
  mocks.host.mockResolvedValue({ ok: false, response: NextResponse.json({ error: "You can watch after your seat is eliminated" }, { status: 409 }) });
  const response = await connectionGet(request(), context);
  expect(response.status).toBe(409);
  expect(await response.json()).not.toHaveProperty("token");
});
it("preserves the existing player connection when spectate is absent", async () => {
  const result = await (await connectionGet(request(false), context)).json();
  expect(verifyDuelConnectionToken(result.token, "spectator-token-test")).toMatchObject({ seat: 0 });
  expect(mocks.host).not.toHaveBeenCalled();
});
it("preserves the terminal room shortcut when spectate is absent", async () => {
  const room = { session: { status: "completed" }, mySeat: 0 };
  mocks.room.mockReturnValue(room);
  expect(await (await roomGet(request(false), context)).json()).toEqual(room);
  expect(mocks.host).not.toHaveBeenCalled();
});
it("keeps public and seated views in separate fetch/cache keys", async () => {
  const fetch = vi.fn().mockResolvedValue(Response.json(watched));
  const original = globalThis.fetch;
  globalThis.fetch = fetch;
  try {
    await getDuelRoom("abc", true);
    expect(fetch).toHaveBeenCalledWith("/api/duels/abc?spectate=1", { cache: "no-store" });
    expect(duelRoomKey("abc")).toBe("/api/duels/abc");
  } finally { globalThis.fetch = original; }
});

it("issues a fresh token from the moved FFA seat rows", async () => {
  const { default: Database } = await import("better-sqlite3");
  const { migrate } = await import("@yugidraft/shared/db");
  const { createDuelService } = await import("@yugidraft/shared/services");
  const db = new Database(":memory:");
  try {
    migrate(db);
    seedFixtureUsers(db, ["u0", "u1", "u2"]);
    const players = [0, 1, 2].map((i) => Number(db.prepare(
      "insert into players (guild_id, user_id, discord_user_id, display_name) values ('guild', ?, ?, ?)",
    ).run(fixtureUserId(`u${i}`), fixtureDiscordId(`u${i}`), `P${i}`).lastInsertRowid));
    const dice = [1, 2, 6];
    const duels = createDuelService(db, { rollDie: () => dice.shift()! });
    const session = duels.create({ guildId: "guild", organizerPlayerId: players[0]!, name: "Dice", mode: "normal", format: "ffa3" });
    for (const [seat, player] of players.entries()) {
      if (seat) duels.takeSeat(session.slug, "guild", player, seat);
      duels.setDeck(session.slug, "guild", player, { main: Array(40).fill(1), extra: [], side: [] });
    }
    mocks.actor.mockResolvedValue({ ok: true, guildId: "guild", playerId: players[2], duels });
    const ctx = { params: Promise.resolve({ slug: session.slug }) };
    const req = () => new Request(`http://localhost/api/duels/${session.slug}/connection`);
    const oldToken = await (await connectionGet(req(), ctx)).json();
    expect(verifyDuelConnectionToken(oldToken.token, "spectator-token-test")).toMatchObject({ seat: 2 });
    duels.startOpening(session.slug, "guild", players[0]!, 1000);
    duels.settleOpening(session.slug, "guild", 4000);
    const newToken = await (await connectionGet(req(), ctx)).json();
    expect(verifyDuelConnectionToken(newToken.token, "spectator-token-test")).toMatchObject({ playerId: players[2], seat: 0 });
    expect(newToken.token).not.toBe(oldToken.token);
  } finally { db.close(); }
});
