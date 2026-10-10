import { seedIdentity, seedUser } from "./helpers/identity.js";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { migrate } from "@yugidraft/shared/db";
import { defaultDuelSettings, type DuelAnswer, type DuelCardInfo, type DuelDeck, type DuelEngineView, type DuelPrompt, type DuelRoom, type DuelSettings } from "@yugidraft/shared/duels";
import { createDuelService } from "@yugidraft/shared/services";
import { createDuelHost, type DuelHost } from "../src/host.js";
import { buildPracticeBotDeck } from "../src/practice-bot.js";
import type { DuelGameWorker, GameOptions } from "../src/worker-client.js";
import type { DecisionClockState } from "../src/clock.js";
import { engineDataDirectory as DATA } from "./engine-data-dir.js";

const SECRET = "duel-host-test-secret";
const MANIFEST = JSON.parse(readFileSync(join(DATA, "manifest.json"), "utf8")) as { bundleVersion: string };

function insertPlayer(db: Database.Database, guildId: string, discordUserId: string, displayName: string) {
  return seedIdentity(db, { guildId: guildId, name: displayName, userId: seedUser(db, discordUserId).userId, discordUserId: seedUser(db, discordUserId).discordUserId ?? discordUserId }).playerId;
}

function hiddenHand(controller: number, code: number | undefined) {
  const card = { controller, location: 1, sequence: 0, position: 2 };
  if (code === undefined) return [card];
  return [{ ...card, code }];
}

function fakeView(
  viewer: number | null,
  promptId: string | null,
  revision: number,
  result: DuelEngineView["result"],
  extras: { turn?: number; turnSeat?: number; promptSeat?: number } = {},
): DuelEngineView {
  const promptSeat = extras.promptSeat ?? 0;
  const prompt: DuelPrompt | null =
    promptId && viewer === promptSeat
      ? { id: promptId, seat: promptSeat, kind: "choice", title: "Main", options: [{ id: "pass", label: "Pass" }] }
      : null;
  return {
    revision,
    turn: extras.turn ?? 1,
    turnSeat: extras.turnSeat ?? 0,
    phase: "main1",
    seats: [
      {
        seat: 0,
        lp: 8000,
        hand: hiddenHand(0, viewer === 0 ? 111 : undefined),
        deckCount: 35,
        extraCount: 0,
        extra: [],
        monsters: [],
        spells: [],
        graveyard: [],
        banished: [],
      },
      {
        seat: 1,
        lp: 8000,
        hand: hiddenHand(1, viewer === 1 ? 222 : undefined),
        deckCount: 35,
        extraCount: 0,
        extra: [],
        monsters: [],
        spells: [],
        graveyard: [],
        banished: [],
      },
    ],
    prompt,
    prioritySeat: promptId && !result ? promptSeat : null,
    chain: [],
    events: [],
    log: [],
    result,
  };
}

class FakeWorker implements DuelGameWorker {
  created = 0;
  closed = 0;
  failCreate = false;
  mismatchPrompt = false;
  failAnswer = false;
  killOnAnswer = false;
  failSeat1View = false;
  revision = 1;
  promptId = "p1";
  turn = 1;
  turnSeat = 0;
  promptSeat = 0;
  createdOptions: GameOptions | null = null;
  afterAnswer: ((worker: FakeWorker) => void) | null = null;
  onView: (() => void) | null = null;
  onAnswer: (() => void) | null = null;
  result: DuelEngineView["result"] = null;
  private stopped = false;

  get running() {
    return !this.stopped;
  }

  async create(options: GameOptions) {
    this.createdOptions = options;
    this.created += 1;
    if (this.failCreate) throw new Error("spawn failed");
  }

  async view(seat: number | null) {
    this.onView?.();
    if (this.failSeat1View && seat === 1) throw new Error("seat1 snapshot failed");
    const promptId = this.mismatchPrompt ? "other" : this.result ? null : this.promptId;
    return fakeView(seat, promptId, this.mismatchPrompt ? 9 : this.revision, this.result, {
      turn: this.turn,
      turnSeat: this.turnSeat,
      promptSeat: this.promptSeat,
    });
  }

  async answer(_seat: number, _promptId: string, _answer: DuelAnswer) {
    this.onAnswer?.();
    if (this.killOnAnswer) {
      this.stopped = true;
      throw new Error("worker died");
    }
    if (this.failAnswer) throw new Error("illegal choice");
    this.revision += 1;
    this.promptId = `p${this.revision}`;
    this.afterAnswer?.(this);
  }

  async search(_query: string): Promise<DuelCardInfo[]> {
    return [];
  }

  async close() {
    this.stopped = true;
    this.closed += 1;
  }
}

type HostHarness = {
  db?: Database.Database;
  onChange?: (slug: string, guildId: string) => void | Promise<void>;
  archiveAfterMs?: number;
  idleWorkerMs?: number;
  pollIntervalMs?: number;
  now?: () => number;
};

const hosts: DuelHost[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  while (hosts.length > 0) {
    const host = hosts.pop();
    if (host) await host.close();
  }
});

function openHost(createWorker: (() => DuelGameWorker) | undefined, extra: HostHarness = {}) {
  const db = extra.db ?? new Database(":memory:");
  if (!extra.db) migrate(db);
  const host = createDuelHost({
    db,
    dataDirectory: DATA,
    secret: SECRET,
    searchCards: () => [],
    archiveAfterMs: extra.archiveAfterMs ?? 60 * 60 * 1000,
    idleWorkerMs: extra.idleWorkerMs ?? 60 * 60 * 1000,
    pollIntervalMs: extra.pollIntervalMs ?? 60_000,
    createWorker,
    onChange: extra.onChange,
    now: extra.now,
  });
  hosts.push(host);
  return { db, host };
}

async function post(host: DuelHost, body: Record<string, unknown>) {
  const raw = JSON.stringify(body);
  const signature = "sha256=" + createHmac("sha256", SECRET).update(raw).digest("hex");
  const response = await host.handle(
    new Request("http://localhost/internal/duel", {
      method: "POST",
      headers: { "content-type": "application/json", "x-announce-signature": signature },
      body: raw,
    }),
  );
  let data: unknown = null;
  try {
    data = JSON.parse(await response.text());
  } catch {
    data = null;
  }
  return { status: response.status, data };
}

function readRoom(data: unknown): DuelRoom {
  if (!data || typeof data !== "object") throw new Error("expected duel room");
  if (!("session" in data) || !("role" in data) || !("engine" in data) || !("metadataOnly" in data)) {
    throw new Error("expected duel room");
  }
  return data as DuelRoom;
}

function readHostError(data: unknown): string {
  if (data && typeof data === "object" && "error" in data && typeof data.error === "string") {
    return data.error;
  }
  throw new Error("expected host error");
}

function readIssues(data: unknown): unknown[] {
  if (data && typeof data === "object" && "issues" in data && Array.isArray(data.issues)) {
    return data.issues;
  }
  throw new Error("expected { issues }");
}

function seedPlayers(db: Database.Database) {
  return {
    p1: insertPlayer(db, "g1", "u1", "Yugi"),
    p2: insertPlayer(db, "g1", "u2", "Kaiba"),
    p3: insertPlayer(db, "g1", "u3", "Joey"),
  };
}

function readyLobby(db: Database.Database, p1: number, p2: number, settings?: DuelSettings) {
  const duels = createDuelService(db);
  const session = duels.create({
    guildId: "g1",
    organizerPlayerId: p1,
    name: "Duel",
    mode: "normal",
    settings,
  });
  duels.takeSeat(session.slug, "g1", p2);
  const deck = buildPracticeBotDeck("normal", DATA);
  duels.setDeck(session.slug, "g1", p1, deck);
  duels.setDeck(session.slug, "g1", p2, deck);
  return { duels, session };
}

function roomClock(data: unknown) {
  return readRoom(data).clock;
}

function storedClock(duels: { privateState(slug: string, guildId: string): { clock: DecisionClockState | null } }, slug: string) {
  return duels.privateState(slug, "g1").clock;
}

function createdSettings(worker: FakeWorker) {
  return worker.createdOptions?.settings;
}

describe("duel host rooms", () => {
  it.each(["network", "timeout", "429", "503", "json"])("contains a %s catalog failure and keeps the host available", async (failure) => {
    vi.resetModules();
    const { createDuelHost: create } = await import("../src/host.js");
    const db = new Database(":memory:"); migrate(db);
    const { p1 } = seedPlayers(db);
    const host = create({ db, dataDirectory: DATA, secret: SECRET, searchCards: () => [], pollIntervalMs: 60_000 });
    hosts.push(host);
    const upstream = vi.fn(async () => {
      if (failure === "network") throw new Error("offline");
      if (failure === "timeout") throw new DOMException("timeout", "TimeoutError");
      return new Response("bad JSON", { status: failure === "json" ? 200 : Number(failure), headers: { "Retry-After": "2" } });
    });
    vi.stubGlobal("fetch", upstream);
    const result = await post(host, { op: "check-deck", guildId: "g1", playerId: p1, mode: "normal", deck: { main: [90000001], extra: [], side: [] } });
    expect(result.status).toBe(503);
    expect(readHostError(result.data)).toBe("Card database is unavailable. Try again shortly.");
    const cards = await post(host, { op: "cards", guildId: "g1", playerId: p1, query: "dragon" });
    expect(cards.status).toBe(200);
    expect(upstream).toHaveBeenCalledTimes(1);
    await host.close(); db.close();
  });
  it("lets seated players re-enter, spectators watch public state, and forbids spectator commands", async () => {
    const db = new Database(":memory:");
    migrate(db);
    const { p1, p2, p3 } = seedPlayers(db);
    const { session } = readyLobby(db, p1, p2);
    const { host } = openHost(() => new FakeWorker(), { db });

    const started = await post(host, { op: "start", slug: session.slug, guildId: "g1", playerId: p1 });
    expect(started.status).toBe(200);
    const startedRoom = readRoom(started.data);
    expect(startedRoom.role).toBe("player");
    expect(startedRoom.mySeat).toBe(0);
    expect(startedRoom.engine?.seats[0]?.hand[0]?.code).toBe(111);
    expect(startedRoom.engine?.seats[1]?.hand[0]?.code).toBeUndefined();

    const spectator = await post(host, { op: "view", slug: session.slug, guildId: "g1", playerId: p3 });
    expect(spectator.status).toBe(200);
    const specRoom = readRoom(spectator.data);
    expect(specRoom.role).toBe("spectator");
    expect(specRoom.mySeat).toBeNull();
    expect(specRoom.myDeck).toBeNull();
    expect(specRoom.engine?.seats[0]?.hand[0]?.code).toBeUndefined();
    expect(specRoom.engine?.seats[1]?.hand[0]?.code).toBeUndefined();

    const blocked = await post(host, {
      op: "respond",
      slug: session.slug,
      guildId: "g1",
      playerId: p3,
      command: { promptId: "p1", revision: 1, answer: { choice: "pass" } },
    });
    expect(blocked.status).toBe(403);

    const announce = await post(host, { op: "cards", slug: session.slug, guildId: "g1", playerId: p3, query: "dragon" });
    expect(announce.status).toBe(403);

    const reenter = await post(host, { op: "view", slug: session.slug, guildId: "g1", playerId: p2 });
    expect(reenter.status).toBe(200);
    expect(readRoom(reenter.data).mySeat).toBe(1);
  });

  it("stores surrender snapshots before disposing the worker and keeps them after reload", async () => {
    const changes: Array<[string, string]> = [];
    const db = new Database(":memory:");
    migrate(db);
    const { p1, p2, p3 } = seedPlayers(db);
    const { session, duels } = readyLobby(db, p1, p2);
    const { host } = openHost(() => new FakeWorker(), {
      db,
      onChange: async (slug, guildId) => {
        changes.push([slug, guildId]);
        throw new Error("push failed");
      },
    });

    expect((await post(host, { op: "start", slug: session.slug, guildId: "g1", playerId: p1 })).status).toBe(200);
    const surrendered = await post(host, { op: "surrender", slug: session.slug, guildId: "g1", playerId: p1 });
    expect(surrendered.status).toBe(200);
    const room = readRoom(surrendered.data);
    expect(room.session.status).toBe("completed");
    expect(room.session.winnerSeat).toBe(1);
    expect(room.session.resultReason).toBe("Surrender");
    expect(room.metadataOnly).toBe(false);
    expect(room.engine?.prompt).toBeNull();
    expect(room.engine?.result).toEqual({ winnerSeat: 1, reason: "Surrender" });
    expect(room.engine?.seats[0]?.hand[0]?.code).toBe(111);

    const spec = duels.room(session.slug, "g1", p3);
    expect(spec.role).toBe("spectator");
    expect(spec.engine?.seats[0]?.hand[0]?.code).toBeUndefined();
    expect(changes.some((entry) => entry[0] === session.slug)).toBe(true);

    const stored = db
      .prepare<[string], { snapshot_public_json: string; snapshot_seat0_json: string; snapshot_seat1_json: string }>(
        "select snapshot_public_json, snapshot_seat0_json, snapshot_seat1_json from duels where web_slug = ?",
      )
      .get(session.slug);
    expect(stored?.snapshot_public_json).toBeTruthy();
    expect(stored?.snapshot_seat0_json).toContain("111");
    expect(stored?.snapshot_seat1_json).toContain("222");
    expect(stored?.snapshot_public_json).not.toContain("111");
  });

  it("does not interrupt an active duel when worker create fails, and interrupts on replay mismatch", async () => {
    const db = new Database(":memory:");
    migrate(db);
    const { p1, p2 } = seedPlayers(db);
    const { session, duels } = readyLobby(db, p1, p2);
    duels.activate(session.slug, "g1", p1, ["1", "2", "3", "4"], MANIFEST.bundleVersion, null);

    let attempts = 0;
    const { host } = openHost(() => {
      attempts += 1;
      const worker = new FakeWorker();
      if (attempts === 1) worker.failCreate = true;
      return worker;
    }, { db });

    const transient = await post(host, { op: "view", slug: session.slug, guildId: "g1", playerId: p1 });
    expect(transient.status).toBe(503);
    expect(duels.get(session.slug, "g1").status).toBe("active");

    const recovered = await post(host, { op: "view", slug: session.slug, guildId: "g1", playerId: p1 });
    expect(recovered.status).toBe(200);
    expect(duels.get(session.slug, "g1").status).toBe("active");

    const other = readyLobby(db, p1, p2);
    other.duels.activate(other.session.slug, "g1", p1, ["5", "6", "7", "8"], MANIFEST.bundleVersion, null);
    other.duels.recordCommand(other.session.slug, "g1", 0, { promptId: "saved", revision: 1, answer: { choice: "pass" } }, null);
    const { host: mismatchHost } = openHost(() => {
      const worker = new FakeWorker();
      worker.mismatchPrompt = true;
      return worker;
    }, { db });
    const mismatched = await post(mismatchHost, { op: "view", slug: other.session.slug, guildId: "g1", playerId: p1 });
    expect(mismatched.status).toBe(409);
    expect(other.duels.get(other.session.slug, "g1").status).toBe("interrupted");
  });

  it("interrupts active recovery when the journal uses a retired loss rule", async () => {
    const db = new Database(":memory:");
    migrate(db);
    const { p1, p2 } = seedPlayers(db);
    const { session, duels } = readyLobby(db, p1, p2);
    duels.activate(session.slug, "g1", p1, ["1", "2", "3", "4"], MANIFEST.bundleVersion, null);
    duels.recordCommand(session.slug, "g1", 0, { promptId: "eliminate-eot:3", revision: 1, answer: {} }, null);
    const workers: FakeWorker[] = [];
    const changes: Array<[string, string]> = [];
    const { host } = openHost(() => {
      const worker = new FakeWorker(); workers.push(worker); return worker;
    }, { db, onChange: (slug, guildId) => { changes.push([slug, guildId]); } });
    const response = await post(host, { op: "view", slug: session.slug, guildId: "g1", playerId: p1 });
    expect(response).toMatchObject({ status: 409, data: { code: "ENGINE_UNAVAILABLE_FOR_SOURCE" } });
    expect(duels.get(session.slug, "g1").status).toBe("interrupted");
    expect(workers).toHaveLength(0);
    expect(changes).toContainEqual([session.slug, "g1"]);
  });

  it("does not complete when a final board snapshot fails, then recovers", async () => {
    const db = new Database(":memory:");
    migrate(db);
    const { p1, p2 } = seedPlayers(db);
    const { session, duels } = readyLobby(db, p1, p2);
    let attempts = 0;
    const { host } = openHost(() => {
      attempts += 1;
      const worker = new FakeWorker();
      if (attempts === 1) worker.failSeat1View = true;
      return worker;
    }, { db });

    expect((await post(host, { op: "start", slug: session.slug, guildId: "g1", playerId: p1 })).status).toBe(200);
    const failed = await post(host, { op: "surrender", slug: session.slug, guildId: "g1", playerId: p1 });
    expect(failed.status).toBe(503);
    expect(duels.get(session.slug, "g1").status).toBe("active");
    expect(duels.get(session.slug, "g1").endedAt).toBeNull();

    const retry = await post(host, { op: "surrender", slug: session.slug, guildId: "g1", playerId: p1 });
    expect(retry.status).toBe(200);
    expect(duels.get(session.slug, "g1").status).toBe("completed");
    expect(readRoom(retry.data).metadataOnly).toBe(false);
  });

  it("retries when a running worker dies mid-replay, and interrupts a rejected answer", async () => {
    const db = new Database(":memory:");
    migrate(db);
    const { p1, p2 } = seedPlayers(db);

    const dead = readyLobby(db, p1, p2);
    dead.duels.activate(dead.session.slug, "g1", p1, ["1", "2", "3", "4"], MANIFEST.bundleVersion, null);
    dead.duels.recordCommand(dead.session.slug, "g1", 0, { promptId: "saved", revision: 1, answer: { choice: "pass" } }, null);
    let deadAttempts = 0;
    const { host: deadHost } = openHost(() => {
      deadAttempts += 1;
      const worker = new FakeWorker();
      worker.promptId = "saved";
      if (deadAttempts === 1) worker.killOnAnswer = true;
      return worker;
    }, { db });
    const unavailable = await post(deadHost, { op: "view", slug: dead.session.slug, guildId: "g1", playerId: p1 });
    expect(unavailable.status).toBe(503);
    expect(dead.duels.get(dead.session.slug, "g1").status).toBe("active");
    const retry = await post(deadHost, { op: "view", slug: dead.session.slug, guildId: "g1", playerId: p1 });
    expect(retry.status).toBe(200);
    expect(dead.duels.get(dead.session.slug, "g1").status).toBe("active");

    const rejected = readyLobby(db, p1, p2);
    rejected.duels.activate(rejected.session.slug, "g1", p1, ["5", "6", "7", "8"], MANIFEST.bundleVersion, null);
    rejected.duels.recordCommand(rejected.session.slug, "g1", 0, { promptId: "saved", revision: 1, answer: { choice: "pass" } }, null);
    const { host: rejectHost } = openHost(() => {
      const worker = new FakeWorker();
      worker.promptId = "saved";
      worker.failAnswer = true;
      return worker;
    }, { db });
    const mismatch = await post(rejectHost, { op: "view", slug: rejected.session.slug, guildId: "g1", playerId: p1 });
    expect(mismatch.status).toBe(409);
    expect(rejected.duels.get(rejected.session.slug, "g1").status).toBe("interrupted");
  });

  it("evicts idle workers without finalizing and replays from the journal", async () => {
    vi.useFakeTimers();
    const workers: FakeWorker[] = [];
    const db = new Database(":memory:");
    migrate(db);
    const { p1, p2 } = seedPlayers(db);
    const { session } = readyLobby(db, p1, p2);
    const { host } = openHost(() => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    }, { db, idleWorkerMs: 30, pollIntervalMs: 20 });

    expect((await post(host, { op: "start", slug: session.slug, guildId: "g1", playerId: p1 })).status).toBe(200);
    expect(workers[0]?.created).toBe(1);
    await vi.advanceTimersByTimeAsync(80);
    expect(workers[0]?.closed).toBeGreaterThan(0);
    expect(createDuelService(db).get(session.slug, "g1").status).toBe("active");

    const again = await post(host, { op: "view", slug: session.slug, guildId: "g1", playerId: p1 });
    expect(again.status).toBe(200);
    expect(workers.length).toBeGreaterThan(1);
    expect(workers.at(-1)?.created).toBe(1);
  });

  it("archives finished rooms on host restart using durable timestamps", async () => {
    const db = new Database(":memory:");
    migrate(db);
    const { p1, p2 } = seedPlayers(db);
    const { session, duels } = readyLobby(db, p1, p2);
    const first = openHost(() => new FakeWorker(), { db });

    expect((await post(first.host, { op: "start", slug: session.slug, guildId: "g1", playerId: p1 })).status).toBe(200);
    expect((await post(first.host, { op: "surrender", slug: session.slug, guildId: "g1", playerId: p1 })).status).toBe(200);
    expect(duels.get(session.slug, "g1").archivedAt).toBeTruthy();
    db.prepare("update duels set archived_at = null, ended_at = datetime('now', '-1 hours') where web_slug = ?").run(session.slug);
    await first.host.close();

    openHost(() => new FakeWorker(), { db, archiveAfterMs: 0, pollIntervalMs: 60_000 });
    expect(duels.get(session.slug, "g1").archivedAt).toBeTruthy();
    expect(duels.get(session.slug, "g1").status).toBe("completed");
    expect(duels.list("g1", p1)).toEqual([]);
    expect(duels.list("g1", p1, { archived: true })[0]?.slug).toBe(session.slug);
  });

  it("cancels a lobby and archives a finished room through host ops", async () => {
    const db = new Database(":memory:");
    migrate(db);
    const { p1, p2 } = seedPlayers(db);
    const { host } = openHost(() => new FakeWorker(), { db });
    const duels = createDuelService(db);
    const lobby = duels.create({ guildId: "g1", organizerPlayerId: p1, name: "Lobby", mode: "normal" });

    const cancelled = await post(host, { op: "cancel", slug: lobby.slug, guildId: "g1", playerId: p1 });
    expect(cancelled.status).toBe(200);
    const cancelledRoom = readRoom(cancelled.data);
    expect(cancelledRoom.session.status).toBe("cancelled");
    expect(cancelledRoom.session.winnerSeat).toBeNull();
    expect(cancelledRoom.role).toBe("player");

    const forbidden = await post(host, { op: "archive", slug: lobby.slug, guildId: "g1", playerId: p2 });
    expect(forbidden.status).toBe(403);

    const archived = await post(host, { op: "archive", slug: lobby.slug, guildId: "g1", playerId: p1 });
    expect(archived.status).toBe(200);
    expect(readRoom(archived.data).session.archivedAt).toBeTruthy();

    const { session } = readyLobby(db, p1, p2);
    expect((await post(host, { op: "start", slug: session.slug, guildId: "g1", playerId: p1 })).status).toBe(200);
    const liveArchive = await post(host, { op: "archive", slug: session.slug, guildId: "g1", playerId: p1 });
    expect(liveArchive.status).toBe(409);
  });
});

describe("duel host clocks", () => {
  const timedSettings: DuelSettings = {
    ...defaultDuelSettings("normal"),
    turnSeconds: 30,
    startingLP: 4000,
    drawPerTurn: 2,
    shuffleDeck: false,
  };

  it("grants an opening snapshot grace once and persists it across reconnects", async () => {
    const db = new Database(":memory:");
    migrate(db);
    const { p1, p2 } = seedPlayers(db);
    const { session, duels } = readyLobby(db, p1, p2, timedSettings);
    const worker = new FakeWorker();
    worker.revision = 0;
    let nowMs = 1_000;
    const { host } = openHost(() => worker, { db, now: () => nowMs });
    const started = await post(host, { op: "start", slug: session.slug, guildId: "g1", playerId: p1 });
    expect(started.status).toBe(200);
    expect(roomClock(started.data)?.startedAt).toBe(9_000);
    const before = storedClock(duels, session.slug);
    nowMs = 2_000;
    const reconnected = await post(host, { op: "view", slug: session.slug, guildId: "g1", playerId: p1 });
    expect(reconnected.status).toBe(200);
    expect(storedClock(duels, session.slug)).toEqual(before);
    expect(roomClock(reconnected.data)?.startedAt).toBe(9_000);
  });

  it("passes persisted creator settings into worker.create and starts both seats", async () => {
    const db = new Database(":memory:");
    migrate(db);
    const { p1, p2 } = seedPlayers(db);
    const { session, duels } = readyLobby(db, p1, p2, timedSettings);
    const workers: FakeWorker[] = [];
    let nowMs = 1_000_000;
    const { host } = openHost(() => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    }, { db, now: () => nowMs });

    const started = await post(host, { op: "start", slug: session.slug, guildId: "g1", playerId: p1 });
    expect(started.status).toBe(200);
    expect(createdSettings(workers[0]!)).toMatchObject({
      turnSeconds: 30,
      startingLP: 4000,
      drawPerTurn: 2,
      shuffleDeck: false,
      timeout: "loss",
      validateDeck: true,
    });
    expect(roomClock(started.data)).toEqual({
      turn: 1,
      remainingMs: [30_000, 30_000],
      activeSeat: 0,
      startedAt: 1_000_000,
      serverNow: 1_000_000,
    });
    expect(storedClock(duels, session.slug)).toEqual({
      turn: 1,
      remainingMs: [30_000, 30_000],
      activeSeat: 0,
      startedAt: 1_000_000,
    });
  });

  it("does not reset the deadline on reconnect, stale, or rejected answers", async () => {
    const db = new Database(":memory:");
    migrate(db);
    const { p1, p2 } = seedPlayers(db);
    const { session, duels } = readyLobby(db, p1, p2, timedSettings);
    const worker = new FakeWorker();
    let nowMs = 2_000;
    const { host } = openHost(() => worker, { db, now: () => nowMs });

    expect((await post(host, { op: "start", slug: session.slug, guildId: "g1", playerId: p1 })).status).toBe(200);
    const before = storedClock(duels, session.slug);
    expect(before?.startedAt).toBe(2_000);

    nowMs = 4_500;
    const reenter = await post(host, { op: "view", slug: session.slug, guildId: "g1", playerId: p1 });
    expect(reenter.status).toBe(200);
    expect(storedClock(duels, session.slug)).toEqual(before);
    expect(roomClock(reenter.data)?.startedAt).toBe(2_000);
    expect(roomClock(reenter.data)?.serverNow).toBe(4_500);

    const stale = await post(host, {
      op: "respond",
      slug: session.slug,
      guildId: "g1",
      playerId: p1,
      command: { promptId: "stale", revision: 1, answer: { choice: "pass" } },
    });
    expect(stale.status).toBe(409);
    expect(storedClock(duels, session.slug)).toEqual(before);

    worker.failAnswer = true;
    const rejected = await post(host, {
      op: "respond",
      slug: session.slug,
      guildId: "g1",
      playerId: p1,
      command: { promptId: "p1", revision: 1, answer: { choice: "pass" } },
    });
    expect(rejected.status).toBe(400);
    expect(storedClock(duels, session.slug)).toEqual(before);
    expect(worker.revision).toBe(1);
  });

  it("rejects a late answer as a timeout loss with private and public snapshots", async () => {
    const db = new Database(":memory:");
    migrate(db);
    const { p1, p2 } = seedPlayers(db);
    const { session, duels } = readyLobby(db, p1, p2, timedSettings);
    const worker = new FakeWorker();
    let nowMs = 10_000;
    const { host } = openHost(() => worker, { db, now: () => nowMs });

    expect((await post(host, { op: "start", slug: session.slug, guildId: "g1", playerId: p1 })).status).toBe(200);
    nowMs = 40_000;
    const late = await post(host, {
      op: "respond",
      slug: session.slug,
      guildId: "g1",
      playerId: p1,
      command: { promptId: "p1", revision: 1, answer: { choice: "pass" } },
    });
    expect(late.status).toBe(200);
    const room = readRoom(late.data);
    expect(room.session.status).toBe("completed");
    expect(room.session.winnerSeat).toBe(1);
    expect(room.session.resultReason).toBe("Time limit");
    expect(room.engine?.result).toEqual({ winnerSeat: 1, reason: "Time limit" });
    expect(room.engine?.prompt).toBeNull();
    expect(room.metadataOnly).toBe(false);
    expect(worker.revision).toBe(1);
    expect(duels.privateState(session.slug, "g1").commands).toEqual([]);

    const stored = db
      .prepare<[string], { snapshot_public_json: string; snapshot_seat0_json: string; snapshot_seat1_json: string }>(
        "select snapshot_public_json, snapshot_seat0_json, snapshot_seat1_json from duels where web_slug = ?",
      )
      .get(session.slug);
    expect(stored?.snapshot_seat0_json).toContain("111");
    expect(stored?.snapshot_seat1_json).toContain("222");
    expect(stored?.snapshot_public_json).not.toContain("111");
  });

  it("loses at validation after an awaited view crosses the deadline and does not journal", async () => {
    const db = new Database(":memory:");
    migrate(db);
    const { p1, p2 } = seedPlayers(db);
    const { session, duels } = readyLobby(db, p1, p2, timedSettings);
    const worker = new FakeWorker();
    worker.afterAnswer = (next) => {
      next.turn = 2;
      next.turnSeat = 1;
      next.promptSeat = 1;
    };
    let nowMs = 1_000;
    const { host } = openHost(() => worker, { db, now: () => nowMs });

    expect((await post(host, { op: "start", slug: session.slug, guildId: "g1", playerId: p1 })).status).toBe(200);
    nowMs = 30_999;
    worker.onView = () => {
      nowMs = 31_001;
    };
    const late = await post(host, {
      op: "respond",
      slug: session.slug,
      guildId: "g1",
      playerId: p1,
      command: { promptId: "p1", revision: 1, answer: { choice: "pass" } },
    });
    expect(late.status).toBe(200);
    expect(readRoom(late.data).session.status).toBe("completed");
    expect(readRoom(late.data).session.winnerSeat).toBe(1);
    expect(readRoom(late.data).session.resultReason).toBe("Time limit");
    expect(worker.revision).toBe(1);
    expect(worker.turn).toBe(1);
    expect(duels.privateState(session.slug, "g1").commands).toEqual([]);
    expect(duels.get(session.slug, "g1").status).toBe("completed");
  });

  it("accepts an on-time answer whose engine work crosses the deadline and starts the next turn later", async () => {
    const db = new Database(":memory:");
    migrate(db);
    const { p1, p2 } = seedPlayers(db);
    const { session, duels } = readyLobby(db, p1, p2, timedSettings);
    const worker = new FakeWorker();
    worker.afterAnswer = (next) => {
      next.turn = 2;
      next.turnSeat = 1;
      next.promptSeat = 1;
    };
    let nowMs = 1_000;
    const { host } = openHost(() => worker, { db, now: () => nowMs });

    expect((await post(host, { op: "start", slug: session.slug, guildId: "g1", playerId: p1 })).status).toBe(200);
    nowMs = 30_999;
    worker.onAnswer = () => {
      nowMs = 40_000;
    };
    const played = await post(host, {
      op: "respond",
      slug: session.slug,
      guildId: "g1",
      playerId: p1,
      command: { promptId: "p1", revision: 1, answer: { choice: "pass" } },
    });
    expect(played.status).toBe(200);
    expect(readRoom(played.data).session.status).toBe("active");
    expect(worker.revision).toBe(2);
    expect(worker.turn).toBe(2);
    expect(duels.privateState(session.slug, "g1").commands).toHaveLength(1);
    expect(storedClock(duels, session.slug)).toEqual({
      turn: 2,
      remainingMs: [30_000, 30_000],
      activeSeat: 1,
      startedAt: 40_000,
    });
  });


  it("lets continue play at zero and refills both seats on the next turn", async () => {
    const db = new Database(":memory:");
    migrate(db);
    const { p1, p2 } = seedPlayers(db);
    const { session, duels } = readyLobby(db, p1, p2, { ...timedSettings, timeout: "continue" });
    const worker = new FakeWorker();
    worker.afterAnswer = (next) => {
      next.turn = 2;
      next.turnSeat = 1;
      next.promptSeat = 1;
    };
    let nowMs = 8_000;
    const { host } = openHost(() => worker, { db, now: () => nowMs });

    expect((await post(host, { op: "start", slug: session.slug, guildId: "g1", playerId: p1 })).status).toBe(200);
    nowMs = 40_000;
    const played = await post(host, {
      op: "respond",
      slug: session.slug,
      guildId: "g1",
      playerId: p1,
      command: { promptId: "p1", revision: 1, answer: { choice: "pass" } },
    });
    expect(played.status).toBe(200);
    expect(readRoom(played.data).session.status).toBe("active");
    expect(worker.revision).toBe(2);
    expect(storedClock(duels, session.slug)).toEqual({
      turn: 2,
      remainingMs: [30_000, 30_000],
      activeSeat: 1,
      startedAt: 40_000,
    });
  });

  it("charges only the responding seat during the same turn", async () => {
    const db = new Database(":memory:");
    migrate(db);
    const { p1, p2 } = seedPlayers(db);
    const { session, duels } = readyLobby(db, p1, p2, timedSettings);
    const worker = new FakeWorker();
    worker.afterAnswer = (next) => {
      next.promptSeat = 1;
    };
    let nowMs = 1_000;
    const { host } = openHost(() => worker, { db, now: () => nowMs });

    expect((await post(host, { op: "start", slug: session.slug, guildId: "g1", playerId: p1 })).status).toBe(200);
    nowMs = 1_400;
    const answered = await post(host, {
      op: "respond",
      slug: session.slug,
      guildId: "g1",
      playerId: p1,
      command: { promptId: "p1", revision: 1, answer: { choice: "pass" } },
    });
    expect(answered.status).toBe(200);
    // Seat 0 was charged 400 ms, then earned +3 s back (capped at the 30 s bank); seat 1 is untouched.
    expect(storedClock(duels, session.slug)).toEqual({
      turn: 1,
      remainingMs: [30_000, 30_000],
      activeSeat: 1,
      startedAt: 1_400,
    });
  });

  it("restores the persisted clock after idle eviction without restarting it", async () => {
    vi.useFakeTimers();
    const workers: FakeWorker[] = [];
    const db = new Database(":memory:");
    migrate(db);
    const { p1, p2 } = seedPlayers(db);
    const { session, duels } = readyLobby(db, p1, p2, timedSettings);
    let nowMs = 5_000;
    const { host } = openHost(() => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    }, { db, now: () => nowMs, idleWorkerMs: 30, pollIntervalMs: 20 });

    expect((await post(host, { op: "start", slug: session.slug, guildId: "g1", playerId: p1 })).status).toBe(200);
    const before = storedClock(duels, session.slug);
    nowMs = 5_080;
    await vi.advanceTimersByTimeAsync(80);
    expect(workers[0]?.closed).toBeGreaterThan(0);
    expect(duels.get(session.slug, "g1").status).toBe("active");

    const again = await post(host, { op: "view", slug: session.slug, guildId: "g1", playerId: p1 });
    expect(again.status).toBe(200);
    expect(workers.length).toBeGreaterThan(1);
    expect(createdSettings(workers.at(-1)!)).toMatchObject({ turnSeconds: 30, startingLP: 4000, shuffleDeck: false });
    expect(storedClock(duels, session.slug)).toEqual(before);
    expect(roomClock(again.data)?.startedAt).toBe(before?.startedAt);
    expect(roomClock(again.data)?.serverNow).toBe(5_080);
  });

  it("sweeps a due clock without a resident worker and finishes a timeout loss", async () => {
    vi.useFakeTimers();
    const workers: FakeWorker[] = [];
    const db = new Database(":memory:");
    migrate(db);
    const { p1, p2 } = seedPlayers(db);
    const { session, duels } = readyLobby(db, p1, p2, timedSettings);
    let nowMs = 5_000;
    const { host } = openHost(() => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    }, { db, now: () => nowMs, idleWorkerMs: 30, pollIntervalMs: 20 });

    expect((await post(host, { op: "start", slug: session.slug, guildId: "g1", playerId: p1 })).status).toBe(200);
    nowMs = 5_080;
    await vi.advanceTimersByTimeAsync(80);
    expect(workers[0]?.closed).toBeGreaterThan(0);
    expect(duels.get(session.slug, "g1").status).toBe("active");

    nowMs = 35_000;
    await vi.advanceTimersByTimeAsync(20);
    expect(duels.get(session.slug, "g1").status).toBe("completed");
    expect(duels.get(session.slug, "g1").winnerSeat).toBe(1);
    expect(duels.get(session.slug, "g1").resultReason).toBe("Time limit");
    const retained = duels.room(session.slug, "g1", p1);
    expect(retained.metadataOnly).toBe(false);
    expect(retained.engine?.result).toEqual({ winnerSeat: 1, reason: "Time limit" });
    expect(workers.length).toBeGreaterThan(1);
  });

  it("keeps an unlimited clock null", async () => {
    const db = new Database(":memory:");
    migrate(db);
    const { p1, p2 } = seedPlayers(db);
    const { session, duels } = readyLobby(db, p1, p2, { ...timedSettings, turnSeconds: 0 });
    const worker = new FakeWorker();
    const { host } = openHost(() => worker, { db, now: () => 9_000 });

    const started = await post(host, { op: "start", slug: session.slug, guildId: "g1", playerId: p1 });
    expect(started.status).toBe(200);
    expect(createdSettings(worker)?.turnSeconds).toBe(0);
    expect(roomClock(started.data)).toBeNull();
    expect(storedClock(duels, session.slug)).toBeNull();
  });

  it("restores the persisted clock after a host restart", async () => {
    const db = new Database(":memory:");
    migrate(db);
    const { p1, p2 } = seedPlayers(db);
    const { session, duels } = readyLobby(db, p1, p2, timedSettings);
    let nowMs = 9_000;
    const first = openHost(() => new FakeWorker(), { db, now: () => nowMs });
    expect((await post(first.host, { op: "start", slug: session.slug, guildId: "g1", playerId: p1 })).status).toBe(200);
    const before = storedClock(duels, session.slug);
    await first.host.close();

    nowMs = 12_000;
    const second = openHost(() => new FakeWorker(), { db, now: () => nowMs });
    const viewed = await post(second.host, { op: "view", slug: session.slug, guildId: "g1", playerId: p1 });
    expect(viewed.status).toBe(200);
    expect(storedClock(duels, session.slug)).toEqual(before);
    expect(roomClock(viewed.data)?.startedAt).toBe(before?.startedAt);
    expect(roomClock(viewed.data)?.remainingMs).toEqual(before?.remainingMs);
    expect(roomClock(viewed.data)?.serverNow).toBe(12_000);
  });
});


describe("native host board retention", () => {
  it("projects a public spectator view and retains the surrender board", async () => {
    const db = new Database(":memory:");
    migrate(db);
    const { p1, p2, p3 } = seedPlayers(db);
    const { session } = readyLobby(db, p1, p2);
    const { host } = openHost(undefined, { db });

    const started = await post(host, { op: "start", slug: session.slug, guildId: "g1", playerId: p1 });
    expect(started.status).toBe(200);
    const live = readRoom(started.data);
    expect(live.session.status).toBe("active");
    expect(live.engine?.seats).toHaveLength(2);

    const spectator = await post(host, { op: "view", slug: session.slug, guildId: "g1", playerId: p3 });
    expect(spectator.status).toBe(200);
    const spec = readRoom(spectator.data);
    expect(spec.role).toBe("spectator");
    for (const card of spec.engine?.seats[0]?.hand ?? []) {
      expect(card.code).toBeUndefined();
    }

    const surrendered = await post(host, { op: "surrender", slug: session.slug, guildId: "g1", playerId: p1 });
    expect(surrendered.status).toBe(200);
    const done = readRoom(surrendered.data);
    expect(done.session.status).toBe("completed");
    expect(done.session.resultReason).toBe("Surrender");
    expect(done.metadataOnly).toBe(false);
    expect(done.engine?.prompt).toBeNull();
    expect(done.engine?.result?.winnerSeat).toBe(1);

    await host.close();
    const retained = createDuelService(db).room(session.slug, "g1", p1);
    expect(retained.engine?.result?.winnerSeat).toBe(1);
    expect(retained.metadataOnly).toBe(false);
  }, 120_000);
});

describe("duel host validate-deck", () => {
  const DARK_MAGICIAN = 46986414;
  const shortDeck: DuelDeck = { main: [DARK_MAGICIAN], extra: [], side: [] };

  it("returns issues without writing ready, deck, workers, or broadcasts", async () => {
    const db = new Database(":memory:");
    migrate(db);
    const { p1, p2 } = seedPlayers(db);
    const duels = createDuelService(db);
    const session = duels.create({ guildId: "g1", organizerPlayerId: p1, name: "Duel", mode: "normal" });
    duels.takeSeat(session.slug, "g1", p2);
    const onChange = vi.fn();
    let spawned = 0;
    const { host } = openHost(() => {
      spawned += 1;
      return new FakeWorker();
    }, { db, onChange });

    const preview = await post(host, {
      op: "validate-deck",
      slug: session.slug,
      guildId: "g1",
      playerId: p1,
      deck: shortDeck,
    });
    expect(preview.status).toBe(200);
    expect(readIssues(preview.data).length).toBeGreaterThan(0);

    const room = duels.room(session.slug, "g1", p1);
    expect(room.session.seats.find((seat) => seat.playerId === p1)?.ready).toBe(false);
    expect(room.myDeck).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
    expect(spawned).toBe(0);

    const legal = await post(host, {
      op: "validate-deck",
      slug: session.slug,
      guildId: "g1",
      playerId: p1,
      deck: buildPracticeBotDeck("normal", DATA),
    });
    expect(legal.status).toBe(200);
    expect(legal.data).toEqual({ issues: [] });
    expect(duels.room(session.slug, "g1", p1).myDeck).toBeNull();
    expect(duels.room(session.slug, "g1", p1).session.seats.find((seat) => seat.playerId === p1)?.ready).toBe(false);
    expect(onChange).not.toHaveBeenCalled();
    expect(spawned).toBe(0);
  });

  it("requires room access, a seated player, and lobby like deck submit", async () => {
    const db = new Database(":memory:");
    migrate(db);
    const { p1, p2, p3 } = seedPlayers(db);
    const duels = createDuelService(db);
    const privateSession = duels.create({
      guildId: "g1",
      organizerPlayerId: p1,
      name: "Private",
      mode: "normal",
      settings: { visibility: "private" },
    });
    const { host } = openHost(() => new FakeWorker(), { db });

    const inviteOnly = await post(host, {
      op: "validate-deck",
      slug: privateSession.slug,
      guildId: "g1",
      playerId: p3,
      deck: shortDeck,
    });
    expect(inviteOnly.status).toBe(403);
    expect(readHostError(inviteOnly.data)).toMatch(/invite-only/i);

    const publicSession = duels.create({ guildId: "g1", organizerPlayerId: p1, name: "Public", mode: "normal" });
    duels.takeSeat(publicSession.slug, "g1", p2);
    const spectator = await post(host, {
      op: "validate-deck",
      slug: publicSession.slug,
      guildId: "g1",
      playerId: p3,
      deck: shortDeck,
    });
    expect(spectator.status).toBe(403);
    expect(readHostError(spectator.data)).toMatch(/Join this duel first/i);

    const { session } = readyLobby(db, p1, p2);
    expect((await post(host, { op: "start", slug: session.slug, guildId: "g1", playerId: p1 })).status).toBe(200);
    const locked = await post(host, {
      op: "validate-deck",
      slug: session.slug,
      guildId: "g1",
      playerId: p1,
      deck: shortDeck,
    });
    expect(locked.status).toBe(409);
    expect(readHostError(locked.data)).toMatch(/Decks are locked after the duel starts/i);
  });

  it("rejects invalid card-id types on preview while submit stays strict", async () => {
    const db = new Database(":memory:");
    migrate(db);
    const { p1, p2 } = seedPlayers(db);
    const duels = createDuelService(db);
    const session = duels.create({ guildId: "g1", organizerPlayerId: p1, name: "Duel", mode: "normal" });
    duels.takeSeat(session.slug, "g1", p2);
    const onChange = vi.fn();
    const { host } = openHost(() => new FakeWorker(), { db, onChange });

    const previewShape = await post(host, {
      op: "validate-deck",
      slug: session.slug,
      guildId: "g1",
      playerId: p1,
      deck: { extra: [], side: [] },
    });
    expect(previewShape.status).toBe(400);
    expect(readHostError(previewShape.data)).toMatch(/main, extra, and side/i);

    const previewZero = await post(host, {
      op: "validate-deck",
      slug: session.slug,
      guildId: "g1",
      playerId: p1,
      deck: { main: [0], extra: [], side: [] },
    });
    expect(previewZero.status).toBe(400);
    expect(readHostError(previewZero.data)).toMatch(/Unknown card 0/);

    const submitted = await post(host, {
      op: "deck",
      slug: session.slug,
      guildId: "g1",
      playerId: p1,
      deck: shortDeck,
    });
    expect(submitted.status).toBe(400);
    expect(duels.room(session.slug, "g1", p1).myDeck).toBeNull();
    expect(duels.room(session.slug, "g1", p1).session.seats.find((seat) => seat.playerId === p1)?.ready).toBe(false);
    expect(onChange).not.toHaveBeenCalled();
  });
});


class LoggingWorker extends FakeWorker {
  async view(seat: number | null) {
    const base = await super.view(seat);
    const ids = Array.from({ length: this.revision }, (_, index) => index + 1);
    return {
      ...base,
      ...(seat === null ? {} : { chainMode: "always" as const }),
      log: ids.map((id) => ({ id, text: `log ${id}` })),
      events: ids.map((id) => ({ id, kind: "phase" as const, text: `event ${id}` })),
    };
  }
}

describe("duel host replay", () => {
  async function playedDuel(surrenderAfter: boolean, inputs = 2) {
    const db = new Database(":memory:");
    migrate(db);
    const { p1, p2, p3 } = seedPlayers(db);
    const { session, duels } = readyLobby(db, p1, p2);
    const spawned = { count: 0 };
    const { host } = openHost(() => {
      spawned.count += 1;
      return new LoggingWorker();
    }, { db });
    expect((await post(host, { op: "start", slug: session.slug, guildId: "g1", playerId: p1 })).status).toBe(200);
    for (let i = 0; i < inputs; i++) {
      const response = await post(host, {
        op: "respond",
        slug: session.slug,
        guildId: "g1",
        playerId: p1,
        command: { promptId: `p${i + 1}`, revision: i + 1, answer: { choice: "pass" } },
      });
      expect(response.status).toBe(200);
    }
    if (surrenderAfter) {
      expect((await post(host, { op: "surrender", slug: session.slug, guildId: "g1", playerId: p1 })).status).toBe(200);
    }
    return { db, duels, host, session, p1, p2, p3, spawned };
  }

  type ReplayBody = {
    role: string;
    mySeat: number | null;
    frames: Array<{ step: number; actorSeat: number | null; view: DuelEngineView }>;
  };
  const readReplay = (data: unknown) => data as ReplayBody;

  it.each([{ seed: ["1"] }, { seed: ["0", "2", "3", "4"] }, { seed: ["1", "2", "3", "18446744073709551616"] }])
  ("refuses invalid saved seed $seed before spawning and preserves source rows", async ({ seed }) => {
    const { host, session, p1, db, spawned } = await playedDuel(true);
    db.prepare("update duels set seed_json = ? where id = ?").run(JSON.stringify(seed), session.id);
    const beforeDuel = db.prepare("select * from duels where id = ?").get(session.id);
    const beforeCommands = db.prepare("select * from duel_commands where duel_id = ? order by seq").all(session.id);
    const beforeSpawns = spawned.count;
    const response = await post(host, { op: "replay", slug: session.slug, guildId: "g1", playerId: p1 });
    expect(response.status).toBe(409);
    expect(spawned.count).toBe(beforeSpawns);
    expect(db.prepare("select * from duels where id = ?").get(session.id)).toEqual(beforeDuel);
    expect(db.prepare("select * from duel_commands where duel_id = ? order by seq").all(session.id)).toEqual(beforeCommands);
  });

  it("replays a surrendered duel with delta log/events and a final result frame", async () => {
    const { host, session, p1, duels } = await playedDuel(true);
    const before = duels.get(session.slug, "g1");
    const res = await post(host, { op: "replay", slug: session.slug, guildId: "g1", playerId: p1 });
    expect(res.status).toBe(200);
    const replay = readReplay(res.data);
    expect(replay.role).toBe("player");
    expect(replay.mySeat).toBe(0);
    // opening + 2 inputs + saved final snapshot
    expect(replay.frames.map((frame) => frame.step)).toEqual([0, 1, 2, 3]);
    expect(replay.frames.map((frame) => frame.actorSeat)).toEqual([null, 0, 0, null]);
    expect(replay.frames.every((frame) => frame.view.prompt === null)).toBe(true);
    expect(replay.frames[0]?.view.log.map((entry) => entry.id)).toEqual([1]);
    expect(replay.frames[1]?.view.log.map((entry) => entry.id)).toEqual([2]);
    expect(replay.frames[2]?.view.events.map((entry) => entry.id)).toEqual([3]);
    expect(replay.frames[3]?.view.log).toEqual([]);
    expect(replay.frames[3]?.view.result).toEqual({ winnerSeat: 1, reason: "Surrender" });
    expect(replay.frames[0]?.view.seats[0]?.hand[0]?.code).toBe(111);
    expect(duels.get(session.slug, "g1")).toEqual(before);
  });

  it("clears live priority in completed snapshots and every viewer's replay frames", async () => {
    const { db, host, session, p1, p2, p3, duels } = await playedDuel(false, 1);
    const live = await post(host, { op: "view", slug: session.slug, guildId: "g1", playerId: p1 });
    expect(live.status).toBe(200);
    expect(readRoom(live.data).engine?.prioritySeat).toBe(0);
    const surrendered = await post(host, { op: "surrender", slug: session.slug, guildId: "g1", playerId: p1 });
    expect(surrendered.status).toBe(200);
    expect(readRoom(surrendered.data).engine?.prioritySeat).toBeNull();
    for (const playerId of [p1, p2, p3]) {
      expect(duels.room(session.slug, "g1", playerId).engine?.prioritySeat).toBeNull();
      const res = await post(host, { op: "replay", slug: session.slug, guildId: "g1", playerId });
      expect(res.status).toBe(200);
      const frames = readReplay(res.data).frames;
      expect(frames.length).toBeGreaterThan(1);
      for (const frame of frames) {
        expect(frame.view.prioritySeat).toBeNull();
        expect(frame.view.prompt).toBeNull();
        expect(frame.view).not.toHaveProperty("chainMode");
      }
    }
    const stored = db.prepare("select snapshot_public_json, snapshot_seat0_json, snapshot_seat1_json from duels where web_slug = ?")
      .get(session.slug) as Record<string, string>;
    for (const raw of Object.values(stored)) expect(JSON.parse(raw).prioritySeat).toBeNull();
  });

  it("gives spectators the public view", async () => {
    const { host, session, p3 } = await playedDuel(true);
    const res = await post(host, { op: "replay", slug: session.slug, guildId: "g1", playerId: p3 });
    expect(res.status).toBe(200);
    const replay = readReplay(res.data);
    expect(replay.role).toBe("spectator");
    expect(replay.mySeat).toBeNull();
    const json = JSON.stringify(replay.frames);
    expect(json).not.toContain("111");
    expect(json).not.toContain("222");
  });

  it("sanitizes a synthetic final frame when an interrupted duel has no saved board", async () => {
    const { host, session, p1, duels } = await playedDuel(false, 1);
    duels.interrupt(session.slug, "g1", "Fixture interruption");
    expect(duels.room(session.slug, "g1", p1).engine).toBeNull();
    const response = await post(host, { op: "replay", slug: session.slug, guildId: "g1", playerId: p1 });
    expect(response.status).toBe(200);
    const frames = readReplay(response.data).frames;
    expect(frames).toHaveLength(3);
    expect(frames.at(-1)?.view.result?.reason).toBe("Fixture interruption");
    for (const frame of frames) {
      expect(frame.view.prompt).toBeNull();
      expect(frame.view.prioritySeat).toBeNull();
      expect(frame.view).not.toHaveProperty("chainMode");
    }
  });

  it("stops at an engine result and skips the extra final frame", async () => {
    const db = new Database(":memory:");
    migrate(db);
    const { p1, p2 } = seedPlayers(db);
    const { session } = readyLobby(db, p1, p2);
    const worker = new LoggingWorker();
    worker.afterAnswer = (w) => {
      w.result = { winnerSeat: 0, reason: "Life points" };
    };
    const { host } = openHost(() => worker, { db });
    await post(host, { op: "start", slug: session.slug, guildId: "g1", playerId: p1 });
    const done = await post(host, {
      op: "respond",
      slug: session.slug,
      guildId: "g1",
      playerId: p1,
      command: { promptId: "p1", revision: 1, answer: { choice: "pass" } },
    });
    expect(done.status).toBe(200);
    expect(createDuelService(db).get(session.slug, "g1").status).toBe("completed");
    const replayHost = openHost(() => {
      const w = new LoggingWorker();
      w.afterAnswer = (x) => {
        x.result = { winnerSeat: 0, reason: "Life points" };
      };
      return w;
    }, { db });
    const res = await post(replayHost.host, { op: "replay", slug: session.slug, guildId: "g1", playerId: p1 });
    expect(res.status).toBe(200);
    const replay = readReplay(res.data);
    expect(replay.frames.map((frame) => frame.step)).toEqual([0, 1]);
    expect(replay.frames[1]?.view.result?.reason).toBe("Life points");
  });

  it("rejects non-terminal duels", async () => {
    const { host, session, p1 } = await playedDuel(false, 0);
    const res = await post(host, { op: "replay", slug: session.slug, guildId: "g1", playerId: p1 });
    expect(res.status).toBe(409);
    expect(readHostError(res.data)).toBe("Replays are available after the duel ends");
  });

  it("refuses a changed engine bundle without touching the duel", async () => {
    const { host, session, p1, db, duels } = await playedDuel(true);
    db.prepare("update duels set bundle_version = 'old-bundle' where web_slug = ?").run(session.slug);
    const before = duels.get(session.slug, "g1");
    const res = await post(host, { op: "replay", slug: session.slug, guildId: "g1", playerId: p1 });
    expect(res.status).toBe(409);
    expect(readHostError(res.data)).toContain("engine changed");
    expect(duels.get(session.slug, "g1")).toEqual(before);
    expect(before.status).toBe("completed");
  });

  it("reports a replay that cannot be reproduced and closes its worker", async () => {
    const { session, p1, db, duels } = await playedDuel(true);
    const workers: FakeWorker[] = [];
    const other = openHost(() => {
      const w = new LoggingWorker();
      w.mismatchPrompt = true;
      workers.push(w);
      return w;
    }, { db });
    const before = duels.get(session.slug, "g1");
    const res = await post(other.host, { op: "replay", slug: session.slug, guildId: "g1", playerId: p1 });
    expect(res.status).toBe(409);
    expect(readHostError(res.data)).toContain("could not reproduce");
    expect(workers[0]?.closed).toBe(1);
    expect(duels.get(session.slug, "g1")).toEqual(before);
  });

  it("returns 503 when the worker cannot start", async () => {
    const { session, p1, db } = await playedDuel(true);
    const other = openHost(() => {
      const w = new LoggingWorker();
      w.failCreate = true;
      return w;
    }, { db });
    const res = await post(other.host, { op: "replay", slug: session.slug, guildId: "g1", playerId: p1 });
    expect(res.status).toBe(503);
    expect(readHostError(res.data)).toBe("Replay engine is temporarily unavailable.");
    expect(res.data).toMatchObject({ code: "ENGINE_BUSY" });
  });

  it("caches replays per viewer", async () => {
    const { host, session, p1, p3, spawned } = await playedDuel(true);
    const before = spawned.count;
    const a = await post(host, { op: "replay", slug: session.slug, guildId: "g1", playerId: p1 });
    expect(spawned.count).toBe(before + 1);
    const b = await post(host, { op: "replay", slug: session.slug, guildId: "g1", playerId: p1 });
    expect(spawned.count).toBe(before + 1);
    expect(b.data).toEqual(a.data);
    const c = await post(host, { op: "replay", slug: session.slug, guildId: "g1", playerId: p3 });
    expect(spawned.count).toBe(before + 2);
    expect(readReplay(c.data).mySeat).toBeNull();
  });
});
