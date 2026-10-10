import type { DuelScriptErrorMode } from "../duels/index.js";
import type Database from "better-sqlite3";
import { generateWebSlug } from "../util/web-slug.js";
import type {
  DuelActorRole,
  DuelBestOf,
  DuelClockState,
  DuelCommand,
  DuelDeck,
  DuelEngineView,
  DuelFirstChoice,
  DuelHistoryScope,
  DuelListItem,
  DuelMasterRule,
  DuelMode,
  DuelRoom,
  DuelRpsMove,
  DuelSeat,
  DuelSession,
  DuelSettings,
  DuelStatus,
  EngineIdentity,
  ReplayForkSetup,
  ReplayJournalEntry,
} from "../duels/index.js";
import { DEFAULT_DUEL_KIND } from "../duels/duel-kind.js";
import { isEngineIdentity } from "../duels/replay.js";
import { isReplayForkSetup } from "../duels/replay-fork.js";
import {
  clockWithServerNow,
  DEFAULT_DUEL_FORMAT,
  type DuelFormat,
  DuelSettingsError,
  isDuelFormat,
  seatCountFor,
  teamOfSeat,
  normalizeDuelClockState,
  normalizeDuelSettings,
  parseStoredDuelClock,
  parseStoredDuelSettings,
} from "../duels/settings.js";
import { randomInt, randomBytes, timingSafeEqual } from "node:crypto";
// duel-series.ts imports this module too; see the note there about the cycle.
import { createSeriesStore } from "./duel-series.js";
import { duelSeriesTournamentReadScope } from "./tournament-read-scope.js";
import { isDuelEngineChoice, type DuelEngineChoice } from "../duels/engine-switch.js";
import {
  newOpening,
  isDiceOpening,
  openingNeedsSwap,
  openingView,
  parseOpening,
  settleOpening,
  submitOpeningChoice,
  submitOpeningPick,
  swapOpeningSeats,
  DuelOpeningError,
  type DuelOpeningState,
} from "../duels/opening.js";
import { newDiceOpening, settleDiceOpening } from "../duels/dice-opening.js";

const MIN_MAIN = 40;
const MAX_MAIN = 60;
const MAX_EXTRA = 15;
const MAX_SIDE = 15;
export const PRACTICE_BOT_NAME = "Practice Bot";
const ARCHIVE_DUE_CAP = 32;
const CLOCK_DUE_CAP = 32;
const HISTORY_LIMIT = 100;
/** Other players' lobbies and active duels stay in Live tables this long after their last activity. */
export const DUEL_LIVE_IDLE_AFTER_MS = 15 * 60 * 1000;

function isTerminalStatus(status: string): status is DuelStatus {
  return status === "completed" || status === "interrupted" || status === "cancelled";
}

export function isDuelMasterRule(value: unknown): value is DuelMasterRule {
  return value === 1 || value === 2 || value === 3 || value === 4 || value === 5;
}

export function resolveMasterRule(_mode: DuelMode, value: unknown, format: DuelFormat = DEFAULT_DUEL_FORMAT): DuelMasterRule {
  const rule = value === undefined ? 5 : value;
  if (!isDuelMasterRule(rule)) {
    throw new DuelServiceError("Master rule must be 1, 2, 3, 4, or 5", 400);
  }
  // The multi-duelist core rejects the old-rule duel flags of MR1-MR4 (Debug.SetupDuelists).
  if (seatCountFor(format) > 2 && rule !== 5) {
    throw new DuelServiceError("Tag and free-for-all duels use Master Rule 5", 400);
  }
  return rule;
}

export class DuelServiceError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "DuelServiceError";
    this.status = status;
  }
}

/** Private recorded setup, kept so recovery and replay can rebuild the same engine state. */
export interface DuelSetup {
  /** Server-recorded at game start by B5 and validated on read. Never derive an old game's identity at export. */
  engineIdentity?: EngineIdentity;
  /** Server-owned creator and copied origin, validated on read. B3 adds immutable-kind storage. Never include in public sessions. */
  replayFork?: ReplayForkSetup;
  /** Resolved policy at start; older journals use tolerant recovery. */
  scriptErrorMode?: DuelScriptErrorMode;
  /** The resolved FIRST_TURN_DRAW flag at start. Recovery and replay must keep this rule. */
  firstTurnDraw?: boolean;
  startupScripts?: string[];
  scenarioId?: string;
  /** Seats that gave up (or ran out of time) in a table with more than two seats; the host plays them on autopilot. */
  surrenderedSeats?: number[];
  /** Dev scenario presets (DUEL_SCENARIOS=1): the preset the table was made from. The host rebuilds the bot rules from it. */
  presetId?: string;
  /** Seat number (as text) to bot policy name, for example `{ "1": "scripted" }`. */
  botPolicies?: Record<string, string>;
  /**
   * The engine a one-against-one duel started on (`DUEL_1V1_ENGINE`). A recover and a replay use it, so a switch of the env
   * value does not change a running duel. Absent means `legacy`: duels from before this field ran on that engine.
   */
  engine?: DuelEngineChoice;
}

export interface DuelPrivateState {
  session: DuelSession;
  decks: DuelDeck[];
  seed: string[] | null;
  bundleVersion: string | null;
  commands: ReplayJournalEntry[];
  clock: DuelClockState | null;
  setup?: DuelSetup;
}

/**
 * Final boards. `seats` holds one view per seat (any seat count). `seat0` and `seat1` are the old
 * two-seat fields; they are used for seat 0 and 1 when `seats` does not cover them.
 */
export interface DuelFinalSnapshots {
  public: DuelEngineView;
  seat0?: DuelEngineView;
  seat1?: DuelEngineView;
  seats?: DuelEngineView[];
}

export interface DuelService {
  create(input: {
    guildId: string;
    organizerPlayerId: number;
    name: string;
    mode: DuelMode;
    masterRule?: DuelMasterRule;
    settings?: unknown;
    format?: DuelFormat;
    /** Open table match options; default Best of 1, unranked. CONTRACT: stored in duels.best_of / duels.ranked. */
    bestOf?: DuelBestOf;
    ranked?: boolean;
  }): DuelSession;
  list(
    guildId: string,
    playerId: number,
    options?: { archived?: boolean; scope?: DuelHistoryScope; idleAfterMs?: number },
  ): DuelListItem[];
  get(slug: string, guildId: string): DuelSession;
  /** Claims an open human seat before any opening or series has started. Defaults to the first open seat. */
  takeSeat(slug: string, guildId: string, playerId: number, seat?: number): DuelSession;
  leave(slug: string, guildId: string, playerId: number): DuelSession;
  /** `seat` picks the empty seat (for example a Tag partner). Without it the lowest empty seat is used. */
  addPracticeBot(slug: string, guildId: string, organizerPlayerId: number, deck: DuelDeck, seat?: number): DuelSession;
  /**
   * Takes a practice bot out of its seat (organizer only, lobby only) so a human can sit there. `seat` names
   * the bot's seat; without it every practice bot at the table goes (a 1v1 table has at most one).
   */
  removePracticeBot(slug: string, guildId: string, organizerPlayerId: number, seat?: number): DuelSession;
  setDeck(slug: string, guildId: string, playerId: number, deck: DuelDeck): DuelSession;
  room(slug: string, guildId: string, playerId: number): DuelRoom;
  privateState(slug: string, guildId: string): DuelPrivateState;
  /**
   * Marks a seated player ready with the deck already in the seat (a
   * tournament game preloads the registered deck). CONTRACT: implemented by
   * the series work; the stub throws.
   */
  markReady(slug: string, guildId: string, playerId: number): DuelSession;
  markUnready(slug: string, guildId: string, playerId: number): DuelSession;
  /**
   * `organizerPlayerId` null means a system start by the duel host. CONTRACT:
   * null is allowed only for a series game (duels.series_id set).
   */
  activate(
    slug: string,
    guildId: string,
    organizerPlayerId: number | null,
    seed: string[],
    bundleVersion: string,
    clock: DuelClockState | null,
    setup?: DuelSetup,
  ): DuelSession;
  /** `touchActivity: false` journals the command without moving `last_activity_at` (a private change nobody else may see). */
  recordCommand(slug: string, guildId: string, seat: number, command: DuelCommand, clock: DuelClockState | null, options?: { touchActivity?: boolean }): void;
  complete(
    slug: string,
    guildId: string,
    winnerSeat: number | null,
    reason: string,
    snapshots?: DuelFinalSnapshots,
  ): DuelSession;
  interrupt(slug: string, guildId: string, reason: string, snapshots?: DuelFinalSnapshots): DuelSession;
  cancel(slug: string, guildId: string, organizerPlayerId: number): DuelSession;
  archive(slug: string, guildId: string, organizerPlayerId: number): DuelSession;
  archiveDue(limit: number, archiveAfterMs: number): DuelSession[];
  admit(slug: string, guildId: string, playerId: number, inviteCode: string): void;
  setSetup(slug: string, guildId: string, setup: DuelSetup | null): void;
  setClock(slug: string, guildId: string, clock: DuelClockState | null): void;
  dueClocks(now: number, limit: number): Array<{ slug: string; guildId: string }>;
  /**
   * Starts a lobby opening: 1v1 RPS or FFA dice, with all seats ready. Idempotent while an
   * opening exists. `actorPlayerId` is the player who pressed Start: the organizer of an open table, or a
   * seated player of a match game.
   */
  startOpening(slug: string, guildId: string, actorPlayerId: number, at: number): DuelOpeningState;
  /** The stored opening of a duel, or null. Private: it holds the hidden picks. */
  openingState(slug: string, guildId: string): DuelOpeningState | null;
  /** A pick of one seat (a player or the practice bot). Final once made. */
  submitOpeningPick(slug: string, guildId: string, seat: number, move: DuelRpsMove, at: number): DuelOpeningState;
  /** The winner's choice. When it ends the opening, the seats are in their final order. */
  submitOpeningChoice(slug: string, guildId: string, seat: number, choice: DuelFirstChoice, at: number): DuelOpeningState;
  /** Applies the timeouts: random picks, and "go first" for a winner who did not choose. */
  settleOpening(slug: string, guildId: string, at: number, random?: () => number): DuelOpeningState | null;
  /**
   * Drops the opening of a lobby duel, so decks, seats and the bot can change again. The host uses it when the
   * duel failed to start after the opening. Seats keep the order the opening gave them.
   */
  abortOpening(slug: string, guildId: string): void;
  /** Duels whose opening phase has timed out, or whose settled opening still waits for the duel to start. */
  dueOpenings(now: number, limit: number): Array<{ slug: string; guildId: string }>;
}

type DuelRow = {
  id: number;
  guild_id: string;
  web_slug: string;
  name: string;
  organizer_player_id: number;
  mode: string;
  master_rule: number;
  status: string;
  seed_json: string | null;
  bundle_version: string | null;
  created_at: string;
  ended_at: string | null;
  archived_at: string | null;
  last_activity_at: string | null;
  winner_player_id: number | null;
  winner_seat: number | null;
  result_reason: string | null;
  snapshot_public_json: string | null;
  snapshot_seat0_json: string | null;
  snapshot_seat1_json: string | null;
  snapshot_seats_json?: string | null;
  format?: string | null;
  setup_json?: string | null;
  settings_json: string | null;
  clock_json: string | null;
  invite_code: string | null;
  series_id: number | null;
  game_number: number | null;
  best_of: number;
  ranked: number;
  opening_json: string | null;
};


type DuelListItemRow = DuelRow & { my_seat: number | null };

type SeatRow = {
  seat: number;
  player_id: number | null;
  is_bot: number;
  display_name: string | null;
  ready: number;
  deck_json: string | null;
};

function isConstraintError(error: unknown) {
  if (!error || typeof error !== "object" || !("code" in error)) return false;
  return String(error.code).startsWith("SQLITE_CONSTRAINT");
}

export function isDuelMode(value: string): value is DuelMode {
  return value === "normal" || value === "domain";
}

function isDuelStatus(value: string): value is DuelStatus {
  return value === "lobby" || value === "active" || value === "completed" || value === "interrupted" || value === "cancelled";
}

function emptyDeck(): DuelDeck {
  return { main: [], extra: [], side: [] };
}

function assertCardCodes(codes: unknown, label: string, min: number, max: number): number[] {
  if (!Array.isArray(codes)) {
    throw new DuelServiceError(`${label} must be a list of card codes`, 400);
  }
  if (codes.length < min || codes.length > max) {
    throw new DuelServiceError(`${label} must contain between ${min} and ${max} cards`, 400);
  }
  const parsed: number[] = [];
  for (const code of codes) {
    if (typeof code !== "number" || !Number.isInteger(code) || code < 1) {
      throw new DuelServiceError(`${label} contains an invalid card code`, 400);
    }
    parsed.push(code);
  }
  return parsed;
}

export function validateDuelDeckShape(deck: DuelDeck, competitive: boolean): DuelDeck {
  const mainMin = competitive ? MIN_MAIN : 0;
  const main = assertCardCodes(deck.main, "Main deck", mainMin, MAX_MAIN);
  const extra = assertCardCodes(deck.extra, "Extra deck", 0, MAX_EXTRA);
  const side = assertCardCodes(deck.side, "Side deck", 0, MAX_SIDE);
  const normalized: DuelDeck = { main, extra, side };
  if (deck.deckMaster !== undefined) {
    if (!Number.isInteger(deck.deckMaster) || deck.deckMaster < 1) {
      throw new DuelServiceError("Deck Master must be a valid card code", 400);
    }
    normalized.deckMaster = deck.deckMaster;
  }
  return normalized;
}

function parseDeck(raw: string | null): DuelDeck | null {
  if (!raw) return null;
  let parsed: DuelDeck;
  try {
    parsed = JSON.parse(raw) as DuelDeck;
  } catch {
    throw new DuelServiceError("Saved duel deck is corrupt", 500);
  }
  if (!parsed || !Array.isArray(parsed.main) || !Array.isArray(parsed.extra) || !Array.isArray(parsed.side)) {
    throw new DuelServiceError("Saved duel deck is corrupt", 500);
  }
  return parsed;
}

function parseSeed(raw: string | null): string[] | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    const seed: string[] = [];
    for (const value of parsed) {
      if (typeof value !== "string") return null;
      seed.push(value);
    }
    return seed;
  } catch {
    return null;
  }
}

function parseEngineView(raw: string | null): DuelEngineView | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as DuelEngineView;
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.seats)) return null;
    return { ...parsed, prompt: null, prioritySeat: null };
  } catch {
    return null;
  }
}

function freezeSnapshot(
  view: DuelEngineView,
  result: { winnerSeat: number | null; winnerTeam?: number | null; reason: string },
): string {
  const frozen: DuelEngineView = { ...view, prompt: null, prioritySeat: null, result };
  return JSON.stringify(frozen);
}

function parseSeatSnapshots(raw: string | null | undefined): Array<DuelEngineView | null> {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map((entry) => {
      if (!entry || typeof entry !== "object" || !Array.isArray((entry as DuelEngineView).seats)) return null;
      return { ...(entry as DuelEngineView), prompt: null, prioritySeat: null };
    });
  } catch {
    return [];
  }
}

function isPolicyMap(value: unknown): value is Record<string, string> {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.entries(value).every(([seat, policy]) => /^\d+$/.test(seat) && typeof policy === "string" && policy.length > 0 && policy.length <= 40)
  );
}

function parseSetup(raw: string | null | undefined): DuelSetup | undefined {
  if (!raw) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const input = parsed as Record<string, unknown>;
    const setup: DuelSetup = {};
    if (isEngineIdentity(input.engineIdentity)) setup.engineIdentity = input.engineIdentity;
    if (isReplayForkSetup(input.replayFork)) setup.replayFork = input.replayFork;
    if (input.scriptErrorMode === "tolerant" || input.scriptErrorMode === "strict") setup.scriptErrorMode = input.scriptErrorMode;
    if (typeof input.firstTurnDraw === "boolean") setup.firstTurnDraw = input.firstTurnDraw;
    if (Array.isArray(input.startupScripts) && input.startupScripts.every((entry) => typeof entry === "string")) {
      setup.startupScripts = input.startupScripts as string[];
    }
    if (typeof input.scenarioId === "string") setup.scenarioId = input.scenarioId;
    if (Array.isArray(input.surrenderedSeats) && input.surrenderedSeats.every((entry) => Number.isInteger(entry) && entry >= 0)) {
      setup.surrenderedSeats = input.surrenderedSeats as number[];
    }
    if (typeof input.presetId === "string" && input.presetId) setup.presetId = input.presetId;
    if (isPolicyMap(input.botPolicies)) setup.botPolicies = input.botPolicies;
    if (isDuelEngineChoice(input.engine)) setup.engine = input.engine;
    return setup;
  } catch {
    return undefined;
  }
}

function validateSetup(setup: unknown): DuelSetup {
  if (!setup || typeof setup !== "object" || Array.isArray(setup)) {
    throw new DuelServiceError("Duel setup must be an object", 400);
  }
  const input = setup as Record<string, unknown>;
  const extra = Object.keys(input).find((key) => key !== "scriptErrorMode" && key !== "firstTurnDraw" && key !== "startupScripts" && key !== "scenarioId" && key !== "surrenderedSeats" && key !== "presetId" && key !== "botPolicies" && key !== "engine");
  if (extra) throw new DuelServiceError(`Unknown duel setup field: ${extra}`, 400);
  const out: DuelSetup = {};
  if (input.scriptErrorMode !== undefined) {
    if (input.scriptErrorMode !== "tolerant" && input.scriptErrorMode !== "strict") throw new DuelServiceError("scriptErrorMode must be tolerant or strict", 400);
    out.scriptErrorMode = input.scriptErrorMode;
  }
  if (input.firstTurnDraw !== undefined) {
    if (typeof input.firstTurnDraw !== "boolean") throw new DuelServiceError("firstTurnDraw must be a boolean", 400);
    out.firstTurnDraw = input.firstTurnDraw;
  }
  if (input.startupScripts !== undefined) {
    if (!Array.isArray(input.startupScripts) || input.startupScripts.some((entry) => typeof entry !== "string")) {
      throw new DuelServiceError("startupScripts must be a list of strings", 400);
    }
    out.startupScripts = input.startupScripts as string[];
  }
  if (input.scenarioId !== undefined) {
    if (typeof input.scenarioId !== "string" || !input.scenarioId) {
      throw new DuelServiceError("scenarioId must be a non-empty string", 400);
    }
    out.scenarioId = input.scenarioId;
  }
  if (input.surrenderedSeats !== undefined) {
    if (!Array.isArray(input.surrenderedSeats) || input.surrenderedSeats.some((entry) => !Number.isInteger(entry) || entry < 0)) {
      throw new DuelServiceError("surrenderedSeats must be a list of seat numbers", 400);
    }
    out.surrenderedSeats = input.surrenderedSeats as number[];
  }
  if (input.presetId !== undefined) {
    if (typeof input.presetId !== "string" || !input.presetId || input.presetId.length > 100) {
      throw new DuelServiceError("presetId must be a non-empty string", 400);
    }
    out.presetId = input.presetId;
  }
  if (input.botPolicies !== undefined) {
    if (!isPolicyMap(input.botPolicies)) throw new DuelServiceError("botPolicies must map seat numbers to policy names", 400);
    out.botPolicies = input.botPolicies;
  }
  if (input.engine !== undefined) {
    if (!isDuelEngineChoice(input.engine)) throw new DuelServiceError("engine must be legacy or pinned", 400);
    out.engine = input.engine;
  }
  return out;
}

function rowFormat(row: DuelRow): DuelFormat {
  const value = row.format ?? DEFAULT_DUEL_FORMAT;
  if (!isDuelFormat(value)) throw new DuelServiceError("Duel record is invalid", 500);
  return value;
}

function snapshotForRole(row: DuelRow, mySeat: number | null): DuelEngineView | null {
  if (mySeat !== null) {
    const fromList = parseSeatSnapshots(row.snapshot_seats_json)[mySeat];
    if (fromList) return fromList;
  }
  if (mySeat === 0) return parseEngineView(row.snapshot_seat0_json);
  if (mySeat === 1) return parseEngineView(row.snapshot_seat1_json);
  return parseEngineView(row.snapshot_public_json);
}

function mapSeat(row: SeatRow): DuelSeat {
  const deck = parseDeck(row.deck_json);
  const isBot = row.is_bot === 1;
  const seat: DuelSeat = {
    seat: row.seat,
    playerId: row.player_id,
    displayName: isBot ? PRACTICE_BOT_NAME : (row.display_name ?? ""),
    ready: row.ready === 1,
    isBot,
  };
  if (deck?.deckMaster) seat.deckMaster = deck.deckMaster;
  return seat;
}

export function wrapSettingsError<T>(work: () => T, status = 400): T {
  try {
    return work();
  } catch (error) {
    if (error instanceof DuelSettingsError) throw new DuelServiceError(error.message, status);
    throw error;
  }
}

export function generateInviteCode(): string {
  return randomBytes(32).toString("base64url");
}

function inviteCodeMatches(stored: string, provided: string): boolean {
  const expected = Buffer.from(stored);
  const actual = Buffer.from(provided);
  if (expected.length !== actual.length) {
    timingSafeEqual(expected, Buffer.alloc(expected.length));
    return false;
  }
  return timingSafeEqual(expected, actual);
}

function serializeClock(clock: DuelClockState | null): string | null {
  return clock ? JSON.stringify(clock) : null;
}

function rowSettings(row: DuelRow): DuelSettings {
  return wrapSettingsError(() => parseStoredDuelSettings(row.settings_json), 500);
}

function rowClock(row: DuelRow): DuelClockState | null {
  return wrapSettingsError(() => parseStoredDuelClock(row.clock_json), 500);
}

const LIST_ACCESS_SQL = `
  (
    organizer_player_id = @viewer
    or exists (select 1 from duel_seats s where s.duel_id = duels.id and s.player_id = @viewer)
    or exists (select 1 from duel_invite_grants g where g.duel_id = duels.id and g.player_id = @viewer)
    or coalesce(json_extract(settings_json, '$.visibility'), 'public') != 'private'
  )
`;


export function createDuelService(db: Database.Database, options: { rollDie?: () => number } = {}): DuelService {
  const rollDie = options.rollDie ?? (() => randomInt(1, 7));
  const selectDuelById = db.prepare<[number], DuelRow>("select * from duels where id = ?");
  const selectDuelBySlug = db.prepare<[string, string], DuelRow>("select * from duels where web_slug = ? and guild_id = ?");
  const selectSeats = db.prepare<[number], SeatRow>(
    `
      select s.seat, s.player_id, s.is_bot, s.ready, s.deck_json,
        case when s.is_bot = 1 then 'Practice Bot' else p.display_name end as display_name
      from duel_seats s
      left join players p on p.id = s.player_id
      where s.duel_id = ?
      order by s.seat
    `,
  );
  const selectCommands = db.prepare<[number], { seq: number; seat: number; command_json: string }>(
    "select seq, seat, command_json from duel_commands where duel_id = ? order by seq",
  );
  const selectPlayerGuild = db.prepare<[number, string], { ok: number }>(
    "select 1 as ok from players where id = ? and guild_id = ?",
  );
  const series = createSeriesStore(db);
  const insertDuel = db.prepare<[string, string, string, number, DuelMode, DuelMasterRule, string, string | null, DuelFormat, number, number]>(
    `
      insert into duels (guild_id, web_slug, name, organizer_player_id, mode, master_rule, status, settings_json, invite_code, format, best_of, ranked)
      values (?, ?, ?, ?, ?, ?, 'lobby', ?, ?, ?, ?, ?)
    `,
  );
  const insertSeat = db.prepare<[number, number, number]>(
    "insert into duel_seats (duel_id, seat, player_id, is_bot, ready) values (?, ?, ?, 0, 0)",
  );
  const insertBotSeat = db.prepare<[number, number, string]>(
    "insert into duel_seats (duel_id, seat, player_id, is_bot, ready, deck_json) values (?, ?, null, 1, 1, ?)",
  );
  const updateDeck = db.prepare<[string, number, number]>(
    "update duel_seats set deck_json = ?, ready = 1 where duel_id = ? and player_id = ?",
  );
  const updateReady = db.prepare<[number, number]>("update duel_seats set ready = 1 where duel_id = ? and player_id = ?");
  const updateUnready = db.prepare<[number, number]>("update duel_seats set ready = 0 where duel_id = ? and player_id = ?");
  const nextCommandSeq = db.prepare<[number], { next_seq: number }>(
    "select coalesce(max(seq), 0) + 1 as next_seq from duel_commands where duel_id = ?",
  );
  const insertCommand = db.prepare<[number, number, number, string]>(
    "insert into duel_commands (duel_id, seq, seat, command_json) values (?, ?, ?, ?)",
  );
  const insertGrant = db.prepare<[number, number]>(
    "insert or ignore into duel_invite_grants (duel_id, player_id) values (?, ?)",
  );
  const selectGrant = db.prepare<[number, number], { ok: number }>(
    "select 1 as ok from duel_invite_grants where duel_id = ? and player_id = ?",
  );
  const touchActivity = db.prepare<[number]>("update duels set last_activity_at = datetime('now') where id = ?");
  const updateSetup = db.prepare<[string | null, number]>("update duels set setup_json = ? where id = ?");
  const updateClock = db.prepare<[string | null, number]>("update duels set clock_json = ? where id = ?");
  const listLive = db.prepare<Record<string, string | number>, DuelListItemRow>(
    `
      select duels.*,
        (select s.seat from duel_seats s where s.duel_id = duels.id and s.player_id = @viewer) as my_seat
      from duels
      where guild_id = @guild
        and status in ('lobby', 'active')
        and archived_at is null
        and ${LIST_ACCESS_SQL}
        and ${duelSeriesTournamentReadScope("duels.series_id")}
        and (
          organizer_player_id = @viewer
          or exists (select 1 from duel_seats s where s.duel_id = duels.id and s.player_id = @viewer)
          or datetime(coalesce(last_activity_at, created_at)) >= datetime('now', @idle)
        )
      order by
        case when organizer_player_id = @viewer
          or exists (select 1 from duel_seats s where s.duel_id = duels.id and s.player_id = @viewer) then 0 else 1 end,
        datetime(coalesce(last_activity_at, created_at)) desc,
        id desc
    `,
  );
  const listHistory = db.prepare<Record<string, string | number>, DuelListItemRow>(
    `
      select duels.*,
        (select s.seat from duel_seats s where s.duel_id = duels.id and s.player_id = @viewer) as my_seat
      from duels
      where guild_id = @guild
        and status in ('completed', 'interrupted')
        and ${LIST_ACCESS_SQL}
        and ${duelSeriesTournamentReadScope("duels.series_id")}
        and (@all = 1 or exists (select 1 from duel_seats s where s.duel_id = duels.id and s.player_id = @viewer))
      order by datetime(coalesce(ended_at, created_at)) desc, id desc
      limit ${HISTORY_LIMIT}
    `,
  );
  const selectDue = db.prepare<[string, number], DuelRow>(
    `
      select * from duels
      where archived_at is null
        and status in ('completed', 'interrupted', 'cancelled')
        and ended_at is not null
        and datetime(ended_at) <= datetime('now', ?)
      order by datetime(ended_at) asc, id asc
      limit ?
    `,
  );
  const selectDueClocks = db.prepare<[number, number], { slug: string; guildId: string }>(
    `
      select web_slug as slug, guild_id as guildId
      from duels
      where status = 'active'
        and clock_json is not null
        and json_extract(clock_json, '$.startedAt') is not null
        and json_extract(clock_json, '$.activeSeat') >= 0
        and (
          json_extract(clock_json, '$.startedAt')
          + json_extract(clock_json, '$.remainingMs[' || json_extract(clock_json, '$.activeSeat') || ']')
        ) <= ?
      order by datetime(created_at) asc, id asc
      limit ?
    `,
  );

  const checkedClock = (clock: DuelClockState, seatCount: number): DuelClockState => {
    const stored = wrapSettingsError(() => normalizeDuelClockState(clock));
    if (stored.remainingMs.length !== seatCount) {
      throw new DuelServiceError(`clock must have ${seatCount} seats`, 400);
    }
    return stored;
  };

  const selectDueOpenings = db.prepare<[number, number], { slug: string; guildId: string }>(
    `
      select web_slug as slug, guild_id as guildId
      from duels
      where status = 'lobby'
        and opening_json is not null
        and json_extract(opening_json, '$.deadline') <= ?
      order by id asc
      limit ?
    `,
  );

  const assertPlayerGuild = (playerId: number, guildId: string) => {
    if (!selectPlayerGuild.get(playerId, guildId)) {
      throw new DuelServiceError("Player must belong to the same guild as the duel", 400);
    }
  };

  const loadDuelRow = (slug: string, guildId: string): DuelRow => {
    const row = selectDuelBySlug.get(slug, guildId);
    if (!row) throw new DuelServiceError("Duel not found", 404);
    return row;
  };

  const seatRows = (duelId: number): SeatRow[] => selectSeats.all(duelId);

  const mapSession = (row: DuelRow): DuelSession => {
    if (!isDuelMode(row.mode) || !isDuelStatus(row.status) || !isDuelMasterRule(row.master_rule)) {
      throw new DuelServiceError("Duel record is invalid", 500);
    }
    return {
      id: row.id,
      slug: row.web_slug,
      // P0 projects existing rows only. B3 must replace this with validated persisted kind/setup.
      kind: DEFAULT_DUEL_KIND,
      name: row.name,
      guildId: row.guild_id,
      organizerPlayerId: row.organizer_player_id,
      mode: row.mode,
      masterRule: row.master_rule,
      format: rowFormat(row),
      status: row.status,
      settings: rowSettings(row),
      seats: seatRows(row.id).map(mapSeat),
      createdAt: row.created_at,
      endedAt: row.ended_at,
      archivedAt: row.archived_at,
      winnerPlayerId: row.winner_player_id,
      winnerSeat: row.winner_seat ?? null,
      resultReason: row.result_reason,
      bestOf: row.best_of === 3 ? 3 : 1,
      ranked: row.ranked === 1,
      seriesId: row.series_id ?? null,
      gameNumber: row.game_number ?? null,
    };
  };

  const ownDeck = (duelId: number, playerId: number): DuelDeck | null => {
    const row = seatRows(duelId).find((seat) => seat.player_id === playerId);
    return row ? parseDeck(row.deck_json) : null;
  };

  const hasPrivateAccess = (row: DuelRow, playerId: number): boolean => {
    if (rowSettings(row).visibility !== "private") return true;
    if (row.organizer_player_id === playerId) return true;
    if (seatRows(row.id).some((seat) => seat.player_id === playerId)) return true;
    return !!selectGrant.get(row.id, playerId);
  };

  const assertRoomAccess = (row: DuelRow, playerId: number) => {
    if (!hasPrivateAccess(row, playerId)) {
      throw new DuelServiceError("Duel is invite-only", 403);
    }
  };

  /** Decks, seats and the bot are fixed once the opening runs. */
  const assertNoOpening = (row: DuelRow) => {
    if (row.opening_json) throw new DuelServiceError("The duel is about to start. Seats and decks are fixed.", 409);
  };

  const requireOpening = (row: DuelRow): DuelOpeningState => {
    const state = parseOpening(row.opening_json);
    if (!state) throw new DuelServiceError("There is no opening for this duel", 409);
    return state;
  };

  const storeOpening = (duelId: number, state: DuelOpeningState | null) => {
    db.prepare<[string | null, number]>("update duels set opening_json = ? where id = ?")
      .run(state ? JSON.stringify(state) : null, duelId);
  };

  /** The opening just settled the order: put the seats in their final order and flip the seat-indexed fields. */
  const settleOrder = (duelId: number, before: DuelOpeningState, after: DuelOpeningState): DuelOpeningState => {
    if (before.phase === "start" || after.phase !== "start") return after;
    if (isDiceOpening(after)) {
      const order = after.order;
      if (!order) throw new DuelServiceError("Dice order is not resolved", 500);
      const row = selectDuelById.get(duelId)!;
      const newSeat = (seat: number) => order.indexOf(seat);
      // Park every row above the public range, then place it without primary key collisions.
      // Player, bot, ready and deck fields all remain on the same row.
      const parked = db.prepare("update duel_seats set seat = seat + ? where duel_id = ?").run(order.length, duelId);
      if (parked.changes !== order.length) throw new DuelServiceError("Dice seat move did not park every seat", 500);
      const move = db.prepare("update duel_seats set seat = ? where duel_id = ? and seat = ?");
      let moved = 0;
      order.forEach((lobbySeat, seat) => {
        const result = move.run(seat, duelId, lobbySeat + order.length);
        if (result.changes !== 1) throw new DuelServiceError("Dice seat move did not change exactly one row", 500);
        moved += result.changes;
      });
      if (moved !== order.length) throw new DuelServiceError("Dice seat move did not place every seat", 500);
      const clock = rowClock(row);
      if (clock) updateClock.run(serializeClock({
        ...clock, remainingMs: order.map((seat) => clock.remainingMs[seat]!),
        activeSeat: clock.activeSeat === null ? null : newSeat(clock.activeSeat),
      }), duelId);
      const setup = parseSetup(row.setup_json);
      if (setup) updateSetup.run(JSON.stringify({
        ...setup,
        ...(setup.botPolicies ? { botPolicies: Object.fromEntries(Object.entries(setup.botPolicies)
          .map(([seat, policy]) => [String(newSeat(Number(seat))), policy])) } : {}),
        ...(setup.surrenderedSeats ? { surrenderedSeats: setup.surrenderedSeats.map(newSeat) } : {}),
      }), duelId);
      // Dice history deliberately retains the original lobby indices for every round.
      return after;
    }
    if (!openingNeedsSwap(after)) return after;
    // Two statements: the primary key (duel_id, seat) must stay unique after every row update.
    db.prepare<[number]>("update duel_seats set seat = seat + 2 where duel_id = ?").run(duelId);
    db.prepare<[number]>("update duel_seats set seat = 3 - seat where duel_id = ?").run(duelId);
    return swapOpeningSeats(after);
  };

  const runOpening = <T>(work: () => T): T => {
    try {
      return work();
    } catch (error) {
      if (error instanceof DuelOpeningError) throw new DuelServiceError(error.message, error.status);
      throw error;
    }
  };

  const startOpeningTx = db.transaction((slug: string, guildId: string, actorPlayerId: number, at: number) => {
    const row = loadDuelRow(slug, guildId);
    assertPlayerGuild(actorPlayerId, guildId);
    if (row.status !== "lobby") throw new DuelServiceError("Duel already started", 409);
    const format = rowFormat(row);
    if (format === "tag") throw new DuelServiceError("Tag duels have no opening", 409);
    const existing = parseOpening(row.opening_json);
    if (existing) return existing;
    const seats = seatRows(row.id);
    const seatCount = seatCountFor(format);
    if (seats.length !== seatCount || seats.some((seat) => seat.ready !== 1)) {
      throw new DuelServiceError(`Duel needs exactly ${seatCount} ready players to start`, 400);
    }
    if (row.series_id !== null) {
      const linked = series.byId(row.series_id);
      if (!linked || series.playerIndex(linked, actorPlayerId) === null) {
        throw new DuelServiceError("Only a player in this match can start this duel", 403);
      }
    } else if (row.organizer_player_id !== actorPlayerId) {
      throw new DuelServiceError("Only the organizer can start this duel", 403);
    }
    const state = format === "1v1" ? newOpening(actorPlayerId, at) : newDiceOpening(actorPlayerId, seatCount, at, rollDie);
    storeOpening(row.id, state);
    return state;
  });

  const openingStepTx = db.transaction(
    (slug: string, guildId: string, step: (state: DuelOpeningState, seatCount: number) => DuelOpeningState) => {
      const row = loadDuelRow(slug, guildId);
      if (row.status !== "lobby") throw new DuelServiceError("The duel is not in its opening", 409);
      const before = requireOpening(row);
      const stepped = runOpening(() => step(before, seatRows(row.id).length));
      const after = settleOrder(row.id, before, stepped);
      if (after !== before) storeOpening(row.id, after);
      return after;
    },
  );

  const createTx = db.transaction(
    (input: {
      guildId: string;
      organizerPlayerId: number;
      name: string;
      mode: DuelMode;
      masterRule?: DuelMasterRule;
      settings?: unknown;
      format?: DuelFormat;
      bestOf?: DuelBestOf;
      ranked?: boolean;
    }) => {
      const format = input.format ?? DEFAULT_DUEL_FORMAT;
      if (!isDuelFormat(format)) throw new DuelServiceError("Duel format must be 1v1, tag, ffa3, or ffa4", 400);
      const name = input.name.trim();
      if (!name) throw new DuelServiceError("Duel name is required", 400);
      if (!isDuelMode(input.mode)) throw new DuelServiceError("Duel mode must be normal or domain", 400);
      assertPlayerGuild(input.organizerPlayerId, input.guildId);
      const masterRule = resolveMasterRule(input.mode, input.masterRule, format);
      const settings = wrapSettingsError(() => normalizeDuelSettings(input.mode, input.settings, format));
      const inviteCode = settings.visibility === "private" ? generateInviteCode() : null;
      const bestOf = input.bestOf === undefined ? 1 : input.bestOf;
      if (bestOf !== 1 && bestOf !== 3) throw new DuelServiceError("Best of must be 1 or 3", 400);
      const ranked = input.ranked === undefined ? false : input.ranked;
      if (typeof ranked !== "boolean") throw new DuelServiceError("Ranked must be true or false", 400);
      if (format !== DEFAULT_DUEL_FORMAT && (bestOf !== 1 || ranked)) {
        throw new DuelServiceError("Only a 1v1 duel can be best of 3 or ranked", 400);
      }

      const result = insertDuel.run(
        input.guildId,
        generateWebSlug(),
        name,
        input.organizerPlayerId,
        input.mode,
        masterRule,
        JSON.stringify(settings),
        inviteCode,
        format,
        bestOf,
        ranked ? 1 : 0,
      );
      const duelId = Number(result.lastInsertRowid);
      insertSeat.run(duelId, 0, input.organizerPlayerId);
      const created = selectDuelById.get(duelId);
      if (!created) throw new DuelServiceError("Duel record is invalid", 500);
      return mapSession(created);
    },
  );

  const takeSeatTx = db.transaction((slug: string, guildId: string, playerId: number, requestedSeat?: number) => {
    const row = loadDuelRow(slug, guildId);
    assertPlayerGuild(playerId, guildId);
    assertRoomAccess(row, playerId);
    if (row.status !== "lobby") throw new DuelServiceError("Seats can only be taken before the duel starts", 409);
    assertNoOpening(row);
    if (row.series_id !== null) {
      throw new DuelServiceError("This match is between two players; seats are fixed", 409);
    }
    const seatCount = seatCountFor(rowFormat(row));
    if (requestedSeat !== undefined && (!Number.isInteger(requestedSeat) || requestedSeat < 0 || requestedSeat >= seatCount)) {
      throw new DuelServiceError(seatCount === 2 ? "Seat must be 0 or 1" : `Seat must be between 0 and ${seatCount - 1}`, 400);
    }

    const seats = seatRows(row.id);
    const mine = seats.find((seat) => seat.player_id === playerId);
    if (mine) {
      if (requestedSeat !== undefined && mine.seat !== requestedSeat) {
        throw new DuelServiceError("You are already seated in this duel", 409);
      }
      return mapSession(row);
    }

    const used = new Set(seats.map((seat) => seat.seat));
    const seat = requestedSeat ?? Array.from({ length: seatCount }, (_, index) => index).find((index) => !used.has(index));
    if (seat === undefined || used.has(seat)) {
      throw new DuelServiceError("That seat is already taken. You are still watching; choose another open seat.", 409);
    }

    try {
      insertSeat.run(row.id, seat, playerId);
    } catch (error) {
      if (isConstraintError(error)) throw new DuelServiceError("That seat is already taken. You are still watching; choose another open seat.", 409);
      throw error;
    }
    touchActivity.run(row.id);
    return mapSession(row);
  });

  const addPracticeBotTx = db.transaction((slug: string, guildId: string, organizerPlayerId: number, deck: DuelDeck, wantedSeat?: number) => {
    const row = loadDuelRow(slug, guildId);
    assertPlayerGuild(organizerPlayerId, guildId);
    assertRoomAccess(row, organizerPlayerId);
    if (row.status !== "lobby") throw new DuelServiceError("Duel is not in lobby", 400);
    if (row.organizer_player_id !== organizerPlayerId) {
      throw new DuelServiceError("Only the organizer can add a practice bot", 403);
    }

    const seats = seatRows(row.id);
    const seatCount = seatCountFor(rowFormat(row));
    if (seats.length < 1 || seats.length >= seatCount) {
      throw new DuelServiceError("Duel needs an empty opponent seat", 409);
    }

    const used = new Set(seats.map((seat) => seat.seat));
    let seat = 0;
    if (wantedSeat !== undefined) {
      if (!Number.isInteger(wantedSeat) || wantedSeat < 0 || wantedSeat >= seatCount) {
        throw new DuelServiceError(`Seat must be between 0 and ${seatCount - 1}`, 400);
      }
      if (used.has(wantedSeat)) throw new DuelServiceError("That seat is taken", 409);
      seat = wantedSeat;
    } else {
      while (used.has(seat) && seat < seatCount) seat += 1;
    }
    if (seat >= seatCount) throw new DuelServiceError("Duel needs an empty opponent seat", 409);

    const normalized = validateDuelDeckShape(deck, rowSettings(row).validateDeck);
    try {
      insertBotSeat.run(row.id, seat, JSON.stringify(normalized));
    } catch (error) {
      if (isConstraintError(error)) throw new DuelServiceError("Duel needs an empty opponent seat", 409);
      throw error;
    }
    return mapSession(row);
  });

  const removePracticeBotTx = db.transaction((slug: string, guildId: string, organizerPlayerId: number, seat?: number) => {
    const row = loadDuelRow(slug, guildId);
    assertPlayerGuild(organizerPlayerId, guildId);
    assertRoomAccess(row, organizerPlayerId);
    if (row.status !== "lobby") throw new DuelServiceError("A practice bot can only be removed before the duel starts", 409);
    assertNoOpening(row);
    if (row.organizer_player_id !== organizerPlayerId) {
      throw new DuelServiceError("Only the organizer can remove a practice bot", 403);
    }
    // The bot's seat row holds everything the add created (ready flag and deck), so deleting it clears it all.
    const removed =
      seat === undefined
        ? db.prepare<[number]>("delete from duel_seats where duel_id = ? and is_bot = 1").run(row.id)
        : db.prepare<[number, number]>("delete from duel_seats where duel_id = ? and is_bot = 1 and seat = ?").run(row.id, seat);
    if (removed.changes === 0) throw new DuelServiceError("This table has no practice bot", 409);
    return mapSession(row);
  });

  const setDeckTx = db.transaction((slug: string, guildId: string, playerId: number, deck: DuelDeck) => {
    const row = loadDuelRow(slug, guildId);
    assertPlayerGuild(playerId, guildId);
    assertRoomAccess(row, playerId);
    if (row.status !== "lobby") throw new DuelServiceError("Decks can only be set before the duel starts", 400);
    assertNoOpening(row);

    const seat = seatRows(row.id).find((entry) => entry.player_id === playerId);
    if (!seat) throw new DuelServiceError("You are not seated in this duel", 403);

    const normalized = validateDuelDeckShape(deck, rowSettings(row).validateDeck);
    updateDeck.run(JSON.stringify(normalized), row.id, playerId);
    return mapSession(row);
  });

  const leaveTx = db.transaction((slug: string, guildId: string, playerId: number) => {
    const row = loadDuelRow(slug, guildId);
    assertPlayerGuild(playerId, guildId);
    const seat = seatRows(row.id).find((entry) => entry.player_id === playerId);
    if (!seat) throw new DuelServiceError("You are not seated in this duel", 403);
    if (row.series_id !== null) {
      throw new DuelServiceError("Seats are fixed in a match between two players. Cancel the match instead.", 409);
    }
    if (row.status !== "lobby") throw new DuelServiceError("You can only leave a table before the duel starts", 409);
    assertNoOpening(row);
    if (row.organizer_player_id === playerId) {
      throw new DuelServiceError("The organizer cannot leave. Cancel the table instead.", 409);
    }
    db.prepare<[number, number]>("delete from duel_seats where duel_id = ? and player_id = ?").run(row.id, playerId);
    touchActivity.run(row.id);
    const updated = selectDuelById.get(row.id);
    if (!updated) throw new DuelServiceError("Duel record is invalid", 500);
    return mapSession(updated);
  });

  const markReadyTx = db.transaction((slug: string, guildId: string, playerId: number) => {
    const row = loadDuelRow(slug, guildId);
    assertPlayerGuild(playerId, guildId);
    assertRoomAccess(row, playerId);
    if (row.status !== "lobby") throw new DuelServiceError("Duel is not in lobby", 400);
    assertNoOpening(row);
    const seat = seatRows(row.id).find((entry) => entry.player_id === playerId);
    if (!seat) throw new DuelServiceError("You are not seated in this duel", 403);
    if (!seat.deck_json) throw new DuelServiceError("Choose a deck before you ready up", 400);
    updateReady.run(row.id, playerId);
    return mapSession(row);
  });

  const markUnreadyTx = db.transaction((slug: string, guildId: string, playerId: number) => {
    const row = loadDuelRow(slug, guildId);
    assertPlayerGuild(playerId, guildId);
    assertRoomAccess(row, playerId);
    if (row.status !== "lobby") throw new DuelServiceError("Duel is not in lobby", 400);
    assertNoOpening(row);
    const seat = seatRows(row.id).find((entry) => entry.player_id === playerId);
    if (!seat) throw new DuelServiceError("You are not seated in this duel", 403);
    updateUnready.run(row.id, playerId);
    return mapSession(row);
  });

  const activateTx = db.transaction(
    (
      slug: string,
      guildId: string,
      organizerPlayerId: number | null,
      seed: string[],
      bundleVersion: string,
      clock: DuelClockState | null,
      setup?: DuelSetup,
    ) => {
      const row = loadDuelRow(slug, guildId);
      if (row.status !== "lobby") throw new DuelServiceError("Duel is not in lobby", 400);
      if (row.series_id !== null) {
        // A series game: the host starts it (null), or any player of the series.
        if (organizerPlayerId !== null) {
          const linked = series.byId(row.series_id);
          if (!linked || series.playerIndex(linked, organizerPlayerId) === null) {
            throw new DuelServiceError("Only a player in this match can start this duel", 403);
          }
        }
      } else if (organizerPlayerId === null) {
        throw new DuelServiceError("Only a match game can be started by the system", 403);
      } else if (row.organizer_player_id !== organizerPlayerId) {
        throw new DuelServiceError("Only the organizer can start this duel", 403);
      }
      if (!Array.isArray(seed) || seed.some((value) => typeof value !== "string")) {
        throw new DuelServiceError("Duel seed is invalid", 400);
      }
      if (!bundleVersion.trim()) throw new DuelServiceError("Bundle version is required", 400);

      const seatCount = seatCountFor(rowFormat(row));
      const seats = seatRows(row.id);
      if (seats.length !== seatCount || seats.some((seat) => seat.ready !== 1)) {
        throw new DuelServiceError(
          seatCount === 2
            ? "Duel needs exactly two ready players to start"
            : `Duel needs exactly ${seatCount} ready players to start`,
          400,
        );
      }

      const storedClock = clock === null ? null : checkedClock(clock, seatCount);
      const storedSetup = setup === undefined ? null : JSON.stringify(validateSetup(setup));
      db.prepare<[string, string, string | null, string | null, number]>(
        "update duels set status = 'active', seed_json = ?, bundle_version = ?, clock_json = ?, setup_json = coalesce(?, setup_json), opening_json = null, last_activity_at = datetime('now') where id = ? and status = 'lobby'",
      ).run(JSON.stringify(seed), bundleVersion, serializeClock(storedClock), storedSetup, row.id);
      const updated = selectDuelById.get(row.id);
      if (!updated || updated.status !== "active") throw new DuelServiceError("Duel is not in lobby", 400);
      series.onActivate(updated, rowSettings(updated));
      const attached = selectDuelById.get(row.id);
      return mapSession(attached ?? updated);
    },
  );

  const recordCommandTx = db.transaction(
    (slug: string, guildId: string, seat: number, command: DuelCommand, clock: DuelClockState | null, touch: boolean) => {
      const row = loadDuelRow(slug, guildId);
      if (row.status !== "active") throw new DuelServiceError("Duel is not active", 400);
      if (!Number.isInteger(seat) || !seatRows(row.id).some((entry) => entry.seat === seat)) {
        throw new DuelServiceError("Seat is not occupied", 400);
      }
      const storedClock = clock === null ? null : checkedClock(clock, seatCountFor(rowFormat(row)));
      const next = nextCommandSeq.get(row.id);
      if (!next) throw new DuelServiceError("Duel record is invalid", 500);
      insertCommand.run(row.id, next.next_seq, seat, JSON.stringify(command));
      updateClock.run(serializeClock(storedClock), row.id);
      if (touch) touchActivity.run(row.id);
    },
  );

  const finalizeTx = db.transaction(
    (
      slug: string,
      guildId: string,
      nextStatus: "completed" | "interrupted",
      winnerSeat: number | null,
      reason: string,
      snapshots: DuelFinalSnapshots | undefined,
    ) => {
      const row = loadDuelRow(slug, guildId);
      if (row.status === "completed" || row.status === "interrupted" || row.status === "cancelled") {
        return mapSession(row);
      }
      if (row.status !== "active") throw new DuelServiceError("Duel is not active", 400);

      const format = rowFormat(row);
      let winnerPlayerId: number | null = null;
      let winnerTeam: number | null = null;
      let winnerIsBot = false;
      if (nextStatus === "completed" && winnerSeat !== null) {
        const rows = seatRows(row.id);
        const winner = rows.find((entry) => entry.seat === winnerSeat);
        if (!winner) throw new DuelServiceError("Winner seat is not occupied", 400);
        winnerPlayerId = winner.player_id;
        winnerIsBot = winner.is_bot === 1;
        if (format === "tag") {
          // A team wins together. `winner_player_id` names the first human of the winning team, so a
          // bot partner in the lowest seat does not hide the human winner. Both partners won.
          winnerTeam = teamOfSeat(format, winnerSeat);
          const human = rows.find((entry) => teamOfSeat(format, entry.seat) === winnerTeam && entry.player_id !== null);
          if (winnerPlayerId === null && human) winnerPlayerId = human.player_id;
        }
      }

      const result: { winnerSeat: number | null; winnerTeam?: number | null; reason: string } = {
        winnerSeat: nextStatus === "completed" ? winnerSeat : null,
        reason,
      };
      if (format === "tag") result.winnerTeam = winnerTeam;
      const publicJson = snapshots ? freezeSnapshot(snapshots.public, result) : null;
      const seatCount = seatCountFor(rowFormat(row));
      const seatViews: Array<DuelEngineView | undefined> = [];
      for (let index = 0; index < seatCount; index += 1) {
        seatViews.push(snapshots?.seats?.[index] ?? (index === 0 ? snapshots?.seat0 : index === 1 ? snapshots?.seat1 : undefined));
      }
      const seat0Json = seatViews[0] ? freezeSnapshot(seatViews[0], result) : null;
      const seat1Json = seatViews[1] ? freezeSnapshot(seatViews[1], result) : null;
      const seatsJson =
        snapshots && seatCount > 2 && seatViews.every((view) => view)
          ? JSON.stringify(seatViews.map((view) => JSON.parse(freezeSnapshot(view as DuelEngineView, result)) as unknown))
          : null;

      db.prepare<
        ["completed" | "interrupted", number | null, number | null, string, string | null, string | null, string | null, string | null, number]
      >(
        `
          update duels
          set status = ?, ended_at = datetime('now'), archived_at = coalesce(archived_at, datetime('now')), winner_player_id = ?, winner_seat = ?, result_reason = ?,
              snapshot_public_json = ?, snapshot_seat0_json = ?, snapshot_seat1_json = ?, snapshot_seats_json = ?, clock_json = null
          where id = ? and status = 'active'
        `,
      ).run(
        nextStatus,
        winnerPlayerId,
        nextStatus === "completed" ? winnerSeat : null,
        reason,
        publicJson,
        seat0Json,
        seat1Json,
        seatsJson,
        row.id,
      );
      const updated = selectDuelById.get(row.id);
      if (!updated) throw new DuelServiceError("Duel record is invalid", 500);
      series.onGameFinished(updated, nextStatus, winnerPlayerId, winnerIsBot);
      return mapSession(updated);
    },
  );

  const cancelTx = db.transaction((slug: string, guildId: string, organizerPlayerId: number) => {
    const row = loadDuelRow(slug, guildId);
    assertPlayerGuild(organizerPlayerId, guildId);
    assertRoomAccess(row, organizerPlayerId);
    const linked = row.series_id !== null ? series.byId(row.series_id) : undefined;
    if (linked) {
      // Either player of a match can cancel its lobby; that cancels the whole series.
      if (series.playerIndex(linked, organizerPlayerId) === null) {
        throw new DuelServiceError("Only a player in this match can cancel this duel", 403);
      }
      if (row.status === "cancelled") return mapSession(row);
      if (row.status !== "lobby") throw new DuelServiceError("Only a lobby can be cancelled", 409);
      // Cancelling a lobby cancels the whole series. That is only fine for game 1 of a casual
      // series; later games and tournament matches already have wins to protect.
      if (linked.tournament_match_id !== null || (row.game_number ?? 1) > 1) {
        throw new DuelServiceError(
          linked.tournament_match_id !== null
            ? "A tournament match cannot be cancelled from its lobby. The tournament organizer cancels the series."
            : "Game 2 or later cannot be cancelled from its lobby because it would erase the series wins. Cancel the series instead.",
          403,
        );
      }
      series.cancel(linked.id, guildId);
      const cancelled = selectDuelById.get(row.id);
      if (!cancelled) throw new DuelServiceError("Duel record is invalid", 500);
      return mapSession(cancelled);
    }
    if (row.organizer_player_id !== organizerPlayerId) {
      throw new DuelServiceError("Only the organizer can cancel this duel", 403);
    }
    if (row.status === "cancelled") return mapSession(row);
    if (row.status !== "lobby" && (row.status !== "active" || row.ranked === 1)) {
      throw new DuelServiceError("Only a lobby or an active unranked duel can be cancelled", 409);
    }

    db.prepare<[number]>(
      `
        update duels
        set status = 'cancelled', ended_at = datetime('now'), archived_at = coalesce(archived_at, datetime('now')), winner_player_id = null, winner_seat = null,
            result_reason = 'Cancelled', clock_json = null
        where id = ? and status in ('lobby', 'active')
      `,
    ).run(row.id);
    const updated = selectDuelById.get(row.id);
    if (!updated) throw new DuelServiceError("Duel record is invalid", 500);
    return mapSession(updated);
  });

  const archiveTx = db.transaction((slug: string, guildId: string, organizerPlayerId: number) => {
    const row = loadDuelRow(slug, guildId);
    assertPlayerGuild(organizerPlayerId, guildId);
    assertRoomAccess(row, organizerPlayerId);
    if (row.organizer_player_id !== organizerPlayerId) {
      throw new DuelServiceError("Only the organizer can archive this duel", 403);
    }
    if (row.archived_at) return mapSession(row);
    if (!isTerminalStatus(row.status)) {
      throw new DuelServiceError("Only finished duels can be archived", 409);
    }

    db.prepare<[number]>("update duels set archived_at = datetime('now') where id = ? and archived_at is null").run(row.id);
    const updated = selectDuelById.get(row.id);
    if (!updated) throw new DuelServiceError("Duel record is invalid", 500);
    return mapSession(updated);
  });

  const archiveDueTx = db.transaction((limit: number, archiveAfterMs: number) => {
    const cap = Math.min(Math.max(1, Math.floor(limit)), ARCHIVE_DUE_CAP);
    const seconds = Math.max(0, Math.ceil(archiveAfterMs / 1000));
    const due = selectDue.all(`-${seconds} seconds`, cap);
    const archived: DuelSession[] = [];
    const stamp = db.prepare<[number]>("update duels set archived_at = datetime('now') where id = ? and archived_at is null");
    for (const row of due) {
      if (!isTerminalStatus(row.status)) continue;
      stamp.run(row.id);
      const updated = selectDuelById.get(row.id);
      if (updated?.archived_at) archived.push(mapSession(updated));
    }
    return archived;
  });

  return {
    create(input) {
      return createTx(input);
    },

    list(guildId, playerId, options) {
      assertPlayerGuild(playerId, guildId);
      const toItem = (row: DuelListItemRow): DuelListItem => ({
        ...mapSession(row),
        mySeat: row.my_seat,
        lastActivityAt: row.last_activity_at ?? row.created_at,
        series: row.series_id === null ? null : series.summaryById(row.series_id),
      });
      if (options?.archived) {
        const scope: DuelHistoryScope = options.scope ?? "mine";
        return listHistory.all({ guild: guildId, viewer: playerId, all: scope === "all" ? 1 : 0 }).map(toItem);
      }
      const idleMs = options?.idleAfterMs ?? DUEL_LIVE_IDLE_AFTER_MS;
      const idleSeconds = Math.max(0, Math.ceil(idleMs / 1000));
      return listLive
        .all({ guild: guildId, viewer: playerId, idle: `-${idleSeconds} seconds` })
        .map(toItem);
    },

    get(slug, guildId) {
      return mapSession(loadDuelRow(slug, guildId));
    },

    takeSeat(slug, guildId, playerId, seat) {
      // Reserve the writer lock before checking occupancy, including claims from another process.
      return takeSeatTx.immediate(slug, guildId, playerId, seat);
    },

    leave(slug, guildId, playerId) {
      return leaveTx(slug, guildId, playerId);
    },

    addPracticeBot(slug, guildId, organizerPlayerId, deck, seat) {
      return addPracticeBotTx(slug, guildId, organizerPlayerId, deck, seat);
    },

    removePracticeBot(slug, guildId, organizerPlayerId, seat) {
      return removePracticeBotTx(slug, guildId, organizerPlayerId, seat);
    },

    setDeck(slug, guildId, playerId, deck) {
      return setDeckTx(slug, guildId, playerId, deck);
    },

    room(slug, guildId, playerId): DuelRoom {
      const row = loadDuelRow(slug, guildId);
      assertPlayerGuild(playerId, guildId);
      assertRoomAccess(row, playerId);
      const session = mapSession(row);
      const seated = session.seats.find((seat) => seat.playerId === playerId);
      const role: DuelActorRole = seated ? "player" : "spectator";
      const mySeat = seated ? seated.seat : null;
      const terminal = isTerminalStatus(session.status);
      const engine = terminal ? snapshotForRole(row, mySeat) : null;
      const room: DuelRoom = {
        session,
        role,
        mySeat,
        myDeck: seated ? ownDeck(row.id, playerId) : null,
        engine,
        clock: clockWithServerNow(rowClock(row)),
        metadataOnly: terminal && engine === null,
      };
      if (session.settings.visibility === "private" && playerId === session.organizerPlayerId && row.invite_code) {
        room.inviteCode = row.invite_code;
      }
      const linked = row.series_id === null ? undefined : series.byId(row.series_id);
      room.series = linked ? series.summarize(linked) : null;
      const opening = row.status === "lobby" ? parseOpening(row.opening_json) : null;
      room.opening = opening ? openingView(opening, mySeat, Date.now()) : null;
      room.mySide = null;
      if (linked && seated && series.playerIndex(linked, playerId) !== null) {
        const own = ownDeck(row.id, playerId);
        room.mySide = series.sideState(linked, playerId) ?? (own ? { baseDeck: own, currentDeck: own } : null);
      }
      return room;
    },

    privateState(slug, guildId) {
      const row = loadDuelRow(slug, guildId);
      const seats = seatRows(row.id);
      return {
        session: mapSession(row),
        decks: seats.map((seat) => parseDeck(seat.deck_json) ?? emptyDeck()),
        seed: parseSeed(row.seed_json),
        bundleVersion: row.bundle_version,
        commands: selectCommands.all(row.id).map((entry) => ({
          storedSeq: entry.seq,
          seat: entry.seat,
          command: JSON.parse(entry.command_json) as DuelCommand,
        })),
        clock: rowClock(row),
        setup: parseSetup(row.setup_json),
      };
    },

    markReady(slug, guildId, playerId) {
      return markReadyTx(slug, guildId, playerId);
    },
    markUnready(slug, guildId, playerId) {
      return markUnreadyTx(slug, guildId, playerId);
    },

    activate(slug, guildId, organizerPlayerId, seed, bundleVersion, clock, setup) {
      return activateTx(slug, guildId, organizerPlayerId, seed, bundleVersion, clock, setup);
    },

    recordCommand(slug, guildId, seat, command, clock, options) {
      recordCommandTx(slug, guildId, seat, command, clock, options?.touchActivity !== false);
    },

    complete(slug, guildId, winnerSeat, reason, snapshots) {
      return finalizeTx(slug, guildId, "completed", winnerSeat, reason, snapshots);
    },

    interrupt(slug, guildId, reason, snapshots) {
      return finalizeTx(slug, guildId, "interrupted", null, reason, snapshots);
    },

    cancel(slug, guildId, organizerPlayerId) {
      return cancelTx(slug, guildId, organizerPlayerId);
    },

    startOpening(slug, guildId, actorPlayerId, at) {
      return startOpeningTx(slug, guildId, actorPlayerId, at);
    },

    openingState(slug, guildId) {
      return parseOpening(loadDuelRow(slug, guildId).opening_json);
    },

    submitOpeningPick(slug, guildId, seat, move, at) {
      return openingStepTx(slug, guildId, (state) => submitOpeningPick(state, seat, move, at));
    },

    submitOpeningChoice(slug, guildId, seat, choice, at) {
      return openingStepTx(slug, guildId, (state) => submitOpeningChoice(state, seat, choice, at));
    },

    settleOpening(slug, guildId, at, random) {
      const row = loadDuelRow(slug, guildId);
      if (row.status !== "lobby" || !parseOpening(row.opening_json)) return parseOpening(row.opening_json);
      return openingStepTx(slug, guildId, (state) => isDiceOpening(state) ? settleDiceOpening(state, at, rollDie) : settleOpening(state, at, random));
    },

    abortOpening(slug, guildId) {
      const row = loadDuelRow(slug, guildId);
      if (row.status === "lobby" && row.opening_json) storeOpening(row.id, null);
    },

    dueOpenings(now, limit) {
      return selectDueOpenings.all(Math.floor(now), limit);
    },

    archive(slug, guildId, organizerPlayerId) {
      return archiveTx(slug, guildId, organizerPlayerId);
    },

    archiveDue(limit, archiveAfterMs) {
      return archiveDueTx(limit, archiveAfterMs);
    },

    admit(slug, guildId, playerId, inviteCode) {
      const row = loadDuelRow(slug, guildId);
      assertPlayerGuild(playerId, guildId);
      if (rowSettings(row).visibility !== "private" || !row.invite_code) {
        throw new DuelServiceError("Duel is not invite-only", 400);
      }
      if (typeof inviteCode !== "string" || inviteCode.length === 0) {
        throw new DuelServiceError("Invite code is required", 400);
      }
      if (!inviteCodeMatches(row.invite_code, inviteCode)) {
        throw new DuelServiceError("Invite code is invalid", 403);
      }
      insertGrant.run(row.id, playerId);
    },

    setClock(slug, guildId, clock) {
      const row = loadDuelRow(slug, guildId);
      const storedClock = clock === null ? null : checkedClock(clock, seatCountFor(rowFormat(row)));
      updateClock.run(serializeClock(storedClock), row.id);
    },

    setSetup(slug, guildId, setup) {
      const row = loadDuelRow(slug, guildId);
      updateSetup.run(setup === null ? null : JSON.stringify(validateSetup(setup)), row.id);
    },

    dueClocks(now, limit) {
      const cap = Math.min(Math.max(1, Math.floor(limit)), CLOCK_DUE_CAP);
      const instant = Math.floor(now);
      return selectDueClocks.all(instant, cap);
    },
  };
}
