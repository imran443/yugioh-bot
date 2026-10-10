import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { assertOwnerReplaySourceAccess, assertReplayForkAccess, resolveOwnerPlayer, ReplayAccessError,
  type OwnerPlayerActor } from "@yugidraft/shared/access/owner-access";
import { createDuelService, createReplayForkService, hashReplayForkPrefix, ReplayForkStorageError,
  type DuelPrivateState } from "@yugidraft/shared/services";
import { isReplayForkRequest, type DuelCommand, type DuelEngineView, type DuelRoom, type DuelSession, type ReplayForkRequest,
  type ReplayForkResult, type ReplaySource, type ReplayErrorCode } from "@yugidraft/shared/duels";
import { runJournalPrefix, type JournalResources, type JournalRunResult } from "./journal-runner.js";
import { replayBuildError, replayHasUnsequencedLoss } from "./replay-builder.js";
import { replayFrameId, replaySourceVersion, resolveReplayCursor, ReplayCursorError, type ReplayCursorCodec } from "./replay-cursor.js";
import type { DuelGameWorker } from "./worker-client.js";

export const REPLAY_FORK_TIMEOUT_MS = 20_000;
export const REPLAY_FORK_ACTIVE_LIMIT = 4;
const MAX_DETACHED_FORKS = 2;

export class ReplayForkLaunchError extends Error {
  readonly status: number;
  constructor(message: string, readonly code: ReplayErrorCode) {
    super(message); this.status = code === "INVALID_CURSOR" ? 400 : code === "FORK_LIMIT" ? 429 : code === "ENGINE_BUSY" ? 503 : 409;
  }
}

interface ForkLaunchOptions {
  db: Database.Database;
  codec: ReplayCursorCodec;
  sourceOf: (state: DuelPrivateState) => ReplaySource;
  resourcesOf: (state: DuelPrivateState) => JournalResources;
  /** Recorder is disabled until persistence. The closure supplies the new fork ID after commit. */
  createWorker: (duelId: () => number | undefined) => DuelGameWorker;
  /** All engine reads finish before commit. Handoff has no asynchronous failure window. */
  register: (session: DuelSession, worker: DuelGameWorker, views: DuelEngineView[]) => DuelRoom;
  remove: (slug: string, worker: DuelGameWorker) => Promise<void>;
  room: (slug: string, actor: OwnerPlayerActor) => Promise<DuelRoom>;
  timeoutMs?: number;
}

/** Launch and restart own their detached worker until successful handoff. Source data is always read-only. */
export function createReplayForkLauncher(options: ForkLaunchOptions) {
  const { db } = options, store = createReplayForkService(db), duels = createDuelService(db);
  let pending = 0;
  const owners = new Set<number>();
  const activeCount = (actor: OwnerPlayerActor, userId: number) => db.prepare<[string, number], { count: number }>(`select count(*) as count from duels
    where guild_id = ? and kind = 'replay-fork' and status = 'active'
    and json_extract(setup_json, '$.replayFork.ownerUserId') = ?`).get(actor.guildId, userId)!.count;
  const reserve = (actor: OwnerPlayerActor, enforceActive: boolean) => {
    const owner = resolveOwnerPlayer(db, actor);
    if (!owner) throw new ReplayAccessError();
    const count = activeCount(owner, owner.userId);
    if (owners.has(owner.userId) || (enforceActive && count >= REPLAY_FORK_ACTIVE_LIMIT)) {
      throw new ReplayForkLaunchError("Replay fork limit reached. Cancel a fork and try again.", "FORK_LIMIT");
    }
    if (pending >= MAX_DETACHED_FORKS) throw new ReplayForkLaunchError("Replay fork workers are busy.", "ENGINE_BUSY");
    pending++; owners.add(owner.userId);
    return () => { pending--; owners.delete(owner.userId); };
  };

  async function detached(actor: OwnerPlayerActor, state: DuelPrivateState, prefixCount: number,
    target: { revision: number } | undefined, save: (defaults: Array<{ seat: number; command: DuelCommand }>) => { session: DuelSession; reused: boolean },
    enforceActive: boolean, restore?: () => void): Promise<DuelRoom> {
    const release = reserve(actor, enforceActive);
    let worker: DuelGameWorker | undefined, committed: DuelSession | undefined, recorderId: number | undefined;
    let expired = false, handedOff = false, timer: ReturnType<typeof setTimeout> | undefined;
    const check = () => { if (expired) throw new ReplayForkLaunchError("Replay fork engine timed out.", "ENGINE_BUSY"); };
    const work = async () => {
      const source = options.sourceOf(state);
      const result: JournalRunResult = await runJournalPrefix({ source, resources: options.resourcesOf(state), prefixCount, target,
        createWorker: () => (worker = options.createWorker(() => recorderId)) });
      check();
      if (result.views.public.result || !result.views.public.seats.some(s => !s.eliminated)) {
        throw new ReplayForkLaunchError("This checkpoint has no playable engine state.", "NOT_PLAYABLE");
      }
      if (!worker!.setChainMode) throw new ReplayForkLaunchError("This engine has no response-window control.", "ENGINE_UNAVAILABLE_FOR_SOURCE");
      const defaults: Array<{ seat: number; command: DuelCommand }> = [];
      for (const seat of result.views.public.seats.filter(s => !s.eliminated).map(s => s.seat)) {
        const before = await worker!.view(seat); check();
        await worker!.setChainMode(seat, "always"); check();
        defaults.push({ seat, command: { promptId: "chain-mode:always", revision: before.revision, answer: {} } });
      }
      const views: DuelEngineView[] = [];
      for (const seat of source.session.seats) {
        views.push(await worker!.view(seat.seat)); check();
      }
      if (views.some(view => view.result)) throw new ReplayForkLaunchError("This checkpoint has no playable engine state.", "NOT_PLAYABLE");
      check();
      const saved = save(defaults);
      if (saved.reused) {
        await worker!.close(); worker = undefined;
        check(); return options.room(saved.session.slug, actor);
      }
      committed = saved.session; recorderId = committed.id;
      check();
      const room = options.register(committed, worker!, views); check();
      assertReplayForkAccess(db, committed.slug, actor);
      handedOff = true;
      return room;
    };
    try {
      return await Promise.race([work(), new Promise<never>((_, reject) => {
        timer = setTimeout(() => { expired = true; reject(new ReplayForkLaunchError("Replay fork engine timed out.", "ENGINE_BUSY")); },
          options.timeoutMs ?? REPLAY_FORK_TIMEOUT_MS);
      })]);
    } catch (error) {
      if (error instanceof ReplayAccessError || error instanceof ReplayForkLaunchError || error instanceof ReplayCursorError
        || error instanceof ReplayForkStorageError) throw error;
      if (error instanceof Error && "code" in error && error.code === "ENGINE_UNAVAILABLE_FOR_SOURCE") {
        throw new ReplayForkLaunchError("The exact source engine resources are unavailable.", "ENGINE_UNAVAILABLE_FOR_SOURCE");
      }
      const failure = replayBuildError(error);
      throw new ReplayForkLaunchError(failure.message, failure.code);
    } finally {
      clearTimeout(timer);
      if (!handedOff) {
        if (worker) { try { await worker.close(); } catch { /* Worker already exited. */ } }
        if (committed) {
          await options.remove(committed.slug, worker!);
          if (restore) restore();
          else {
            // Cleanup still works after access revocation. Only this new marked row is changed.
            db.prepare(`update duels set status = 'cancelled', ended_at = datetime('now'), archived_at = datetime('now'),
              clock_json = null, result_reason = 'Fork launch failed', winner_player_id = null, winner_seat = null
              where id = ? and kind = 'replay-fork' and status = 'active'`).run(committed.id);
          }
        }
      }
      release();
    }
  }

  return {
    async launch(slug: string, actor: OwnerPlayerActor, request: ReplayForkRequest): Promise<ReplayForkResult> {
      if (!resolveOwnerPlayer(db, actor)) throw new ReplayAccessError();
      if (!isReplayForkRequest(request)) throw new ReplayForkLaunchError("Invalid replay fork request.", "INVALID_CURSOR");
      const cursorDigest = createHash("sha256").update(request.cursor).digest("hex");
      const retry = store.retry({ actor, requestId: request.requestId, sourceSlug: slug, sourceVersion: request.sourceVersion, cursorDigest });
      if (retry) {
        const room = await options.room(retry.session.slug, actor);
        assertReplayForkAccess(db, retry.session.slug, actor);
        return { slug: room.session.slug, sourceFrameId: room.fork!.origin.sourceFrameId, initialSeat: room.fork!.actingSeat, room };
      }
      assertOwnerReplaySourceAccess(db, slug, actor);
      const state = duels.privateState(slug, actor.guildId), source = options.sourceOf(state);
      if (!["completed", "interrupted"].includes(state.session.status) || replayHasUnsequencedLoss(source)) {
        throw new ReplayForkLaunchError("This source has no safe playable checkpoint.", "NOT_PLAYABLE");
      }
      const claims = resolveReplayCursor(options.codec, request.cursor, source);
      if (claims.sourceVersion !== request.sourceVersion) throw new ReplayCursorError("SOURCE_CHANGED");
      if (claims.frameId !== replayFrameId(claims.sourceVersion, claims.step)) throw new ReplayCursorError("INVALID_CURSOR");
      const origin = { sourceSlug: slug, sourceVersion: claims.sourceVersion, frameId: claims.frameId, step: claims.step,
        prefixCount: claims.prefixCount, prefixHash: hashReplayForkPrefix(source.commands.slice(0, claims.prefixCount)),
        sourceSeats: source.session.seats.map(s => ({ seat: s.seat, displayName: s.displayName })) };
      const room = await detached(actor, state, claims.prefixCount, { revision: claims.revision }, defaults => db.transaction(() => {
        const savedRetry = store.retry({ actor, requestId: request.requestId, sourceSlug: slug, sourceVersion: request.sourceVersion, cursorDigest });
        if (savedRetry) return savedRetry;
        assertOwnerReplaySourceAccess(db, slug, actor);
        if (claims.sourceVersion !== replaySourceVersion(options.sourceOf(duels.privateState(slug, actor.guildId)))) {
          throw new ReplayCursorError("SOURCE_CHANGED");
        }
        const owner = resolveOwnerPlayer(db, actor)!;
        if (activeCount(owner, owner.userId) >= REPLAY_FORK_ACTIVE_LIMIT) {
          throw new ReplayForkLaunchError("Replay fork limit reached.", "FORK_LIMIT");
        }
        const saved = store.create({ actor, requestId: request.requestId, cursorDigest, source, origin });
        if (!saved.reused) for (const { seat, command } of defaults) duels.recordCommand(saved.session.slug, actor.guildId, seat, command, null);
        return saved;
      }).immediate(), true);
      return { slug: room.session.slug, sourceFrameId: claims.frameId, initialSeat: room.fork!.actingSeat, room };
    },
    async restart(slug: string, actor: OwnerPlayerActor): Promise<DuelRoom> {
      assertReplayForkAccess(db, slug, actor);
      const state = store.privateState(slug, actor), sourceVersion = replaySourceVersion(options.sourceOf(state));
      const count = state.setup!.replayFork!.origin.prefixCount;
      let undo: (() => void) | undefined;
      return detached(actor, state, count, undefined, defaults => db.transaction(() => {
        const current = store.privateState(slug, actor);
        if (sourceVersion !== replaySourceVersion(options.sourceOf(current))) throw new ReplayCursorError("SOURCE_CHANGED");
        const owner = resolveOwnerPlayer(db, actor)!;
        if (current.session.status !== "active" && activeCount(owner, owner.userId) >= REPLAY_FORK_ACTIVE_LIMIT) {
          throw new ReplayForkLaunchError("Replay fork limit reached.", "FORK_LIMIT");
        }
        // Keep the previous branch and final board if the replacement worker cannot be registered.
        const row = db.prepare("select * from duels where id = ?").get(state.session.id) as Record<string, unknown>;
        const journal = db.prepare("select * from duel_commands where duel_id = ? order by seq").all(state.session.id) as Array<Record<string, unknown>>;
        undo = () => db.transaction(() => {
          const columns = Object.keys(row).filter(key => key !== "id");
          db.prepare(`update duels set ${columns.map(key => `${key} = ?`).join(", ")} where id = ?`)
            .run(...columns.map(key => row[key]), state.session.id);
          db.prepare("delete from duel_commands where duel_id = ?").run(state.session.id);
          for (const entry of journal) {
            const fields = Object.keys(entry);
            db.prepare(`insert into duel_commands (${fields.join(", ")}) values (${fields.map(() => "?").join(", ")})`)
              .run(...fields.map(key => entry[key]));
          }
        }).immediate();
        db.prepare(`delete from duel_commands where duel_id = ? and seq not in
          (select seq from duel_commands where duel_id = ? order by seq limit ?)`).run(state.session.id, state.session.id, count);
        db.prepare(`update duels set status = 'active', ended_at = null, archived_at = null, winner_player_id = null,
          winner_seat = null, result_reason = null, snapshot_public_json = null, snapshot_seat0_json = null,
          snapshot_seat1_json = null, snapshot_seats_json = null, clock_json = null, opening_json = null,
          last_activity_at = datetime('now') where id = ? and kind = 'replay-fork'`).run(state.session.id);
        for (const { seat, command } of defaults) duels.recordCommand(slug, actor.guildId, seat, command, null);
        return { session: duels.get(slug, actor.guildId), reused: false };
      }).immediate(), state.session.status !== "active", () => undo?.());
    },
  };
}
