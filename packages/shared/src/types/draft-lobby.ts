import type { Draft, DraftConfig, DraftPlayer, DraftVisibility } from "./index.js";

// New web drafts use the default; missing lobbySeats in stored config stays
// legacy/unbounded and cannot auto-start. Manual starts may precede target fill.
export const DEFAULT_LOBBY_SEATS = 4;
export const MIN_LOBBY_SEATS = 2;
export const MAX_LOBBY_SEATS = 8;
export const MIN_DRAFT_START_PLAYERS = 2;
export const MANUAL_START_DELAY_MS = 5_000;
export const AUTO_START_DELAY_MS = 10_000;
export const NUDGE_COOLDOWN_MS = 60_000;
export const LOBBY_IDLE_POLL_MS = 10_000;
export const LOBBY_COUNTDOWN_POLL_MS = 1_000;

/** Validate a supplied target; callers separately allow absence for legacy drafts. */
export function isValidLobbySeats(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value)
    && value >= MIN_LOBBY_SEATS && value <= MAX_LOBBY_SEATS;
}

/** Persisted drafts columns, internal only. Timestamps are UTC ISO strings. */
export interface DraftLobbyColumns {
  lobby_revision: number;
  lobby_auto_start: 0 | 1;
  lobby_auto_held: 0 | 1;
  lobby_start_at: string | null;
  lobby_start_kind: "manual" | "auto" | null;
  lobby_start_token: string | null;
  lobby_start_revision: number | null;
  lobby_start_setup_hash: string | null;
  lobby_start_force: 0 | 1;
  lobby_start_error: string | null;
  lobby_nudged_at: string | null;
}

/** Persisted draft_players columns; acknowledgement hashes are never public. */
export interface DraftPlayerReadyColumns {
  ready_at: string | null;
  ready_setup_hash: string | null;
}

export interface LobbyStart {
  token: string;
  kind: "manual" | "auto";
  /** Server deadline, UTC ISO. Client clock expiry only triggers a refetch. */
  startsAt: string;
}

export interface LobbySnapshot {
  revision: number;
  serverNow: string;
  /** Null means a legacy, unbounded, manually started lobby. */
  targetSeats: number | null;
  joined: number;
  ready: number;
  /** All joined effective Ready humans/bots, regardless of target fill. */
  allReady: boolean;
  autoStart: {
    enabled: boolean;
    /** Sticky Stop/Hold; only explicit Resume clears it. */
    held: boolean;
    /** Full non-null target, allReady, and authoritative preflight clear. */
    eligible: boolean;
  };
  start: LobbyStart | null;
  errors: string[];
  warnings: string[];
  lastStartError: string | null;
}

/** Existing public roster/progress fields. No per-player Discord identity. */
export interface DraftPlayerProgress extends DraftPlayer {
  pickCount: number;
  finishedAt?: string;
  joinedAt: string;
}

/** Pending-only roster projection, shared by GET and lobby mutation responses. */
export interface LobbyPlayer extends DraftPlayerProgress {
  isHost: boolean;
  isYou: boolean;
  /** Determined by isTestBotDiscordId, never by the display name. */
  isBot: boolean;
  /** Effective acknowledgement of the current setup; bots are effectively ready. */
  ready: boolean;
  readyAt: string | null;
  /**
   * Pending player_pick: public claim. Pending host_assigned: host-only.
   * Random and non-host assigned views: null. Never project after pending.
   */
  cubeId: number | null;
}

export interface DraftLobbyResponse {
  lobby: LobbySnapshot;
  players: LobbyPlayer[];
}

/** Existing attachment response; these counts remain distinct rows. */
export interface DraftCubeSummary {
  id: number;
  name: string;
  archetype: string | null;
  mainCount: number;
  extraCount: number;
}

/** allowedCubes in GET: authored copies, separate from capped-reachable analysis. */
export interface DraftAllowedCube extends DraftCubeSummary {
  mainDistinct: number;
  extraDistinct: number;
  mainCopies: number;
  extraCopies: number;
  sampleImages: string[];
}

export interface DraftProgress {
  main: number;
  mainTotal: number;
  extra: number;
  /** Theme Extra is an up-to target; thin pools can finish early. */
  extraTotal: number;
}

export interface DraftResponseCard {
  id: number;
  passcode: number;
  name: string;
  type: string;
  frameType: string;
  attribute?: string;
  archetype?: string | null;
  race?: string | null;
  spellTrapType?: string | null;
  level?: number;
  effectText: string;
  atk?: number;
  def?: number;
  imageUrl: string;
  imageUrlSmall: string;
  held?: number;
  blocked?: boolean;
  forced?: boolean;
}

export interface DraftResponseSeat {
  seatIndex: number;
  playerId: number;
  displayName: string;
  hasPicked: boolean;
  isCurrentPlayer: boolean;
}

interface DraftDetailResponseBase {
  id: number;
  guildId: string;
  channelId: string | null;
  name: string;
  visibility: DraftVisibility;
  canJoin: boolean;
  /** Present only for the creator; GET /invite lazily supplies the link. */
  canManageInvite?: true;
  /** Present only for the host or an owner: the viewer may POST /cancel. A UI hint; the route checks access. */
  canCancel?: true;
  /** Ownership survives Leave; compare this with the viewer's session ID. */
  createdByUserId: number;
  /** Retains existing filtering of assignment maps and any private seeds. */
  config: DraftConfig;
  currentPackRound: number;
  currentPickStep: number;
  pickDeadlineAt?: string;
  statusMessageId?: string;
  webSlug?: string;
  createdAt: string;
  startedAt?: string;
  endedAt?: string;
  playerCount: number;
  tournamentId: number | null;
  tournamentName: string | null;
  tournamentSlug: string | null;
  canCreateTournament: boolean;
  participantPickCount?: number;
  myDeckId: number | null;
  isParticipant: boolean;
  currentPack: DraftResponseCard[];
  myPool: DraftResponseCard[];
  seats: DraftResponseSeat[];
  packRound: number;
  pickStep: number;
  timerSeconds: number;
  isMyTurn: boolean;
  passed: boolean;
  completed: boolean;
  pickSeconds: number;
  phase?: "main" | "extra";
  totalPackRounds?: number;
  currentPackSize?: number;
  boosterProgress?: DraftProgress;
  themeProgress?: DraftProgress;
  allowedCubes?: DraftAllowedCube[];
  botsEnabled: boolean;
}

export interface PendingDraftResponse extends DraftDetailResponseBase, DraftLobbyResponse {
  status: "pending";
}

export interface NonPendingDraftResponse extends DraftDetailResponseBase {
  status: Exclude<Draft["status"], "pending">;
  lobby?: never;
  players: Array<DraftPlayerProgress & { cubeId?: never }>;
}

/** GET /api/drafts/[slug]; narrowing by status gives the correct privacy shape. */
export type DraftDetailResponse = PendingDraftResponse | NonPendingDraftResponse;

/** Existing catalog diagnostics on create/update/errors. */
export interface DraftLookupDiagnostics {
  lookupLimited?: boolean;
  unknownIds?: number[];
}

/** GET /preflight; warnings are advisory, never implicit blockers. */
export interface DraftPreflightResponse {
  errors: string[];
  warnings: string[];
}

/** POST /api/drafts → 201. New web drafts default missing lobbySeats to 4. */
export interface DraftCreateRequest {
  name: string;
  visibility?: DraftVisibility;
  channelId?: string;
  config: DraftConfig;
}

export interface DraftCreateResponse extends DraftPreflightResponse, DraftLookupDiagnostics {
  id: number;
  name: string;
  status: "pending";
  visibility: DraftVisibility;
  webSlug?: string;
  /** Legacy theme creation omits config. */
  config?: DraftConfig;
}

/** PUT /api/drafts/[slug]. New editors always send revision. */
export interface DraftUpdateRequest {
  name?: string;
  config?: Partial<DraftConfig>;
  /** Legacy omission uses the revision captured before async hydration. */
  revision?: number;
}

export interface DraftUpdateResponse extends DraftPreflightResponse, DraftLookupDiagnostics {
  id: number;
  name: string;
  status: "pending";
  webSlug?: string;
  config: DraftConfig;
  lobby: LobbySnapshot;
}

/** POST /join and POST /join-bot retain their existing success bodies. */
export type DraftJoinRequest = undefined;
export interface DraftJoinResponse {
  success: true;
  playerId: number;
  displayName: string;
}
export type DraftJoinBotRequest = undefined;
export type DraftJoinBotResponse = DraftJoinResponse;

/** POST /ready → 200. Idempotent set, never a toggle. */
export interface DraftReadyRequest { ready: boolean }
export type DraftReadyResponse = DraftLobbyResponse;

/** DELETE /join → 200; host ownership is retained after self-leave. */
export type DraftLeaveRequest = undefined;
export type DraftLeaveResponse = DraftLobbyResponse;

/** DELETE /players/[playerId] → 200; path ID is scoped to this draft. */
export type DraftRemovePlayerRequest = undefined;
export type DraftRemovePlayerResponse = DraftLobbyResponse;

/** POST /start → 202, pending with a server-owned 5 s deadline. */
export interface DraftStartRequest {
  revision: number;
  /** Bypasses Ready/unclaimed fallback only, never minimum/guild/pool validation. */
  force?: boolean;
}
export type DraftStartResponse = DraftLobbyResponse;

/** POST /api/drafts/[slug] delegates to /start; absent body uses current revision. */
export type DraftCompatibilityStartRequest = Partial<DraftStartRequest> | undefined;
export type DraftCompatibilityStartResponse = DraftStartResponse;

/** DELETE /start → 200; wrong/superseded token conflicts. Stop holds auto-start. */
export interface DraftStopStartRequest { token: string }
export type DraftStopStartResponse = DraftLobbyResponse;

/** PUT /auto-start → 200. Resume held=false arms a fresh, total 10 s deadline. */
export interface DraftAutoStartRequest {
  enabled: boolean;
  held?: boolean;
  revision: number;
}
export type DraftAutoStartResponse = DraftLobbyResponse;

/** POST /claim-cube → 200, self only; uniqueness is checked atomically. */
export interface DraftClaimCubeRequest { cubeId: number }
export interface DraftClaimCubeResponse { ok: true; cubeId: number }
/** DELETE /claim-cube → 200, no body may select another player. */
export type DraftReleaseCubeRequest = undefined;
export interface DraftReleaseCubeResponse { ok: true; cubeId: null }

/** POST /cubes → 201. Host assignment still uses a complete map in root PUT. */
export type DraftAttachCubeRequest =
  | { kind: "archetype"; archetype: string }
  | { kind: "blank"; name: string }
  | { kind: "existing"; cubeId: number };
export interface DraftAttachCubeResponse { cube: DraftCubeSummary; allowedCubeIds: number[] }
/** DELETE /cubes → 200, detaches but keeps the library cube. */
export interface DraftDetachCubeRequest { cubeId: number }
export interface DraftDetachCubeResponse { ok: true; allowedCubeIds: number[] }

/** POST /nudge → 200; missing playerId posts an invite and any not-ready mentions. */
export interface DraftNudgeRequest { playerId?: number }
export interface DraftNudgeResponse { ok: true; channelId: string; nextAllowedAt: string }

/** Existing DELETE /api/drafts/[slug] cancels live drafts or deletes terminal ones. */
export interface DraftCancelResponse { id: number; name: string; status: "cancelled"; webSlug?: string }
export interface DraftDeleteResponse { deleted: true }
export type DraftCancelOrDeleteResponse = DraftCancelResponse | DraftDeleteResponse;

/** Lobby tick returns committed transitions; transports notify outside the lock. */
export interface DraftLobbyTickResult { started: Draft[]; changedSlugs: string[] }

export const DRAFT_LOBBY_ERROR_CODES = {
  INVALID_BODY: "INVALID_BODY",
  INVALID_CONFIG: "INVALID_CONFIG",
  INVALID_LOBBY_SEATS: "INVALID_LOBBY_SEATS",
  UNAUTHORIZED: "UNAUTHORIZED",
  FORBIDDEN: "FORBIDDEN",
  HOST_REQUIRED: "HOST_REQUIRED",
  NOT_JOINED: "NOT_JOINED",
  DRAFT_NOT_FOUND: "DRAFT_NOT_FOUND",
  PLAYER_NOT_FOUND: "PLAYER_NOT_FOUND",
  CUBE_NOT_FOUND: "CUBE_NOT_FOUND",
  DRAFT_NOT_PENDING: "DRAFT_NOT_PENDING",
  STALE_LOBBY: "STALE_LOBBY",
  NOT_READY: "NOT_READY",
  LOBBY_FULL: "LOBBY_FULL",
  SEAT_TARGET_TOO_SMALL: "SEAT_TARGET_TOO_SMALL",
  START_TOKEN_MISMATCH: "START_TOKEN_MISMATCH",
  TOO_FEW_PLAYERS: "TOO_FEW_PLAYERS",
  PREFLIGHT_FAILED: "PREFLIGHT_FAILED",
  CLAIM_REQUIRED: "CLAIM_REQUIRED",
  CUBE_NOT_ALLOWED: "CUBE_NOT_ALLOWED",
  CUBE_TAKEN: "CUBE_TAKEN",
  THEME_SELECTION_REQUIRED: "THEME_SELECTION_REQUIRED",
  CUBE_ALREADY_ATTACHED: "CUBE_ALREADY_ATTACHED",
  CUBE_ATTACH_CONFLICT: "CUBE_ATTACH_CONFLICT",
  SELF_REMOVAL: "SELF_REMOVAL",
  NUDGE_TARGET_INVALID: "NUDGE_TARGET_INVALID",
  NUDGE_COOLDOWN: "NUDGE_COOLDOWN",
  NUDGE_FAILED: "NUDGE_FAILED",
  GUILD_ACCESS_UNAVAILABLE: "GUILD_ACCESS_UNAVAILABLE",
} as const;

export type DraftLobbyErrorCode = typeof DRAFT_LOBBY_ERROR_CODES[keyof typeof DRAFT_LOBBY_ERROR_CODES];

/** HTTP mapping for coded lobby failures; existing uncoded errors stay supported. */
export const DRAFT_LOBBY_ERROR_STATUS = {
  INVALID_BODY: 400,
  INVALID_CONFIG: 400,
  INVALID_LOBBY_SEATS: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  HOST_REQUIRED: 403,
  NOT_JOINED: 403,
  DRAFT_NOT_FOUND: 404,
  PLAYER_NOT_FOUND: 404,
  CUBE_NOT_FOUND: 404,
  DRAFT_NOT_PENDING: 409,
  STALE_LOBBY: 409,
  NOT_READY: 409,
  LOBBY_FULL: 409,
  SEAT_TARGET_TOO_SMALL: 409,
  START_TOKEN_MISMATCH: 409,
  TOO_FEW_PLAYERS: 409,
  PREFLIGHT_FAILED: 409,
  CLAIM_REQUIRED: 409,
  CUBE_NOT_ALLOWED: 400,
  CUBE_TAKEN: 409,
  THEME_SELECTION_REQUIRED: 400,
  CUBE_ALREADY_ATTACHED: 409,
  CUBE_ATTACH_CONFLICT: 409,
  SELF_REMOVAL: 400,
  NUDGE_TARGET_INVALID: 400,
  NUDGE_COOLDOWN: 429,
  NUDGE_FAILED: 502,
  GUILD_ACCESS_UNAVAILABLE: 503,
} as const satisfies Record<DraftLobbyErrorCode, number>;

export interface DraftNotReadyErrorResponse {
  error: string;
  code: "NOT_READY";
  notReadyPlayerIds: number[];
  /** Included for player_pick; manual force keeps random fallback for these seats. */
  unclaimedPlayerIds?: number[];
}

/** Also set the HTTP Retry-After header to retryAfterSeconds. */
export interface DraftNudgeCooldownErrorResponse {
  error: string;
  code: "NUDGE_COOLDOWN";
  retryAfterSeconds: number;
}

/** Async seeding succeeded, but the pending attachment lost a race. */
export interface DraftCubeAttachConflictErrorResponse {
  error: string;
  code: "CUBE_ATTACH_CONFLICT";
  /** Cube remains saved in the library and was not attached. */
  savedCubeId: number;
}

export interface DraftLobbyGeneralErrorResponse extends DraftLookupDiagnostics {
  error: string;
  code?: Exclude<DraftLobbyErrorCode, "NOT_READY" | "NUDGE_COOLDOWN" | "CUBE_ATTACH_CONFLICT">;
  errors?: string[];
  warnings?: string[];
}

/** Discriminating code makes the special error details required for consumers. */
export type DraftLobbyErrorResponse =
  | DraftLobbyGeneralErrorResponse
  | DraftNotReadyErrorResponse
  | DraftNudgeCooldownErrorResponse
  | DraftCubeAttachConflictErrorResponse;
