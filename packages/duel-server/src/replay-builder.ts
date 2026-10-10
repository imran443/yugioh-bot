import { chainModeOf, toOrdinaryReplayView, teamOfSeat,
  type DuelEngineView, type ReplayErrorCode, type ReplayFrameV2, type ReplaySource } from "@yugidraft/shared/duels";
import { EngineLoopError } from "./engine-loop-error.js";
import { EngineResourceUnavailableError } from "./engine-resource-resolver.js";
import { eliminationCodeOf } from "./engine.js";
import { JournalRunnerError, runJournalPrefix, type JournalResources } from "./journal-runner.js";
import { replayFrameId, replayPrefixHashes, type ReplayCursorCodec } from "./replay-cursor.js";
import type { DuelGameWorker } from "./worker-client.js";

export const REPLAY_MAX_BUILD_BYTES = 16 * 1024 * 1024;
export const REPLAY_BUILD_TIMEOUT_MS = 25_000;

export class ReplayBuildError extends Error {
  readonly status: number;
  constructor(message: string, readonly code: ReplayErrorCode) {
    super(message); this.status = code === "ENGINE_BUSY" ? 503 : 409;
  }
}

export function replayBuildError(error: unknown): ReplayBuildError {
  if (error instanceof ReplayBuildError) return error;
  if (error instanceof EngineResourceUnavailableError || (error instanceof JournalRunnerError && error.code === "ENGINE_UNAVAILABLE_FOR_SOURCE")) {
    return new ReplayBuildError(error.message, "ENGINE_UNAVAILABLE_FOR_SOURCE");
  }
  if (error instanceof JournalRunnerError && error.code !== "ENGINE_BUSY") {
    return new ReplayBuildError("Replay could not reproduce this duel. Use the saved final board if available.", "REPLAY_MISMATCH");
  }
  // Worker and filesystem errors may contain private paths. Keep the external message fixed.
  return new ReplayBuildError(error instanceof EngineLoopError ? "Replay engine stopped at its process limit." : "Replay engine is temporarily unavailable.", "ENGINE_BUSY");
}

export interface ReplayBuildOptions {
  source: ReplaySource;
  sourceVersion: string;
  resources: JournalResources;
  codec: ReplayCursorCodec;
  dataSeat: number | null;
  /** Server-authorized owner projection only; do not accept this option on the normal replay operation. */
  reveal?: boolean;
  finalView: DuelEngineView | null;
  createWorker: () => DuelGameWorker;
  maxBytes?: number;
  timeoutMs?: number;
}

/** An old host-only loss has no safe location in the prefix. Never apply final setup loss flags to early views. */
export function replayHasUnsequencedLoss(source: ReplaySource): boolean {
  return (source.setup?.surrenderedSeats ?? []).some(seat => !source.commands.some(input =>
    input.seat === seat && eliminationCodeOf(input.command.promptId) !== null));
}

/** Only hand/Extra Deck projections are combined. Set cards, private events and logs keep the selected audience. */
export function revealReplayHands(view: DuelEngineView, ownViews: DuelEngineView[]): DuelEngineView {
  return { ...view, seats: view.seats.map(seat => {
    const own = ownViews[seat.seat]?.seats.find(entry => entry.seat === seat.seat);
    return own ? { ...seat, hand: own.hand, extra: own.extra } : seat;
  }) };
}

/** Detached read-only re-run. Each call has its own projection delta positions and closes its worker. */
export async function buildReplayFrames(options: ReplayBuildOptions): Promise<ReplayFrameV2[]> {
  const { source, sourceVersion, dataSeat } = options;
  if (source.session.status !== "completed" && source.session.status !== "interrupted") {
    throw new ReplayBuildError("Replays are available after the duel ends", "NOT_PLAYABLE");
  }
  const frames: ReplayFrameV2[] = [];
  const seen = { log: 0, events: 0 };
  const maxBytes = options.maxBytes ?? REPLAY_MAX_BUILD_BYTES;
  let bytes = 2;
  let worker: DuelGameWorker | undefined;
  let expired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const playable = !replayHasUnsequencedLoss(source);
  const prefixHashes = replayPrefixHashes(source);
  const append = (view: DuelEngineView, kind: ReplayFrameV2["kind"], actorSeat: number | null, prefixCount: number) => {
    const log = view.log.filter(entry => entry.id > seen.log);
    const events = view.events.filter(entry => entry.id > seen.events);
    for (const entry of log) seen.log = Math.max(seen.log, entry.id);
    for (const entry of events) seen.events = Math.max(seen.events, entry.id);
    const step = frames.length; const frameId = replayFrameId(sourceVersion, step);
    const result = view.result?.reason === "Surrendered" ? { ...view.result, reason: "Surrender" } : view.result;
    const frame: ReplayFrameV2 = { step, frameId, kind, actorSeat,
      cursor: kind !== "result" && playable ? options.codec.seal({
        sourceId: source.session.id, sourceSlug: source.session.slug, guildId: source.session.guildId,
        sourceVersion, frameId, step, prefixCount, prefixHash: prefixHashes[prefixCount]!, revision: view.revision,
      }) : null,
      view: toOrdinaryReplayView({ ...view, log, events, result }) } as ReplayFrameV2;
    bytes += Buffer.byteLength(JSON.stringify(frame)) + 1;
    if (bytes > maxBytes) throw new ReplayBuildError("Replay exceeds the response size limit.", "ENGINE_BUSY");
    frames.push(frame);
  };
  const work = async () => {
    const result = await runJournalPrefix({ source, resources: options.resources, prefixCount: source.commands.length,
      createWorker: () => (worker = options.createWorker()), checkpointSeat: dataSeat,
      onCheckpoint: async ({ view, input, actorSeat, beforeRevision, prefixCount }) => {
        if (expired) throw new ReplayBuildError("Replay timed out.", "ENGINE_BUSY");
        if (input && chainModeOf(input.command.promptId) !== null && view.revision === beforeRevision) return;
        if (options.reveal) {
          const seats: DuelEngineView[] = [];
          for (let seat = 0; seat < source.decks.length; seat++) seats.push(seat === dataSeat ? view : await worker!.view(seat));
          view = revealReplayHands(view, seats);
        }
        append(view, view.result ? "result" : prefixCount === 0 ? "opening" : "engine", actorSeat, prefixCount);
      },
    });
    if (expired) throw new ReplayBuildError("Replay timed out.", "ENGINE_BUSY");
    const last = dataSeat === null ? result.views.public : result.views.seats[dataSeat]!;
    if (!last.result) {
      const session = source.session;
      let final = options.finalView ?? { ...last, log: [], events: [], result: { winnerSeat: session.winnerSeat,
        ...(session.format === "tag" ? { winnerTeam: session.winnerSeat === null ? null : teamOfSeat("tag", session.winnerSeat) } : {}),
        reason: session.resultReason ?? "Duel ended" } };
      // A saved final snapshot can have a host-only result. Its reveal projection is supplied by the authorized caller.
      if (options.reveal && !options.finalView) final = revealReplayHands(final, result.views.seats);
      append(final, "result", null, source.commands.length);
    }
    return frames;
  };
  try {
    return await Promise.race([work(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => { expired = true; reject(new ReplayBuildError("Replay timed out.", "ENGINE_BUSY")); }, options.timeoutMs ?? REPLAY_BUILD_TIMEOUT_MS);
    })]);
  } catch (error) { throw replayBuildError(error); }
  finally {
    clearTimeout(timer);
    if (worker?.running) { try { await worker.close(); } catch { /* The detached worker may already have exited. */ } }
  }
}

/** Keys must include source version, verified resources, auth scope, projection and reveal. Recheck access before every call. */
export class ReplayBuildCache<T = unknown> {
  private readonly entries = new Map<string, { value: T; bytes: number }>();
  private readonly pending = new Map<string, Promise<T>>();
  private totalBytes = 0;
  constructor(private readonly limits = { maxBytes: 64 * 1024 * 1024, maxEntries: 16, maxConcurrent: 2 }) {}
  get size() { return this.entries.size; }
  get bytes() { return this.totalBytes; }
  async getOrBuild(key: string, build: () => Promise<T>): Promise<T> {
    const cached = this.entries.get(key);
    if (cached) { this.entries.delete(key); this.entries.set(key, cached); return cached.value; }
    const pending = this.pending.get(key); if (pending) return pending;
    if (this.pending.size >= this.limits.maxConcurrent) throw new ReplayBuildError("Replay workers are busy. Try again shortly.", "ENGINE_BUSY");
    const job = Promise.resolve().then(build).then(value => {
      const bytes = Buffer.byteLength(JSON.stringify(value));
      if (bytes > this.limits.maxBytes) throw new ReplayBuildError("Replay exceeds the cache size limit.", "ENGINE_BUSY");
      if (this.limits.maxEntries > 0) {
        while (this.entries.size && (this.entries.size >= this.limits.maxEntries || this.totalBytes + bytes > this.limits.maxBytes)) {
          const oldest = this.entries.keys().next().value!; this.totalBytes -= this.entries.get(oldest)!.bytes; this.entries.delete(oldest);
        }
        this.entries.set(key, { value, bytes }); this.totalBytes += bytes;
      }
      return value;
    }).finally(() => { this.pending.delete(key); });
    this.pending.set(key, job); return job;
  }
  async settle(): Promise<void> { await Promise.allSettled(this.pending.values()); }
  clear(): void { this.entries.clear(); this.totalBytes = 0; }
}
