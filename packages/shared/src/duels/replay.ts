import type { DuelSetup } from "../services/duels.js";
import type { DuelActorRole, DuelCommand, DuelDeck, DuelEngineView, DuelMode, DuelSession } from "./index.js";

export type ReplayVisibility = "public" | "mine";

/**
 * A sealed checkpoint token or server lookup ID. Never encode a readable journal
 * count. Bind it to the source, version, frame and exact prefix. It grants no access.
 */
export type ReplayCursor = string;

/** Replay boards have no actionable prompt or private response mode. Logs/events are perspective-specific deltas. */
export type ReplayEngineView = Omit<DuelEngineView, "prompt" | "chainMode"> & {
  prompt: null;
  chainMode?: never;
};

/** Visible steps and revisions are not journal counts. All data perspectives use the same frame IDs. */
export type ReplayFrameV2 = {
  frameId: string;
  step: number;
  actorSeat: number | null;
  view: ReplayEngineView;
} & (
  | { kind: "opening" | "engine"; cursor: ReplayCursor | null }
  | { kind: "result"; cursor: null }
);

/** Set only after the current main owner check. It does not replace authorization on later requests. */
export interface ReplayOwnerCapabilities {
  canFork: boolean;
  privateSeats: number[];
}

export interface DuelReplayV2 {
  version: 2;
  sourceVersion: string;
  session: DuelSession;
  role: DuelActorRole;
  /** The authenticated source player's seat; camera movement never changes it. */
  mySeat: number | null;
  /** The actual server card/log/event projection, independent of the camera. */
  dataSeat: number | null;
  frames: ReplayFrameV2[];
  /** Omit for ordinary viewers. Their view.prioritySeat is null. */
  capabilities?: ReplayOwnerCapabilities;
}

/** SHA-256 hashes use 64 lowercase hex characters. No filesystem paths or archive requests cross this contract. */
export interface EngineIdentity {
  version: 1;
  coreFamily: "legacy" | "pinned" | "multi";
  mode: DuelMode;
  wasmHash: string;
  wrapperVersion: string;
  wrapperHash: string;
  protocolVersion: string;
  cardDatabaseHash: string;
  /** Null only when this resource set has no remap file. */
  cardRemapsHash: string | null;
  cardScriptsHash: string;
  /** Null in Normal mode. */
  domainScriptHash: string | null;
  /** Null for a 1v1 core. */
  multiOverlayHash: string | null;
  hostRuleVersion: string;
}

/** Original nonzero decimal uint64 words in order; validate before engine creation. Never replace the source seed. */
export type ReplaySeed = [string, string, string, string];

/** Internal only. seq is the stored sequence ID, not the array index, visible step or revision. */
export interface ReplayJournalEntry {
  seq: number;
  seat: number;
  command: DuelCommand;
}

/**
 * Internal source after access and input checks. session carries the original
 * mode/format/masterRule/settings; setup carries saved draw/error/startup rules.
 * Decks are in original seat order. Prefix counts count entries, even if seq has gaps.
 * No clock settlement, bot drive or writes are part of reading/applying this source.
 */
export interface ReplaySource {
  session: DuelSession;
  decks: DuelDeck[];
  seed: ReplaySeed;
  /** Keep the saved compatibility field for old games. */
  bundleVersion: string;
  setup?: DuelSetup;
  /** The identity recorded at source start; null for old records. Never fill from today's worker. */
  engineIdentity: EngineIdentity | null;
  commands: ReplayJournalEntry[];
}

export const REPLAY_ERROR_CODES = [
  "ACCESS_DENIED",
  "INVALID_CURSOR",
  "SOURCE_CHANGED",
  "ENGINE_UNAVAILABLE_FOR_SOURCE",
  "REPLAY_MISMATCH",
  "NOT_PLAYABLE",
  "FORK_LIMIT",
  "ENGINE_BUSY",
] as const;

export type ReplayErrorCode = (typeof REPLAY_ERROR_CODES)[number];

export const REPLAY_ERROR_HTTP_STATUSES = {
  ACCESS_DENIED: [401, 403, 404],
  INVALID_CURSOR: [400],
  SOURCE_CHANGED: [409],
  ENGINE_UNAVAILABLE_FOR_SOURCE: [409],
  REPLAY_MISMATCH: [409],
  NOT_PLAYABLE: [409],
  FORK_LIMIT: [429],
  ENGINE_BUSY: [503],
} as const satisfies Record<ReplayErrorCode, readonly number[]>;

export interface ReplayErrorResponse {
  code: ReplayErrorCode;
  error: string;
}

export function isReplayErrorCode(value: unknown): value is ReplayErrorCode {
  return typeof value === "string" && REPLAY_ERROR_CODES.some((code) => code === value);
}
