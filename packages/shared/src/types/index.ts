export interface DraftConfig {
  setNames?: string[];
  customCardIds?: number[];
  includeNames?: string[];
  excludeNames?: string[];
  packSize?: number;
  packsPerPlayer?: number;
  cardsPerPlayer?: number;
  pickSeconds?: number;
  alternatePassDirection?: boolean;
  randomizeSeats?: boolean;
  cubeCardIds?: number[];
  /** @deprecated legacy key, still read for drafts created before the rename */
  poolCardIds?: number[];

  // ----- theme mode -----
  /** Draft mode. Absent or "booster" => existing behavior. */
  mode?: "booster" | "theme";
  /** Cube ids the host allows for this draft (the "X" pool). */
  allowedCubeIds?: number[];
  /** How each player's theme is chosen. Default "player_pick". */
  themeSelection?: "host_assigned" | "random" | "player_pick";
  /** Optional explicit player -> theme map for host_assigned. */
  themeAssignments?: Record<string, number>;
  /** If true (default), every player gets a distinct cube, capping players at allowedCubeIds.length. */
  uniqueThemes?: boolean;
  /** Number of choices shown per pick. Admin-set; default 3, any X >= 2. */
  themePackSize?: number;
  /** Whether to run the Extra Deck draft phase at all. Default true. */
  extraDeckEnabled?: boolean;
  /** Extra Deck cards to draft in phase 2 (ignored when extraDeckEnabled is false). Default 15. */
  extraDeckSize?: number;
  /** If true, the (themePackSize - 1) unpicked cards are discarded each round; if false (default) they return. */
  burnUnpicked?: boolean;
}

export interface Draft {
  id: number;
  guildId: string;
  channelId: string;
  name: string;
  status: "pending" | "active" | "cancelled" | "completed";
  createdByUserId: string;
  config: DraftConfig;
  currentPackRound: number;
  currentPickStep: number;
  pickDeadlineAt: string | null;
  statusMessageId: string | null;
  webSlug?: string;
  tournamentId?: number | null;
  completeMessageId?: string | null;
}

export interface DraftPlayer {
  playerId: number;
  displayName: string;
  seatIndex?: number;
}

export interface DraftCard {
  id: number;
  draftId: number;
  waveNumber: number;
  catalogCardId: number;
  pickedByPlayerId: number | null;
}

export interface DraftPack {
  id: number;
  draftId: number;
  packRound: number;
  originSeatIndex: number;
  currentHolderSeatIndex: number;
  passDirection: number;
}

export interface DraftPick {
  id: number;
  draftId: number;
  playerId: number;
  draftCardId: number;
  waveNumber: number;
  pickStep: number;
  pickMethod?: "manual" | "auto";
  pickedAt: string;
}

export interface Tournament {
  id: number;
  guildId: string;
  name: string;
  format: "round_robin" | "single_elim";
  status: "pending" | "active" | "cancelled" | "completed";
  createdByUserId: string;
  webSlug?: string;
  deadlineAt?: string; // ISO timestamp; undefined = no deadline
  reportConfirmWindowHours?: number; // undefined = use DEFAULT_REPORT_CONFIRM_HOURS
}

export interface TournamentPlayer {
  playerId: number;
  displayName: string;
}

export interface TournamentMatch {
  id: number;
  tournamentId: number;
  matchId: number | null;
  playerOneId: number;
  playerTwoId: number | null;
  roundNumber: number;
  status: "open" | "pending_approval" | "completed";
  metadata: Record<string, unknown>;
}

export interface Card {
  ygoprodeckId: number;
  name: string;
  type: string;
  frameType: string;
  effectText: string;
  atk?: number;
  def?: number;
  attribute?: string;
  level?: number;
  imageUrl: string;
  imageUrlSmall: string;
  cardSets: Array<{ set_name: string }>;
  cachedAt: string;
  archetype?: string;
}

export type ThemePool = "main" | "extra";

export interface ThemeCard {
  catalogCardId: number;
  pool: ThemePool;
  maxCopies: number;
  source?: string;
}

export interface ThemePools {
  main: ThemeCard[];
  extra: ThemeCard[];
}

export interface Theme {
  id: number;
  guildId: string;
  name: string;
  archetype: string | null;
  banlist: string | null;
  createdByUserId: string;
}

export interface ThemeAnalysis {
  ok: boolean;
  errors: string[];
  warnings: string[];
}
