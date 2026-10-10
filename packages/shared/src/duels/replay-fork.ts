import type { DuelChainMode, DuelRoom } from "./index.js";
import type { ReplayCursor } from "./replay.js";

/** Private persisted origin. Names are display metadata, never source player/user IDs or access grants. */
export interface ForkOrigin {
  sourceSlug: string;
  sourceVersion: string;
  frameId: string;
  /** Visible replay step at the checkpoint. Not a journal count or engine revision. */
  step: number;
  /** Number of copied ordered commands, including private no-op changes. Not the last seq or revision. */
  prefixCount: number;
  /** SHA-256 of the copied prefix, as 64 lowercase hex characters. */
  prefixHash: string;
  sourceSeats: Array<{ seat: number; displayName: string | null }>;
}

/** Private setup_json.replayFork. The persisted duel kind is the authority; this object alone is no fork mark. */
export interface ReplayForkSetup {
  /** Application users.id. Never players.id, a Clerk ID or a Discord ID. Recheck current owner access separately. */
  ownerUserId: number;
  control: "all-manual";
  origin: ForkOrigin;
}

export interface ReplayForkRequest {
  cursor: ReplayCursor;
  sourceVersion: string;
  requestId: string;
}

/** Creator identity stays at seat 0 for room.mySeat and ws tokens. Only the action/view seat changes. */
export interface ReplayForkControl {
  identitySeat: 0;
  actingSeat: number;
  manualSeats: number[];
  /** Creator-safe display metadata. Never return the private prefix count/hash or source player IDs. */
  origin: {
    sourceSlug: string;
    sourceFrameId: string;
    sourceStep: number;
    sourceSeats: Array<{ seat: number; displayName: string | null }>;
  };
  /**
   * Defaults to true. A creator-authorized fork view with reveal=1 fills every
   * engine.seats[].hand and .extra; reveal=0 uses the acting seat's normal projection.
   * Set cards and private logs/events still use acting-seat visibility. This grants
   * no source access. Recheck current owner and saved creator on every view request.
   */
  revealHands: boolean;
  /** Current modes for living seats, including pending-loss seats until eliminated. Default changes are journaled after the prefix. */
  chainModes: Record<number, DuelChainMode>;
}

export interface ReplayForkResult {
  slug: string;
  sourceFrameId: string;
  initialSeat: number;
  /** Acting-seat view plus fork control, returned only to the authorized creator. mySeat stays 0. */
  room: DuelRoom;
}

export const REPLAY_CURSOR_MAX_LENGTH = 4096;
export const REPLAY_SOURCE_VERSION_MAX_LENGTH = 256;
export const REPLAY_FORK_REQUEST_ID_MAX_LENGTH = 128;
export const REPLAY_SOURCE_SLUG_MAX_LENGTH = 128;
export const REPLAY_FRAME_ID_MAX_LENGTH = 128;
export const REPLAY_SOURCE_DISPLAY_NAME_MAX_LENGTH = 100;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function boundedToken(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength && /^[\x21-\x7e]+$/.test(value);
}

/** Syntax only. The host must check access, source version, cursor seal/binding and retry conflicts. */
export function isReplayForkRequest(value: unknown): value is ReplayForkRequest {
  return isRecord(value)
    && Object.keys(value).every((key) => key === "cursor" || key === "sourceVersion" || key === "requestId")
    && boundedToken(value.cursor, REPLAY_CURSOR_MAX_LENGTH)
    && boundedToken(value.sourceVersion, REPLAY_SOURCE_VERSION_MAX_LENGTH)
    && typeof value.requestId === "string"
    && value.requestId.length <= REPLAY_FORK_REQUEST_ID_MAX_LENGTH
    && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value.requestId);
}

/** Shape only. Storage must also check the format's seat count and preserve creator/origin on each setup write. */
export function isReplayForkSetup(value: unknown): value is ReplayForkSetup {
  if (!isRecord(value) || !hasExactKeys(value, ["ownerUserId", "control", "origin"])
    || !Number.isSafeInteger(value.ownerUserId) || (value.ownerUserId as number) <= 0
    || value.control !== "all-manual" || !isRecord(value.origin)) return false;
  const origin = value.origin;
  return hasExactKeys(origin, ["sourceSlug", "sourceVersion", "frameId", "step", "prefixCount", "prefixHash", "sourceSeats"])
    && boundedToken(origin.sourceSlug, REPLAY_SOURCE_SLUG_MAX_LENGTH)
    && boundedToken(origin.sourceVersion, REPLAY_SOURCE_VERSION_MAX_LENGTH)
    && boundedToken(origin.frameId, REPLAY_FRAME_ID_MAX_LENGTH)
    && Number.isSafeInteger(origin.step) && (origin.step as number) >= 0
    && Number.isSafeInteger(origin.prefixCount) && (origin.prefixCount as number) >= 0
    && typeof origin.prefixHash === "string" && /^[a-f0-9]{64}$/.test(origin.prefixHash)
    && Array.isArray(origin.sourceSeats) && origin.sourceSeats.length >= 2 && origin.sourceSeats.length <= 4
    && Array.from(origin.sourceSeats).every((entry, index) => isRecord(entry) && entry.seat === index
      && hasExactKeys(entry, ["seat", "displayName"])
      && (entry.displayName === null || (typeof entry.displayName === "string" && entry.displayName.length <= REPLAY_SOURCE_DISPLAY_NAME_MAX_LENGTH)));
}
