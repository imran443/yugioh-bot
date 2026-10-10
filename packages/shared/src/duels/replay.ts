import type { DuelSetup } from "../services/duels.js";
import type { DuelActorRole, DuelCommand, DuelDeck, DuelEngineView, DuelMode, DuelSession } from "./index.js";

export type ReplayVisibility = "public" | "mine";

/**
 * A sealed checkpoint token or server lookup ID. Never encode a readable journal
 * count. Bind it to the source, version, frame and exact prefix. It grants no access.
 */
export type ReplayCursor = string;

/** Replay boards have no actionable prompt, live priority or private response mode. Logs/events are perspective-specific deltas. */
export type ReplayEngineView = Omit<DuelEngineView, "prompt" | "prioritySeat" | "chainMode"> & {
  prompt: null;
  prioritySeat: null;
  chainMode?: never;
};

/** Sanitize an already authorized card/log/event projection without mutating the live view. */
export function toOrdinaryReplayView(view: DuelEngineView): ReplayEngineView {
  const { chainMode: _chainMode, ...ordinary } = view;
  return { ...ordinary, prompt: null, prioritySeat: null };
}

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
  /** Echo the requested public/mine view; include in request and cache generation keys. */
  visibility: ReplayVisibility;
  /** Echo the owner reveal request when present. Ordinary responses omit it. */
  reveal?: boolean;
  session: DuelSession;
  /** An owner with no source seat is a spectator with mySeat null and owner capabilities. */
  role: DuelActorRole;
  /** The authenticated source player's seat; camera movement never changes it. */
  mySeat: number | null;
  /** The actual server card/log/event projection, independent of the camera. */
  dataSeat: number | null;
  frames: ReplayFrameV2[];
  /** Omit for ordinary viewers. */
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

const ENGINE_IDENTITY_KEYS = [
  "version", "coreFamily", "mode", "wasmHash", "wrapperVersion", "wrapperHash", "protocolVersion",
  "cardDatabaseHash", "cardRemapsHash", "cardScriptsHash", "domainScriptHash", "multiOverlayHash", "hostRuleVersion",
] as const satisfies readonly (keyof EngineIdentity)[];

function isHash(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function isVersion(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** Validate a recorded identity, including the resources required by its mode and core family. */
export function isEngineIdentity(value: unknown): value is EngineIdentity {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const identity = value as Record<string, unknown>;
  return Object.keys(identity).length === ENGINE_IDENTITY_KEYS.length
    && ENGINE_IDENTITY_KEYS.every((key) => Object.hasOwn(identity, key))
    && identity.version === 1
    && (identity.coreFamily === "legacy" || identity.coreFamily === "pinned" || identity.coreFamily === "multi")
    && (identity.mode === "normal" || identity.mode === "domain")
    && isHash(identity.wasmHash) && isHash(identity.wrapperHash)
    && isVersion(identity.wrapperVersion) && isVersion(identity.protocolVersion) && isVersion(identity.hostRuleVersion)
    && isHash(identity.cardDatabaseHash) && isHash(identity.cardScriptsHash)
    && (identity.cardRemapsHash === null || isHash(identity.cardRemapsHash))
    && (identity.mode === "normal" ? identity.domainScriptHash === null : isHash(identity.domainScriptHash))
    && (identity.coreFamily === "multi" ? isHash(identity.multiOverlayHash) : identity.multiOverlayHash === null);
}

/** Compare validated identities by all recorded fields, independent of JSON property order. */
export function sameEngineIdentity(left: EngineIdentity, right: EngineIdentity): boolean {
  return ENGINE_IDENTITY_KEYS.every((key) => left[key] === right[key]);
}

/** Original nonzero canonical decimal uint64 words in order; validate before engine creation. Never replace the source seed. */
export type ReplaySeed = [string, string, string, string];

export function isReplaySeed(value: unknown): value is ReplaySeed {
  return Array.isArray(value) && value.length === 4
    && Array.from(value).every((word) => typeof word === "string" && /^[1-9][0-9]{0,19}$/.test(word)
      && BigInt(word) <= 18446744073709551615n);
}

/** Internal only. storedSeq is duel_commands.seq; gaps are valid. Report seq is a separate one-based ordered index. */
export interface ReplayJournalEntry {
  storedSeq: number;
  seat: number;
  command: DuelCommand;
}

/**
 * Internal source after access and input checks. session carries the original
 * mode/format/masterRule/settings; setup carries saved draw/error/startup rules.
 * Decks are in original seat order. Prefix counts count entries, even if storedSeq has gaps.
 * No clock settlement, bot drive or writes are part of reading/applying this source.
 */
export interface ReplaySource {
  session: DuelSession;
  decks: DuelDeck[];
  seed: ReplaySeed;
  /** Keep the saved compatibility field for old games. */
  bundleVersion: string;
  /** Saved engine rules only. Lift stored setup.engineIdentity to the single field below; omit fork metadata. */
  setup?: Omit<DuelSetup, "engineIdentity" | "replayFork">;
  /** The identity recorded at source start; null for old records. Never fill from today's worker. */
  engineIdentity: EngineIdentity | null;
  commands: ReplayJournalEntry[];
}

export const REPLAY_ERROR_CODES = [
  "ACCESS_DENIED",
  "ACCESS_UNAVAILABLE",
  "INVALID_CURSOR",
  "SOURCE_CHANGED",
  "REQUEST_CONFLICT",
  "ENGINE_UNAVAILABLE_FOR_SOURCE",
  "REPLAY_MISMATCH",
  "NOT_PLAYABLE",
  "FORK_LIMIT",
  "ENGINE_BUSY",
] as const;

export type ReplayErrorCode = (typeof REPLAY_ERROR_CODES)[number];

export const REPLAY_ERROR_HTTP_STATUSES = {
  ACCESS_DENIED: [401, 403, 404],
  ACCESS_UNAVAILABLE: [503],
  INVALID_CURSOR: [400],
  SOURCE_CHANGED: [409],
  REQUEST_CONFLICT: [409],
  ENGINE_UNAVAILABLE_FOR_SOURCE: [409],
  REPLAY_MISMATCH: [409],
  NOT_PLAYABLE: [409],
  FORK_LIMIT: [429],
  ENGINE_BUSY: [503],
} as const satisfies Record<ReplayErrorCode, readonly number[]>;

export interface ReplayErrorResponse {
  code: ReplayErrorCode;
  error: string;
  /** B2 sets this for ENGINE_UNAVAILABLE_FOR_SOURCE, REPLAY_MISMATCH and NOT_PLAYABLE after access checks. */
  finalBoard?: "available" | "none";
}

export function isReplayErrorCode(value: unknown): value is ReplayErrorCode {
  return typeof value === "string" && REPLAY_ERROR_CODES.some((code) => code === value);
}
