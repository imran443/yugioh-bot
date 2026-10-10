import Database from "better-sqlite3";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { migrate } from "@yugidraft/shared/db";
import { createDuelService, createReplayForkService } from "@yugidraft/shared/services";
import { seatCountFor, type DuelEngineView, type DuelFormat, type ReplaySource } from "@yugidraft/shared/duels";
import { createDuelHost, type DuelHost } from "../src/host.js";
import { createReplayCursorCodec, replayFrameId, replayPrefixHash, replaySourceVersion } from "../src/replay-cursor.js";
import { activeMultiScriptsHash, pinnedEngineVersion } from "../src/multi-scripts.js";
import { EngineResourceUnavailableError } from "../src/engine-resource-resolver.js";
import { seedIdentity } from "./helpers/identity.js";
import { ReplayWorker, replaySource } from "./support/replay-fixtures.js";

const resourceRead = vi.hoisted(() => vi.fn());
vi.mock("../src/engine-resource-resolver.js", async original => ({
  ...await original<typeof import("../src/engine-resource-resolver.js")>(), resolveEngineResourcesForSource: resourceRead,
}));
const secret = "fork-launch-test-secret";
const owner = { guildId: "test-guild", playerId: 61, userId: 101 };
let db: Database.Database, dir: string, host: DuelHost, slug: string;
let workers: ForkWorker[], onChange: ReturnType<typeof vi.fn<(slug: string, guildId: string) => void>>, makeWorker: () => ForkWorker;

class ForkWorker extends ReplayWorker {
  promptSeat = 0;
  announce = false;
  pending: number | null = null;
  eliminated: number | null = null;
  async view(viewer: number | null): Promise<DuelEngineView> {
    const view = await super.view(viewer);
    view.prioritySeat = this.result ? null : this.promptSeat;
    view.prompt = viewer === this.promptSeat && !this.result
      ? this.announce ? { id: `p${this.revision}`, seat: this.promptSeat, kind: "announce-card", title: "Card", options: [] }
        : { id: `p${this.revision}`, seat: this.promptSeat, kind: "choice", title: "Next", options: [{ id: "next", label: "Next" }] }
      : null;
    for (const seat of view.seats) {
      if (seat.seat === this.pending) seat.pendingElimination = true;
      if (seat.seat === this.eliminated) seat.eliminated = true;
    }
    return view;
  }
}

function startHost(extra: Partial<Parameters<typeof createDuelHost>[0]> = {}) {
  host = createDuelHost({ db, dataDirectory: dir, secret, searchCards: () => [], pollIntervalMs: 60_000,
    onChange, createWorker: () => { const w = makeWorker(); workers.push(w); return w; }, ...extra });
}
function source(format: DuelFormat = "1v1", mode: "normal" | "domain" = "normal") {
  const duels = createDuelService(db), fixture = replaySource(format);
  const session = duels.create({ guildId: owner.guildId, organizerPlayerId: 64, name: "Private prod source", mode, format,
    settings: { visibility: "private" } });
  slug = session.slug;
  db.prepare("delete from duel_seats where duel_id = ?").run(session.id);
  for (let seat = 0; seat < seatCountFor(format); seat++) {
    db.prepare("insert into duel_seats(duel_id,seat,player_id,is_bot,ready,deck_json) values(?,?,?,0,1,?)")
      .run(session.id, seat, 64 + seat, JSON.stringify(fixture.decks[seat]));
  }
  const bundle = pinnedEngineVersion("test-bundle", seatCountFor(format), activeMultiScriptsHash(dir));
  db.prepare("update duels set status = 'interrupted', seed_json = ?, bundle_version = ?, setup_json = ?, ended_at = datetime('now') where id = ?")
    .run(JSON.stringify(fixture.seed), bundle, JSON.stringify({ ...fixture.setup, engine: "legacy" }), session.id);
  for (const entry of fixture.commands) db.prepare("insert into duel_commands(duel_id,seq,seat,command_json) values(?,?,?,?)")
    .run(session.id, entry.storedSeq, entry.seat, JSON.stringify(entry.command));
}
function sourceState(): ReplaySource {
  const s = createDuelService(db).privateState(slug, owner.guildId);
  const { engineIdentity, replayFork: _fork, ...setup } = s.setup ?? {};
  return { session: s.session, setup, commands: s.commands, decks: s.decks, seed: s.seed as ReplaySource["seed"],
    bundleVersion: s.bundleVersion!, engineIdentity: engineIdentity ?? null };
}
function request(prefixCount = 1) {
  const s = sourceState(), sourceVersion = replaySourceVersion(s), step = prefixCount === 0 ? 0 : prefixCount === 3 ? 2 : 1;
  return { sourceVersion, requestId: "request-1", cursor: createReplayCursorCodec(secret).seal({
    sourceId: s.session.id, sourceSlug: slug, guildId: owner.guildId, sourceVersion,
    frameId: replayFrameId(sourceVersion, step), step, prefixCount, prefixHash: replayPrefixHash(s, prefixCount),
    revision: prefixCount === 0 ? 1 : prefixCount === 3 ? 3 : 2,
  }) };
}
async function post(input: Record<string, unknown>, signed = true) {
  const raw = JSON.stringify({ slug, ...owner, ...input });
  const response = await host.handle(new Request("http://localhost/internal/duel", { method: "POST", body: raw,
    headers: { "x-announce-signature": signed ? "sha256=" + createHmac("sha256", secret).update(raw).digest("hex") : "bad" } }));
  return { response, body: await response.json() as any };
}
const sourceRows = () => [db.prepare("select * from duels where web_slug = ?").get(slug),
  db.prepare("select * from duel_seats where duel_id = (select id from duels where web_slug = ?)").all(slug),
  db.prepare("select * from duel_commands where duel_id = (select id from duels where web_slug = ?)").all(slug)];
beforeEach(() => {
  vi.stubEnv("OWNER_USER_IDS", "101,102"); vi.stubEnv("MULTIPLAYER_TABLES", "1");
  db = new Database(":memory:"); migrate(db);
  dir = mkdtempSync(join(tmpdir(), "host-fork-"));
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ bundleVersion: "test-bundle" }));
  resourceRead.mockReset().mockReturnValue({ dataDirectory: dir, bundleVersion: "test-bundle" });
  for (const [playerId, userId] of [[61, 101], [62, 102], [63, 103], [64, 201], [65, 202], [66, 203], [67, 204]]) {
    seedIdentity(db, { guildId: owner.guildId, playerId, userId });
  }
  source(); workers = []; onChange = vi.fn(); makeWorker = () => new ForkWorker(); startHost();
});
afterEach(async () => { await host.close(); db.close(); rmSync(dir, { recursive: true, force: true }); vi.unstubAllEnvs(); });

it.each(["1v1", "tag", "ffa3", "ffa4"] as const)("launches a private Manual %s fork with defaults after the unchanged prefix", async format => {
  source(format);
  const before = sourceRows(), result = await post({ op: "replay-fork", ...request(3) });
  expect(result.response.status).toBe(200);
  const room = result.body.room;
  expect(room).toMatchObject({ mySeat: 0, session: { kind: "replay-fork", status: "active", bestOf: 1, ranked: false },
    fork: { identitySeat: 0, actingSeat: 0, revealHands: true, manualSeats: Array.from({ length: seatCountFor(format) }, (_, i) => i) } });
  expect(room.engine.seats.map((s: any) => s.hand[0].code)).toEqual(Array.from({ length: seatCountFor(format) }, (_, i) => 900 + i));
  expect(room.engine.seats[1].monsters[0].code).toBeUndefined();
  const state = createReplayForkService(db).privateState(result.body.slug, owner);
  expect(state.commands.slice(0, 3)).toEqual(sourceState().commands);
  expect(state.commands.slice(3).map(c => [c.seat, c.command.promptId])).toEqual(
    Array.from({ length: seatCountFor(format) }, (_, i) => [i, "chain-mode:always"]));
  expect(state.setup).not.toHaveProperty("botPolicies"); expect(state.clock).toBeNull();
  expect(workers[0]!.created).toMatchObject({ seed: ["1", "2", "3", "4"], firstTurnDraw: false });
  if (format === "1v1") expect(workers[0]!.created!.engine).toBe("legacy");
  expect(sourceRows()).toEqual(before);
  expect(db.prepare("select * from duel_series").all()).toEqual([]);
  expect(db.prepare("select * from duel_invite_grants").all()).toEqual([]);
  expect(onChange.mock.calls.every(c => c[0] === result.body.slug)).toBe(true);
});
it.each([0, 1, 3])("launches prefix %s with no opening or scenario phase scripts", async count => {
  const result = await post({ op: "replay-fork", ...request(count) }); expect(result.response.status).toBe(200);
  expect(workers[0]!.created).not.toHaveProperty("startupScripts");
  expect(result.body.room.opening).toBeNull(); expect(result.body.room.engine.revision).toBe(count === 0 ? 1 : count === 3 ? 3 : 2);
});
it("reuses a retry after source deletion and rejects a different cursor for the same key", async () => {
  const input = request(), result = await post({ op: "replay-fork", ...input });
  expect(result.response.status).toBe(200);
  expect((await post({ op: "replay-fork", ...request(0) })).body.code).toBe("REQUEST_CONFLICT");
  db.prepare("delete from duels where web_slug = ?").run(slug);
  const retry = await post({ op: "replay-fork", ...input }); expect(retry.response.status).toBe(200);
  expect(retry.body.slug).toBe(result.body.slug); expect(workers).toHaveLength(1);
});
it("deduplicates concurrent launch retries", async () => {
  const input = request(); const results = await Promise.all([post({ op: "replay-fork", ...input }), post({ op: "replay-fork", ...input })]);
  expect(results.map(r => r.response.status)).toEqual([200, 200]); expect(results[0]!.body.slug).toBe(results[1]!.body.slug);
  expect(workers.filter(w => w.running)).toHaveLength(1);
});
it("rejects bad cursor, changed source/version, active source and terminal engine", async () => {
  expect((await post({ op: "replay-fork", ...request(), cursor: "bad" })).body.code).toBe("INVALID_CURSOR");
  expect((await post({ op: "replay-fork", ...request(), sourceVersion: "other" })).body.code).toBe("SOURCE_CHANGED");
  const old = request(); db.prepare("update duels set name = 'Changed' where web_slug = ?").run(slug);
  expect((await post({ op: "replay-fork", ...old })).body.code).toBe("SOURCE_CHANGED");
  db.prepare("update duels set status = 'active' where web_slug = ?").run(slug);
  expect((await post({ op: "replay-fork", ...request() })).body.code).toBe("NOT_PLAYABLE");
  db.prepare("update duels set status = 'interrupted' where web_slug = ?").run(slug);
  makeWorker = () => { const w = new ForkWorker(); w.result = { winnerSeat: 0, reason: "Won" }; return w; };
  expect((await post({ op: "replay-fork", ...request(0) })).body.code).toBe("NOT_PLAYABLE");
  expect(workers.every(w => !w.running)).toBe(true);
});
it("denies alpha, host forgery, wrong guild, revoked owner and unsigned launch before worker creation", async () => {
  const input = request();
  for (const actor of [{ playerId: 63, userId: 103 }, { playerId: 63, userId: 101 }, { guildId: "other-guild" }]) {
    expect((await post({ op: "replay-fork", ...input, ...actor })).response.status).toBe(404);
  }
  expect((await post({ op: "replay-fork", ...input }, false)).response.status).toBe(401);
  vi.stubEnv("OWNER_USER_IDS", ""); expect((await post({ op: "replay-fork", ...input })).response.status).toBe(404);
  expect(workers).toHaveLength(0);
});
it("cleans up on resource, target, transaction and registration failures", async () => {
  resourceRead.mockImplementationOnce(() => { throw new EngineResourceUnavailableError("Mismatch"); });
  expect((await post({ op: "replay-fork", ...request() })).body.code).toBe("ENGINE_UNAVAILABLE_FOR_SOURCE");
  makeWorker = () => { const w = new ForkWorker(); w.revision = 90; return w; };
  expect((await post({ op: "replay-fork", ...request(0) })).body.code).toBe("REPLAY_MISMATCH");
  makeWorker = () => new ForkWorker();
  db.exec("create trigger fail_fork before insert on replay_fork_requests begin select raise(abort, 'fixture failure'); end");
  expect((await post({ op: "replay-fork", ...request() })).response.status).toBe(503);
  expect(db.prepare("select * from duels where kind = 'replay-fork'").all()).toEqual([]);
  db.exec("drop trigger fail_fork");
  makeWorker = () => {
    const w = new ForkWorker(), view = w.view.bind(w);
    w.view = async seat => {
      if (db.prepare("select id from duels where kind = 'replay-fork'").get()) throw new Error("Registration failed");
      return view(seat);
    };
    return w;
  };
  const failed = await post({ op: "replay-fork", ...request() }); expect(failed.response.status).toBe(503);
  expect(db.prepare("select status from duels where kind = 'replay-fork'").get()).toEqual({ status: "cancelled" });
  expect(workers.every(w => !w.running)).toBe(true); expect(createDuelService(db).get(slug, owner.guildId).status).toBe("interrupted");
});
it("bounds a stuck detached worker and leaves no stored fork", async () => {
  await host.close(); startHost({ forkTimeoutMs: 20 });
  makeWorker = () => { const w = new ForkWorker(); w.create = async () => new Promise(() => {}); return w; };
  const result = await post({ op: "replay-fork", ...request() });
  expect(result.response.status).toBe(503); expect(result.body.code).toBe("ENGINE_BUSY");
  expect(workers[0]!.running).toBe(false); expect(db.prepare("select * from replay_fork_requests").all()).toEqual([]);
});
it.each([0, 1, 2, 3])("binds views, answers and announcement search to acting seat %s", async seat => {
  source("ffa4"); const launch = await post({ op: "replay-fork", ...request() }); expect(launch.response.status).toBe(200);
  const forkSlug = launch.body.slug, worker = workers[0]!; worker.promptSeat = seat; worker.announce = true; worker.pending = seat;
  const view = await post({ op: "view", slug: forkSlug, as: seat, reveal: false });
  expect(view.body).toMatchObject({ mySeat: 0, fork: { actingSeat: seat, revealHands: false }, engine: { prompt: { seat, kind: "announce-card" } } });
  expect(view.body.engine.seats.filter((s: any) => s.hand[0].code !== undefined).map((s: any) => s.seat)).toEqual([seat]);
  const binding = { slug: forkSlug, as: seat, promptId: "p2", revision: 2 };
  expect((await post({ op: "cards", query: "Card", ...binding })).response.status).toBe(200);
  for (const bad of [{ as: (seat + 1) % 4 }, { promptId: "old" }, { revision: 1 }, { as: 4 }, { playerId: 63, userId: 103 }]) {
    expect((await post({ op: "cards", query: "Card", ...binding, ...bad })).response.status).toBeGreaterThanOrEqual(400);
  }
  expect((await post({ op: "respond", slug: forkSlug, as: seat, command: { promptId: "old", revision: 2, answer: {} } })).response.status).toBe(409);
  expect((await post({ op: "respond", slug: forkSlug, as: seat, command: { promptId: "p2", revision: 2, answer: { card: 100 } } })).response.status).toBe(200);
  expect(worker.revision).toBe(3);
});
it("recovers and restarts from its copied prefix after source deletion with all seats Manual", async () => {
  source("ffa4"); const result = await post({ op: "replay-fork", ...request(3) }); expect(result.response.status).toBe(200);
  const forkSlug = result.body.slug;
  await post({ op: "respond", slug: forkSlug, command: { promptId: "p3", revision: 3, answer: { choice: "next" } } });
  db.prepare("delete from duels where web_slug = ?").run(slug); await host.close(); startHost();
  const recovered = await post({ op: "view", slug: forkSlug }); expect(recovered.body.engine.revision).toBe(4);
  const restart = await post({ op: "fork-restart", slug: forkSlug }); expect(restart.response.status).toBe(200);
  expect(restart.body.engine.revision).toBe(3); expect(restart.body.fork.manualSeats).toEqual([0, 1, 2, 3]);
  expect(createReplayForkService(db).privateState(forkSlug, owner).commands).toHaveLength(7);
  expect((await post({ op: "fork-restart", slug: forkSlug, playerId: 62, userId: 102 })).response.status).toBe(404);
  expect((await post({ op: "view", slug: forkSlug, userId: 102 })).response.status).toBe(404);
  expect((await post({ op: "fork-cancel", slug: forkSlug })).response.status).toBe(200);
  expect(createDuelService(db).get(forkSlug, owner.guildId).status).toBe("cancelled");
  expect((await post({ op: "fork-restart", slug: forkSlug })).response.status).toBe(200);
});
it("rejects fork admission/series operations and rejects acting seats on real play", async () => {
  const launch = await post({ op: "replay-fork", ...request() }); expect(launch.response.status).toBe(200);
  for (const op of ["start", "ready", "unready", "deck", "validate-deck", "add-bot", "opening-pick", "opening-choose", "series-first", "series-side", "series-ready", "series-unready"]) {
    expect((await post({ op, slug: launch.body.slug })).response.status).toBe(409);
  }
  for (const op of ["view", "respond", "chain-mode", "cards"]) {
    expect((await post({ op, slug, playerId: 64, userId: 201, as: 1 })).response.status).toBe(400);
  }
});

it("refuses a changed source or revoked owner during the detached run", async () => {
  const before = sourceRows(), input = request();
  makeWorker = () => {
    const w = new ForkWorker(), create = w.create.bind(w);
    w.create = async options => { await create(options); db.prepare("update duels set name = 'Changed' where web_slug = ?").run(slug); };
    return w;
  };
  expect((await post({ op: "replay-fork", ...input })).body.code).toBe("SOURCE_CHANGED");
  expect(db.prepare("select * from replay_fork_requests").all()).toEqual([]);
  expect(sourceRows().slice(1)).toEqual(before.slice(1)); expect(workers[0]!.running).toBe(false);
  makeWorker = () => {
    const w = new ForkWorker(), create = w.create.bind(w);
    w.create = async options => { await create(options); vi.stubEnv("OWNER_USER_IDS", ""); };
    return w;
  };
  const result = await post({ op: "replay-fork", ...request() });
  expect(result.response.status).toBe(404); expect(result.body.code).toBe("ACCESS_DENIED");
  expect(db.prepare("select * from replay_fork_requests").all()).toEqual([]); expect(workers.every(w => !w.running)).toBe(true);
});
it("refuses unsequenced old losses instead of applying the source final losses to a prefix", async () => {
  db.prepare("update duels set setup_json = json_set(setup_json, '$.surrenderedSeats', json('[1]')) where web_slug = ?").run(slug);
  expect((await post({ op: "replay-fork", ...request(0) })).body.code).toBe("NOT_PLAYABLE"); expect(workers).toHaveLength(0);
});
it("limits active forks, permits exact retries at the limit, and allows a new fork after cancel", async () => {
  const input = request(); let first: any;
  for (let i = 0; i < 4; i++) {
    const result = await post({ op: "replay-fork", ...input, requestId: `limit-${i}` });
    expect(result.response.status).toBe(200); first ??= result.body;
  }
  expect((await post({ op: "replay-fork", ...input, requestId: "limit-4" })).body.code).toBe("FORK_LIMIT");
  expect((await post({ op: "replay-fork", ...input, requestId: "limit-0" })).body.slug).toBe(first.slug);
  await post({ op: "fork-cancel", slug: first.slug });
  expect((await post({ op: "replay-fork", ...input, requestId: "limit-4" })).response.status).toBe(200);
});
it("keeps the fork's previous journal and worker if restart validation fails", async () => {
  const launch = await post({ op: "replay-fork", ...request() });
  const forkSlug = launch.body.slug, before = createReplayForkService(db).privateState(forkSlug, owner);
  makeWorker = () => { const w = new ForkWorker(); w.revision = 90; return w; };
  expect((await post({ op: "fork-restart", slug: forkSlug })).body.code).toBe("REPLAY_MISMATCH");
  expect(createReplayForkService(db).privateState(forkSlug, owner)).toEqual(before);
  expect(workers[0]!.running).toBe(true); expect(workers[1]!.running).toBe(false);
});
it("does not commit after a detached worker completes past the deadline", async () => {
  await host.close(); startHost({ forkTimeoutMs: 20 });
  let complete!: () => void;
  makeWorker = () => {
    const w = new ForkWorker(), create = w.create.bind(w);
    w.create = async options => { await create(options); await new Promise<void>(resolve => { complete = resolve; }); };
    return w;
  };
  expect((await post({ op: "replay-fork", ...request() })).body.code).toBe("ENGINE_BUSY");
  complete(); await new Promise(resolve => setTimeout(resolve, 10));
  expect(db.prepare("select * from replay_fork_requests").all()).toEqual([]);
  expect(workers[0]!.running).toBe(false);
});
it("binds fork chain-mode changes to the current revision and optional prompt", async () => {
  const launch = await post({ op: "replay-fork", ...request() }), forkSlug = launch.body.slug;
  const command = { op: "chain-mode", slug: forkSlug, as: 1, mode: "off", revision: 2 };
  expect((await post({ ...command, revision: 1 })).response.status).toBe(409);
  expect((await post({ ...command, promptId: "p2" })).response.status).toBe(409);
  expect((await post({ ...command, revision: undefined })).response.status).toBe(400);
  const result = await post(command); expect(result.response.status).toBe(200);
  expect(result.body.fork).toMatchObject({ actingSeat: 1, chainModes: { 0: "always", 1: "off" } });
});
