import { EventEmitter } from "node:events";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDuelConnectionToken, type DuelJoinAck, type DuelPresencePayload } from "@yugidraft/shared/ws";
import { registerDuelEventHandlers } from "../src/duel-events.js";
import type { SocketData, TypedServer } from "../src/events.js";

const SECRET = "presence-test";
type Client = EventEmitter & {
  id: string;
  data: SocketData;
  rooms: Set<string>;
  join: (room: string) => void;
  leave: (room: string) => void;
};

// Exercise the real handlers with an in-memory room transport; no listening port needed.
function server() {
  const io = new EventEmitter();
  const sockets: Client[] = [];
  const transport = Object.assign(io, {
    to: (room: string) => ({ emit: (event: string, payload: unknown) => {
      for (const socket of sockets) if (socket.rooms.has(room)) socket.emit(event, payload);
    } }),
  });
  registerDuelEventHandlers(transport as unknown as TypedServer, { secret: SECRET, canReadDuel: () => true });
  function connect(): Client {
    const socket = Object.assign(new EventEmitter(), {
      id: `s${sockets.length}`, data: {} as SocketData, rooms: new Set<string>(),
      join(room: string) { this.rooms.add(room); },
      leave(room: string) { this.rooms.delete(room); },
    });
    sockets.push(socket);
    io.emit("connection", socket);
    return socket;
  }
  return { connect };
}

function join(client: Client, seat: number | null, options: { observe?: boolean; visible?: boolean } = {}, guildId = "g1") {
  const token = createDuelConnectionToken({ slug: "same", guildId, playerId: 42 + (seat ?? 10), seat,
    expiresAt: Date.now() + 300_000 }, SECRET);
  let answer: DuelJoinAck | undefined;
  client.emit("duel:join", { token, ...options }, (ack: DuelJoinAck) => { answer = ack; });
  return answer;
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it("observes authenticated room presence without putting the sidebar player in the room", () => {
  const room = server();
  const observer = room.connect();
  expect(join(observer, 0, { observe: true })).toEqual({ ok: true, onlineSeats: [], spectatorCount: 0 });
  let presence: DuelPresencePayload | undefined;
  observer.on("duel:presence", (payload) => { presence = payload; });
  const player = room.connect();
  join(player, 1);
  expect(presence).toEqual({ slug: "same", onlineSeats: [1], spectatorCount: 0 });
  observer.emit("duel:visibility", { visible: true });
  expect(join(player, 1)).toMatchObject({ onlineSeats: [1], spectatorCount: 0 });
});

it("tracks visible tabs per seat, including seats beyond 1, and preserves visibility on renewal", () => {
  const room = server();
  const observer = room.connect();
  join(observer, null, { observe: true });
  const first = room.connect();
  const second = room.connect();
  join(first, 3);
  join(second, 3);
  let presence: DuelPresencePayload | undefined;
  observer.on("duel:presence", (payload) => { presence = payload; });
  first.emit("duel:visibility", { visible: false });
  expect(presence?.onlineSeats).toEqual([3]);
  second.emit("duel:visibility", { visible: false });
  expect(presence?.onlineSeats).toEqual([]);
  expect(join(second, 3, { visible: false })).toMatchObject({ onlineSeats: [] });
  first.emit("duel:visibility", { visible: true });
  expect(presence?.onlineSeats).toEqual([3]);
});

it("clears a seat on leave, disconnect, and token expiry", async () => {
  const room = server();
  const observer = room.connect();
  join(observer, null, { observe: true });
  let presence: DuelPresencePayload | undefined;
  observer.on("duel:presence", (payload) => { presence = payload; });
  const player = room.connect();
  join(player, 2);
  player.emit("duel:leave", { slug: "same", guildId: "g2" });
  expect(presence?.onlineSeats).toEqual([2]);
  player.emit("duel:leave", { slug: "same", guildId: "g1" });
  expect(presence?.onlineSeats).toEqual([]);
  join(player, 2);
  player.emit("disconnecting", "ping timeout");
  expect(presence?.onlineSeats).toEqual([]);
  join(player, 2);
  await vi.advanceTimersByTimeAsync(300_000);
  expect(player.data.duel).toBeUndefined();
});

it("never shares seats across guilds, and rebuilds from joins after a server restart", () => {
  const room = server();
  join(room.connect(), 1);
  expect(join(room.connect(), null, { observe: true }, "g2")).toMatchObject({ onlineSeats: [] });
  const restarted = server();
  const observer = restarted.connect();
  expect(join(observer, null, { observe: true })).toMatchObject({ onlineSeats: [] });
  join(restarted.connect(), 3);
  expect(join(observer, null, { observe: true })).toMatchObject({ onlineSeats: [3] });
});

it("updates presence in place when the same player renews with their moved FFA seat", () => {
  const room = server();
  const observer = room.connect();
  join(observer, null, { observe: true });
  const player = room.connect();
  const token = (seat: number) => createDuelConnectionToken({ slug: "same", guildId: "g1", playerId: 77, seat,
    expiresAt: Date.now() + 300_000 }, SECRET);
  player.emit("duel:join", { token: token(2) }, () => {});
  const updates: DuelPresencePayload[] = [];
  observer.on("duel:presence", (value) => updates.push(value));
  player.emit("duel:join", { token: token(0) }, () => {});
  expect(player.data.duel).toMatchObject({ playerId: 77, seat: 0 });
  expect(updates).toEqual([{ slug: "same", onlineSeats: [0], spectatorCount: 0 }]);
});
