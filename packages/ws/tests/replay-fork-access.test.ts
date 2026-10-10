import { EventEmitter } from "node:events";
import { createHmac } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { canReadDuel, findDuelEventTarget } from "@yugidraft/shared/services";
import { createDuelConnectionToken, type DuelConnectionTokenClaims, type DuelJoinAck } from "@yugidraft/shared/ws";
import { forkEventFixture } from "./helpers/replay-fork-events.js";
import { registerDuelEventHandlers } from "../src/duel-events.js";
import { createInternalHttpHandler } from "../src/internal-http.js";
import type { SocketData, TypedServer } from "../src/events.js";

type TestSocket = EventEmitter & { id: string; data: SocketData; rooms: Set<string>; join: (room: string) => void; leave: (room: string) => void };
const SECRET = "fork-ws-test";
let app: ReturnType<typeof forkEventFixture>;
beforeEach(() => { app = forkEventFixture(); vi.stubEnv("OWNER_USER_IDS", "101,102"); vi.useFakeTimers(); });
afterEach(() => { app.db.close(); vi.unstubAllEnvs(); vi.useRealTimers(); });
function server() {
  const io = new EventEmitter();
  const sockets: TestSocket[] = [];
  const transport = Object.assign(io, { to: (room: string) => ({ emit: (event: string, payload: unknown) => {
    for (const socket of sockets) if (socket.rooms.has(room)) socket.emit(event, payload);
  } }) });
  const events = registerDuelEventHandlers(transport as unknown as TypedServer, { secret: SECRET,
    canReadDuel: claims => canReadDuel(app.db, claims) });
  const handle = createInternalHttpHandler({ io: transport as unknown as TypedServer, secret: SECRET,
    beforeDuelBroadcast: (slug, guildId) => {
      if (!findDuelEventTarget(app.db, slug, guildId)) return false;
      events.pruneDuelRoom(slug, guildId); return true;
    } });
  function connect(): TestSocket {
    const socket = Object.assign(new EventEmitter(), { id: `s${sockets.length}`, data: {} as SocketData, rooms: new Set<string>(),
      join(room: string) { this.rooms.add(room); }, leave(room: string) { this.rooms.delete(room); } });
    sockets.push(socket); io.emit("connection", socket); return socket;
  }
  async function change(slug = app.forkSlug, guildId = app.guildId) {
    const body = JSON.stringify({ slug, guildId });
    return handle(new Request("http://test/internal/duel/changed", { method: "POST", body,
      headers: { "x-announce-signature": "sha256=" + createHmac("sha256", SECRET).update(body).digest("hex") } }));
  }
  return { connect, change, events };
}
function token(slug = app.forkSlug, playerId = app.owner.playerId, seat: number | null = 0) {
  return createDuelConnectionToken({ slug, guildId: app.guildId, playerId, seat, expiresAt: Date.now() + 300_000 }, SECRET);
}
function join(socket: ReturnType<ReturnType<typeof server>["connect"]>, value: string, extra = {}) {
  let result: DuelJoinAck | undefined;
  socket.emit("duel:join", { token: value, ...extra }, (ack: DuelJoinAck) => { result = ack; }); return result;
}
it("denies alpha, another developer and source players even with signed fork tokens", () => {
  const room = server();
  for (const actor of [app.alpha, app.dev, app.sourcePlayer]) {
    const socket = room.connect();
    expect(join(socket, token(app.forkSlug, actor.playerId))?.ok).toBe(false);
    expect(socket.rooms.size).toBe(0);
  }
});
it("keeps creator presence at seat 0 and ignores untrusted acting-seat fields", () => {
  const room = server(), owner = room.connect();
  expect(join(owner, token(), { as: 3, seat: 3 })).toEqual({ ok: true, onlineSeats: [0], spectatorCount: 0 });
  expect(owner.data.duel).toMatchObject({ slug: app.forkSlug, seat: 0, playerId: app.owner.playerId });
  expect(join(room.connect(), token(app.forkSlug, app.owner.playerId, 3))?.ok).toBe(false);
});
it("a copied source token cannot select the fork room", () => {
  const room = server(), player = room.connect();
  expect(join(player, token(app.source.slug, app.sourcePlayer.playerId), { slug: app.forkSlug })?.ok).toBe(true);
  expect([...player.rooms]).toEqual([`duel:${app.guildId}:${app.source.slug}`]);
  expect(join(room.connect(), token(app.forkSlug, app.sourcePlayer.playerId))?.ok).toBe(false);
});
it("prunes a revoked creator before a change broadcast", async () => {
  const room = server(), owner = room.connect(); join(owner, token());
  const change = vi.fn(), expired = vi.fn(); owner.on("duel:changed", change); owner.on("duel:subscription-expired", expired);
  vi.stubEnv("OWNER_USER_IDS", "102");
  expect((await room.change()).status).toBe(204);
  expect(change).not.toHaveBeenCalled(); expect(expired).toHaveBeenCalledWith({ slug: app.forkSlug });
  expect(owner.data.duel).toBeUndefined(); expect(owner.rooms.size).toBe(0);
});
it("prunes a revoked creator before visibility and renewal", () => {
  const room = server(), first = room.connect(), second = room.connect(); join(first, token()); join(second, token());
  const presence = vi.fn(); first.on("duel:presence", presence); second.on("duel:presence", presence);
  vi.stubEnv("OWNER_USER_IDS", "102");
  first.emit("duel:visibility", { visible: false });
  expect(presence).not.toHaveBeenCalled(); expect(first.rooms.size).toBe(0); expect(second.rooms.size).toBe(0);
  expect(join(first, token())?.ok).toBe(false);
});
it("sends no fork change or presence to source, guild or other duel sockets", async () => {
  const room = server(), source = room.connect(), guild = room.connect(), owner = room.connect();
  join(source, token(app.source.slug, app.sourcePlayer.playerId)); guild.join(`guild:${app.guildId}`);
  const leaked = vi.fn(); source.on("duel:presence", leaked); source.on("duel:changed", leaked);
  guild.on("duel:presence", leaked); guild.on("duel:changed", leaked);
  join(owner, token()); const changed = vi.fn(); owner.on("duel:changed", changed);
  expect((await room.change()).status).toBe(204);
  expect(changed).toHaveBeenCalledWith({ slug: app.forkSlug }); expect(leaked).not.toHaveBeenCalled();
  expect((await room.change("missing")).status).toBe(404);
});
it("fails closed if the access reader fails", () => {
  const room = server(), owner = room.connect(); join(owner, token()); app.db.close();
  room.events.pruneDuelRoom(app.forkSlug, app.guildId);
  expect(owner.rooms.size).toBe(0); expect(join(owner, token())?.ok).toBe(false);
});

it.each(["leave", "disconnecting", "expiry"])("prunes a revoked creator before %s presence", async action => {
  const room = server(), first = room.connect(), second = room.connect(); join(first, token()); join(second, token());
  const presence = vi.fn(); first.on("duel:presence", presence); second.on("duel:presence", presence);
  vi.stubEnv("OWNER_USER_IDS", "102");
  if (action === "leave") first.emit("duel:leave", { slug: app.forkSlug, guildId: app.guildId });
  if (action === "disconnecting") first.emit("disconnecting");
  if (action === "expiry") await vi.advanceTimersByTimeAsync(300_000);
  expect(presence).not.toHaveBeenCalled(); expect(first.rooms.size).toBe(0); expect(second.rooms.size).toBe(0);
});
