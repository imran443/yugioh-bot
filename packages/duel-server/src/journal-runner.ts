import { createHash } from "node:crypto";
import {
  isEngineIdentity, isReplaySeed, sameEngineIdentity, seatCountFor,
  type DuelEngineView, type EngineIdentity, type ReplayJournalEntry, type ReplaySource,
} from "@yugidraft/shared/duels";
import { eliminationAtTurnEnd } from "./engine.js";
import { EngineLoopError } from "./engine-loop-error.js";
import { savedFirstTurnDraw } from "./first-turn-draw.js";
import { EngineResourceUnavailableError } from "./engine-resource-resolver.js";
import { applyWorkerJournalCommand, isPromptlessCommand } from "./journal-command.js";
import { multiScriptsFolderHash, pinnedEngineVersion, resolveMultiScriptsDirectory } from "./multi-scripts.js";
import type { DuelGameWorker, GameOptions } from "./worker-client.js";

/** Trusted server selection. The caller verifies core/card/script files (B5), never the browser. */
export interface JournalResources {
  dataDirectory: string;
  /** Manifest bundle version, before the format-specific multi overlay pin. */
  bundleVersion: string;
  /** Exact server-selected overlay. When absent, select the current overlay once, before spawning. */
  multiScriptsDirectory?: string;
  /** Verified identity of the selected resources/runtime. Required when the source recorded an identity. */
  engineIdentity?: EngineIdentity;
}

export class JournalRunnerError extends Error {
  constructor(message: string, readonly code: "INVALID_CURSOR" | "ENGINE_UNAVAILABLE_FOR_SOURCE" | "REPLAY_MISMATCH" | "ENGINE_BUSY", cause?: unknown) {
    super(message, { cause });
    this.name = "JournalRunnerError";
  }
}

export interface JournalTargetViews {
  public: DuelEngineView;
  /** Full projections in original seat order. Internal only; never return this array to an ordinary viewer. */
  seats: DuelEngineView[];
}

export interface JournalCheckpoint {
  prefixCount: number;
  actorSeat: number | null;
  input: ReplayJournalEntry | null;
  beforeRevision: number | null;
  /** Full view for checkpointSeat. Caller controls replay sanitization and per-view deltas. */
  view: DuelEngineView;
}

export interface JournalRunOptions {
  source: ReplaySource;
  resources: JournalResources;
  /** Ordered entry count; neither a stored sequence ID, revision, nor visible frame number. */
  prefixCount: number;
  /** Create a detached worker with no prefix error recorder, automation, or registration. */
  createWorker: () => DuelGameWorker;
  /** Optional replay capture, including count 0 and private no-op commands. */
  onCheckpoint?: (checkpoint: JournalCheckpoint) => void | Promise<void>;
  checkpointSeat?: number | null;
  target?: { revision: number; stateDigest?: string };
}

export interface JournalRunResult {
  worker: DuelGameWorker;
  prefixCount: number;
  views: JournalTargetViews;
  /** SHA-256 of the canonical full public/seat projections, not an engine memory snapshot. */
  stateDigest: string;
}

function mismatch(message: string): never {
  throw new JournalRunnerError(message, "REPLAY_MISMATCH");
}

/** Resolve original creation rules without deck admission checks or any live-table setup. */
function creationOptions({ source, resources, prefixCount, checkpointSeat, target }: JournalRunOptions): GameOptions {
  if (!Number.isSafeInteger(prefixCount) || prefixCount < 0 || prefixCount > source.commands.length) {
    throw new JournalRunnerError("Journal prefix count is outside the recorded input", "INVALID_CURSOR");
  }
  const { session, setup } = source;
  if (!["1v1", "tag", "ffa3", "ffa4"].includes(session.format) || !["normal", "domain"].includes(session.mode)) mismatch("Invalid saved duel format or mode");
  const count = seatCountFor(session.format);
  if (!isReplaySeed(source.seed)) mismatch("Saved seed must contain four nonzero decimal uint64 words");
  if (source.decks.length !== count || session.seats.length !== count || session.seats.some((seat, index) => seat.seat !== index)) mismatch("Saved decks and seats must have the original seat order");
  if (checkpointSeat != null && (!Number.isInteger(checkpointSeat) || checkpointSeat < 0 || checkpointSeat >= count)) {
    throw new JournalRunnerError("Invalid checkpoint projection seat", "INVALID_CURSOR");
  }
  if (target && (!Number.isSafeInteger(target.revision) || target.revision < 0
    || (target.stateDigest !== undefined && !/^[a-f0-9]{64}$/.test(target.stateDigest)))) {
    throw new JournalRunnerError("Invalid journal target", "INVALID_CURSOR");
  }
  let previousSeq = 0;
  for (const input of source.commands.slice(0, prefixCount)) {
    if (!Number.isSafeInteger(input.storedSeq) || input.storedSeq <= previousSeq) mismatch("Saved journal sequence IDs must be ordered and unique");
    previousSeq = input.storedSeq;
    if (!Number.isInteger(input.seat) || input.seat < 0 || input.seat >= count
      || !Number.isSafeInteger(input.command.revision) || input.command.revision < 0
      || typeof input.command.promptId !== "string" || !input.command.promptId) mismatch("Invalid saved journal command");
    if (eliminationAtTurnEnd(input.command.promptId)) {
      throw new JournalRunnerError("The source uses the retired turn-end surrender rule", "ENGINE_UNAVAILABLE_FOR_SOURCE");
    }
  }
  if (!resources.dataDirectory || !resources.bundleVersion || !source.bundleVersion) {
    throw new JournalRunnerError("Source engine resources are not available", "ENGINE_UNAVAILABLE_FOR_SOURCE");
  }
  const engine = session.format === "1v1" ? setup?.engine ?? (setup?.startupScripts?.length ? "pinned" : "legacy") : undefined;
  if (engine !== undefined && engine !== "legacy" && engine !== "pinned") mismatch("Invalid saved 1v1 engine choice");
  if (setup?.startupScripts !== undefined && (!Array.isArray(setup.startupScripts) || setup.startupScripts.some(content => typeof content !== "string"))) mismatch("Invalid saved startup scripts");
  const scriptErrorMode = setup?.scriptErrorMode ?? "tolerant";
  if (scriptErrorMode !== "strict" && scriptErrorMode !== "tolerant") mismatch("Invalid saved script error policy");
  let firstTurnDraw: boolean;
  let multiScriptsDirectory: string | undefined;
  let overlayHash: string | null = null;
  try {
    firstTurnDraw = savedFirstTurnDraw(setup?.firstTurnDraw, session.mode, session.masterRule, session.format);
    if (count > 2) {
      multiScriptsDirectory = resources.multiScriptsDirectory ?? resolveMultiScriptsDirectory(resources.dataDirectory) ?? undefined;
      if (!multiScriptsDirectory) throw new Error("The source multi overlay is not available");
      overlayHash = multiScriptsFolderHash(multiScriptsDirectory);
    }
  } catch (error) {
    throw new JournalRunnerError(error instanceof Error ? error.message : "Source engine rules are not available", "ENGINE_UNAVAILABLE_FOR_SOURCE", error);
  }
  if (source.bundleVersion !== pinnedEngineVersion(resources.bundleVersion, count, overlayHash)) {
    throw new JournalRunnerError("The engine resource version changed after this game was played", "ENGINE_UNAVAILABLE_FOR_SOURCE");
  }
  const coreFamily = count > 2 ? "multi" : engine;
  for (const identity of [source.engineIdentity, resources.engineIdentity]) {
    if (identity != null && (!isEngineIdentity(identity) || identity.coreFamily !== coreFamily || identity.mode !== session.mode
      || identity.multiOverlayHash !== overlayHash)) {
      throw new JournalRunnerError("The engine identity does not match the source rules or selected resources", "ENGINE_UNAVAILABLE_FOR_SOURCE");
    }
  }
  if (source.engineIdentity !== null && (!resources.engineIdentity || !sameEngineIdentity(source.engineIdentity, resources.engineIdentity))) {
    throw new JournalRunnerError("The exact recorded engine identity is not available", "ENGINE_UNAVAILABLE_FOR_SOURCE");
  }
  return {
    mode: session.mode, decks: structuredClone(source.decks), seed: [...source.seed], dataDirectory: resources.dataDirectory,
    masterRule: session.masterRule, settings: structuredClone(session.settings), firstTurnDraw, scriptErrorMode,
    ...(resources.engineIdentity ? { engineIdentity: resources.engineIdentity } : {}),
    ...(engine ? { engine } : { format: session.format, multiScriptsDirectory }),
    ...(setup?.startupScripts?.length ? { startupScripts: setup.startupScripts.map((content, index) => ({ name: `startup-${index}.lua`, content })) } : {}),
  };
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, entry]) => [key, canonical(entry)]));
}

/** The caller owns the successful worker and its later cleanup. Every failure after spawn closes it. */
export async function runJournalPrefix(options: JournalRunOptions): Promise<JournalRunResult> {
  const created = creationOptions(options); // Check rules/resources/count before allocating a worker.
  let worker: DuelGameWorker;
  try { worker = options.createWorker(); }
  catch (error) { throw new JournalRunnerError(error instanceof Error ? error.message : "Could not create an engine worker", "ENGINE_BUSY", error); }
  let stage = "engine";
  try {
    await worker.create(created);
    const capture = async (prefixCount: number, input: ReplayJournalEntry | null, beforeRevision: number | null) => {
      if (!options.onCheckpoint) return;
      stage = "engine";
      const view = await worker.view(options.checkpointSeat ?? null);
      stage = "capture";
      await options.onCheckpoint({ prefixCount, actorSeat: input?.seat ?? null, input, beforeRevision, view });
    };
    await capture(0, null, null);
    for (let index = 0; index < options.prefixCount; index++) {
      const input = options.source.commands[index]!;
      stage = "engine";
      const before = await worker.view(input.seat);
      if (before.revision !== input.command.revision || (!isPromptlessCommand(input.command.promptId) && before.prompt?.id !== input.command.promptId)) {
        mismatch("Journal replay did not reproduce the saved revision or prompt");
      }
      stage = "command";
      await applyWorkerJournalCommand(worker, input.seat, input.command);
      await capture(index + 1, input, before.revision);
    }
    stage = "engine";
    const views: JournalTargetViews = { public: await worker.view(null), seats: [] };
    for (let seat = 0; seat < created.decks.length; seat++) views.seats.push(await worker.view(seat));
    const stateDigest = createHash("sha256").update(JSON.stringify(canonical(views))).digest("hex");
    if (options.target && (views.public.revision !== options.target.revision
      || (options.target.stateDigest !== undefined && stateDigest !== options.target.stateDigest))) mismatch("Journal replay did not reproduce the selected target state");
    return { worker, prefixCount: options.prefixCount, views, stateDigest };
  } catch (error) {
    const code = stage === "command" && worker.running ? "REPLAY_MISMATCH" : "ENGINE_BUSY";
    try { await worker.close(); } catch { /* Keep the original failure if the worker already exited. */ }
    if (error instanceof JournalRunnerError || error instanceof EngineLoopError || stage === "capture") throw error;
    if (error instanceof EngineResourceUnavailableError) {
      throw new JournalRunnerError(error.message, error.code, error);
    }
    throw new JournalRunnerError(error instanceof Error ? error.message : "Engine worker request failed", code, error);
  }
}
