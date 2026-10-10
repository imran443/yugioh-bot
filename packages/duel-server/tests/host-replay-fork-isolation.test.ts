import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { migrate } from "@yugidraft/shared/db";
import { createDuelService, createDuelSeriesService, createReplayForkService, hashReplayForkPrefix } from "@yugidraft/shared/services";
import { seatCountFor, type DuelAnswer, type DuelEngineView, type DuelFormat, type ReplaySource } from "@yugidraft/shared/duels";
import { createDuelHost, type DuelHost } from "../src/host.js";
import type { DuelGameWorker, GameOptions } from "../src/worker-client.js";
import { activeMultiScriptsHash, pinnedEngineVersion } from "../src/multi-scripts.js";
import { EngineLoopError } from "../src/engine-loop-error.js";
import type { DuelScriptError, DuelScriptFatalError } from "../src/script-errors.js";
import { seedIdentity } from "./helpers/identity.js";
import { engineDataDirectory as DATA } from "./engine-data-dir.js";

vi.mock("../src/worker-client.js", async original => ({
  ...await original<typeof import("../src/worker-client.js")>(),
  GameWorker: function (onError?: (error: DuelScriptError) => void, onFatal?: (error: DuelScriptFatalError) => void) {
    const worker = new FakeWorker(); worker.onError = onError; worker.onFatal = onFatal; workers.push(worker); return worker;
  },
}));
const SECRET = "fork-isolation-fixture";
const MANIFEST = JSON.parse(readFileSync(join(DATA, "manifest.json"), "utf8")) as { bundleVersion: string };
const workers: FakeWorker[] = [], hosts: DuelHost[] = [], dbs: Database.Database[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close();
  dbs.splice(0).forEach(db => db.close()); workers.splice(0); vi.unstubAllEnvs(); vi.restoreAllMocks(); vi.useRealTimers();
});
const sample: DuelScriptError = { code: 10, scriptFile: "c10.lua", line: 1, message: "Fixture error", index: 1,
  mode: "normal", format: "1v1", engine: "legacy", scriptErrorMode: "tolerant", commandHash: "fixture" };
class FakeWorker implements DuelGameWorker {
  running = true; revision = 1; promptSeat = 0; count = 2; pendingSeat: number | null = null;
  answered: number[] = []; eliminated: number[] = []; result: DuelEngineView["result"] = null;
  onError?: (error: DuelScriptError) => void; onFatal?: (error: DuelScriptFatalError) => void;
  failAnswer = false; options?: GameOptions;
  async create(options: GameOptions) { this.options = options; this.count = options.decks.length; this.onError?.(sample); }
  async view(viewer: number | null): Promise<DuelEngineView> {
    return { revision: this.revision, turn: 1, turnSeat: 0, phase: "main1", seats: Array.from({ length: this.count }, (_, seat) => ({
      seat, lp: 8000, hand: [], deckCount: 3, extraCount: 0, extra: [], monsters: [], spells: [], graveyard: [], banished: [],
      ...(seat === this.pendingSeat ? { pendingElimination: true } : {}),
    })), prompt: viewer === this.promptSeat && !this.result ? { id: `p${this.revision}`, seat: this.promptSeat,
      kind: "choice", title: "Fixture", options: [{ id: "pass", label: "Pass" }] } : null,
      prioritySeat: this.result ? null : this.promptSeat, chain: [], events: [], log: [], result: this.result };
  }
  async answer(seat: number, _id: string, _answer: DuelAnswer) {
    if (this.failAnswer) throw new EngineLoopError();
    this.answered.push(seat); this.revision++; this.onError?.({ ...sample, index: this.revision });
  }
  async setChainMode(_seat: number, _mode: string) { this.onError?.(sample); return false; }
  async eliminate(seat: number) { this.eliminated.push(seat); this.pendingSeat = seat; this.onError?.(sample); }
  async search() { return []; }
  async close() { this.running = false; }
}
function fixture(format: DuelFormat = "1v1", pendingLoss = false) {
  const db = new Database(":memory:"); dbs.push(db); migrate(db);
  const guildId = "host-fork-isolation", owner = seedIdentity(db, { guildId, userId: 101, name: "Creator" });
  const dev = seedIdentity(db, { guildId, userId: 102, name: "Developer" });
  const players = Array.from({ length: seatCountFor(format) }, (_, i) => seedIdentity(db, { guildId, userId: 201 + i, name: `Player ${i}` }));
  vi.stubEnv("OWNER_USER_IDS", "101,102");
  const duels = createDuelService(db), deck = { main: [1, 2, 3], extra: [], side: [] };
  const session = duels.create({ guildId, organizerPlayerId: players[0]!.playerId, name: "Source", mode: "normal", format, settings: { validateDeck: false, turnSeconds: 60 } });
  for (const [seat, player] of players.entries()) {
    if (seat) duels.takeSeat(session.slug, guildId, player.playerId);
    duels.setDeck(session.slug, guildId, player.playerId, deck);
  }
  const bundleVersion = pinnedEngineVersion(MANIFEST.bundleVersion, players.length, players.length > 2 ? activeMultiScriptsHash(DATA) : null);
  duels.activate(session.slug, guildId, players[0]!.playerId, ["1", "2", "3", "4"], bundleVersion, null, { engine: "legacy", firstTurnDraw: false });
  duels.recordCommand(session.slug, guildId, 0, { promptId: "chain-mode:off", revision: 1, answer: {} }, null);
  if (pendingLoss) duels.recordCommand(session.slug, guildId, 0, { promptId: "eliminate:4", revision: 1, answer: {} }, null);
  duels.interrupt(session.slug, guildId, "Source stopped");
  const state = duels.privateState(session.slug, guildId);
  const source: ReplaySource = { session: state.session, decks: state.decks, seed: ["1", "2", "3", "4"], bundleVersion, commands: state.commands, setup: state.setup, engineIdentity: null };
  const actor = { guildId, ...owner };
  const fork = createReplayForkService(db).create({ actor, source, requestId: "host-isolation", cursorDigest: "b".repeat(64),
    origin: { sourceSlug: session.slug, sourceVersion: "v1", frameId: "point", step: 1, prefixCount: state.commands.length,
      prefixHash: hashReplayForkPrefix(state.commands), sourceSeats: source.session.seats.map(seat => ({ seat: seat.seat, displayName: seat.displayName })) } }).session;
  const notifyTournament = vi.fn();
  const openHost = () => {
    const host = createDuelHost({ db, secret: SECRET, dataDirectory: DATA, searchCards: () => [], pollIntervalMs: 60_000, notifyTournament });
    hosts.push(host); return host;
  };
  return { db, guildId, owner, dev, players, duels, source, fork, actor, openHost, notifyTournament };
}
async function post(app: ReturnType<typeof fixture>, host: DuelHost, op: string, body: Record<string, unknown> = {}) {
  const raw = JSON.stringify({ op, slug: app.fork.slug, guildId: app.guildId, playerId: app.owner.playerId, ...body });
  const response = await host.handle(new Request("http://local/internal/duel", { method: "POST",
    headers: { "content-type": "application/json", "x-announce-signature": "sha256=" + createHmac("sha256", SECRET).update(raw).digest("hex") }, body: raw }));
  return { status: response.status, data: await response.json() as any };
}
function realRows(app: ReturnType<typeof fixture>) {
  return { source: app.db.prepare("select * from duels where id = ?").get(app.source.session.id),
    journal: app.db.prepare("select * from duel_commands where duel_id = ?").all(app.source.session.id),
    series: app.db.prepare("select * from duel_series").all(), matches: app.db.prepare("select * from matches").all(),
    scores: app.db.prepare("select * from point_awards").all(), ratings: app.db.prepare("select * from player_ratings").all() };
}

describe("host fork isolation", () => {
  it.each(["1v1", "tag", "ffa3", "ffa4"] as const)("recovers %s storage bot seats as Manual and keeps them Manual after restart", async format => {
    const app = fixture(format), before = realRows(app), host = app.openHost();
    expect((await post(app, host, "view")).status).toBe(200);
    const worker = workers.at(-1)!; worker.promptSeat = 1;
    expect((await post(app, host, "view")).status).toBe(200);
    expect(worker.answered).toEqual([]); expect(app.duels.privateState(app.fork.slug, app.guildId).commands).toEqual(app.source.commands);
    await host.close();
    const restarted = app.openHost();
    expect((await post(app, restarted, "view")).status).toBe(200);
    expect(workers.at(-1)!.answered).toEqual([]); expect(realRows(app)).toEqual(before);
  });

  it("keeps a pending-loss prompt answerable and does not drive the lost seat", async () => {
    const app = fixture("ffa3", true), host = app.openHost(), before = realRows(app);
    app.duels.setSetup(app.fork.slug, app.guildId, { ...app.duels.privateState(app.fork.slug, app.guildId).setup!, surrenderedSeats: [0] });
    expect((await post(app, host, "view")).status).toBe(200);
    const worker = workers.at(-1)!; expect(worker.answered).toEqual([]);
    expect(worker.pendingSeat).toBe(0);
    expect((await post(app, host, "respond", { command: { promptId: "p1", revision: 1, answer: { choice: "pass" } } })).status).toBe(200);
    expect(worker.answered).toEqual([0]); expect(realRows(app)).toEqual(before);
  });

  it.each(["result", "surrender", "cancel", "interrupt"])("keeps %s local and never schedules a linked series or tournament", async operation => {
    vi.useFakeTimers();
    const app = fixture(), series = createDuelSeriesService(app.db);
    const linked = series.createChallenge({ guildId: app.guildId, challengerPlayerId: app.players[0]!.playerId,
      opponentPlayerId: app.players[1]!.playerId, mode: "normal", bestOf: 3, ranked: true });
    app.db.prepare("update duels set series_id = ?, game_number = 2 where id = ?").run(linked.series.id, app.fork.id);
    const before = realRows(app), host = app.openHost();
    expect((await post(app, host, "view")).status).toBe(200);
    const worker = workers.at(-1)!;
    if (operation === "result") { worker.result = { winnerSeat: 0, reason: "Fixture result" }; expect((await post(app, host, "view")).status).toBe(200); }
    else if (operation === "interrupt") {
      worker.failAnswer = true;
      expect((await post(app, host, "respond", { command: { promptId: "p1", revision: 1, answer: { choice: "pass" } } })).status).toBe(200);
    } else expect((await post(app, host, operation)).status).toBe(200);
    expect(app.duels.get(app.fork.slug, app.guildId).winnerPlayerId).toBeNull();
    await vi.advanceTimersByTimeAsync(61_000);
    expect(realRows(app)).toEqual(before); expect(app.notifyTournament).not.toHaveBeenCalled();
  });

  it("skips prefix diagnostics and tags only errors from later fork commands", async () => {
    const app = fixture(), log = vi.spyOn(console, "error").mockImplementation(() => {}), host = app.openHost();
    expect((await post(app, host, "view")).status).toBe(200);
    expect(log).not.toHaveBeenCalled();
    expect((await post(app, host, "respond", { command: { promptId: "p1", revision: 1, answer: { choice: "pass" } } })).status).toBe(200);
    expect(log.mock.calls.map(([line]) => JSON.parse(String(line)))).toContainEqual(expect.objectContaining({ event: "replay_fork_script_error", duelKind: "replay-fork", duelId: app.fork.id }));
    expect(app.db.prepare("select * from card_script_errors").all()).toEqual([]);
    expect(app.db.prepare("select * from card_script_error_occurrences").all()).toEqual([]);
  });

  it("ignores invalid live clocks in view and tick", async () => {
    vi.useFakeTimers();
    const app = fixture(), host = app.openHost(), before = realRows(app);
    app.db.prepare("update duels set clock_json = ? where id = ?").run(JSON.stringify({ remainingMs: [0, 0], activeSeat: 0, startedAt: 0 }), app.fork.id);
    const result = await post(app, host, "view");
    expect(result.status).toBe(200); expect(result.data.clock).toBeNull();
    await vi.advanceTimersByTimeAsync(61_000);
    expect(app.duels.get(app.fork.slug, app.guildId).status).toBe("active");
    expect(workers.at(-1)!.answered).toEqual([]); expect(realRows(app)).toEqual(before);
  });

  it("denies other owners and revoked creators before recovery or actions", async () => {
    const app = fixture(), host = app.openHost();
    for (const playerId of [app.dev.playerId, app.players[0]!.playerId]) expect((await post(app, host, "view", { playerId })).status).toBe(404);
    vi.stubEnv("OWNER_USER_IDS", "102");
    for (const op of ["view", "surrender", "cancel", "archive", "respond", "chain-mode", "bug-context"])
      expect((await post(app, host, op)).status).toBe(404);
    expect(workers).toEqual([]);
  });

  it("does not recover a changed copied prefix or alter its source", async () => {
    const app = fixture(), before = realRows(app), host = app.openHost();
    app.db.prepare("update duel_commands set command_json = json_set(command_json, '$.promptId', 'chain-mode:always') where duel_id = ?").run(app.fork.id);
    expect((await post(app, host, "view")).status).toBe(409);
    expect(workers).toEqual([]); expect(realRows(app)).toEqual(before);
  });

  it("rejects acting-seat overrides on real play and searches without a fork", async () => {
    const app = fixture(), host = app.openHost();
    for (const op of ["view", "respond", "chain-mode", "cards"]) {
      expect((await post(app, host, op, { slug: app.source.session.slug, playerId: app.players[0]!.playerId, as: 1, query: "" })).status).toBe(400);
    }
    expect((await post(app, host, "cards", { slug: undefined, as: 1, query: "" })).status).toBe(400);
    expect(workers).toEqual([]);
  });

  it("refuses normal lobby/series operations before any fork work", async () => {
    const app = fixture(), host = app.openHost();
    for (const op of ["start", "ready", "unready", "deck", "validate-deck", "add-bot", "opening-pick", "opening-choose", "series-first", "series-side", "series-ready", "series-unready"])
      expect((await post(app, host, op)).status).toBe(409);
    expect(workers).toEqual([]);
  });
});
