import type Database from "better-sqlite3";
import { randomInt } from "node:crypto";
import type {
  DuelBestOf,
  DuelDeck,
  DuelFirstChoice,
  DuelMasterRule,
  DuelMode,
  DuelSeriesSideState,
  DuelSeriesStatus,
  DuelSeriesSummary,
  DuelSession,
} from "../duels/index.js";
import { deckCardCounts } from "../duels/pool.js";
import { normalizeDuelSettings, parseStoredDuelSettings } from "../duels/settings.js";
import type { DuelSettings } from "../duels/settings.js";
import { generateWebSlug } from "../util/web-slug.js";
// duels.ts imports this module too. The cycle is safe: neither module uses the
// other's exports while it loads, only inside functions.
import {
  createDuelService,
  DuelServiceError,
  generateInviteCode,
  isDuelMode,
  PRACTICE_BOT_NAME,
  resolveMasterRule,
  validateDuelDeckShape,
  wrapSettingsError,
} from "./duels.js";
import { createMatchService } from "./matches.js";
import type { Match } from "./matches.js";
import { resolveTournamentDuelRules } from "./tournament-duels.js";

/** Seconds players have to side deck between games of a Best of 3. */
export const SERIES_SIDE_WINDOW_MS = 60_000;

export interface CreateChallengeInput {
  guildId: string;
  challengerPlayerId: number;
  opponentPlayerId: number;
  bestOf: DuelBestOf;
  ranked: boolean;
  mode: DuelMode;
  masterRule?: DuelMasterRule;
  /** Normalized like duel create settings. Visibility is forced to private. */
  settings?: unknown;
  name?: string;
}

export interface SeriesGameStart {
  series: DuelSeriesSummary;
  /** Game 1 in lobby (both seats taken). */
  duel: DuelSession;
  /** False when an open series already existed and was returned as-is. */
  created: boolean;
}

export type SeriesResultRetry =
  | { ok: true; match: Match }
  | { ok: false; error: "superseded"; code: "superseded" }
  | { ok: false; error: "needs_reconciliation"; code: "needs_reconciliation" }
  | { ok: false; error: string; code?: undefined };

/**
 * Matches of 1 or 3 games. CONTRACT (see
 * docs/superpowers/specs/2026-09-30-duel-results-tournaments-draft-decks-design.md):
 * the duel service calls the series hooks inside its own transactions (game 1
 * activation and game finish), so callers never call them directly.
 */
export interface DuelSeriesService {
  /** A private game 1 in lobby with both seats taken (random seat order). */
  createChallenge(input: CreateChallengeInput): SeriesGameStart;
  /**
   * A series for an open bracket slot. Both players must be participants with
   * a registered deck; the decks are preloaded into the seats (ready = false).
   * Idempotent: returns the open series of the slot when one exists.
   */
  startTournamentMatch(input: { guildId: string; tournamentMatchId: number; actorPlayerId: number }): SeriesGameStart;
  get(seriesId: number, guildId: string): DuelSeriesSummary;
  forDuel(duelId: number): DuelSeriesSummary | null;
  /** Open (active or between_games) series of a bracket slot, or null. */
  openForTournamentMatch(tournamentMatchId: number): DuelSeriesSummary | null;
  sideState(seriesId: number, guildId: string, playerId: number): DuelSeriesSideState;
  /**
   * Stores the player's sided deck for the next game. The duel host has
   * already checked card types. The service checks: status between_games, the
   * same cards as the current deck (as a multiset over main+extra+side, using
   * the host's optional canonical card resolver for stored artwork ids), the
   * Main, Extra and Side counts unchanged, main >= min(40, base main count)
   * and <= 60, extra <= 15. A deck that differs from the current one clears the player's
   * Ready, so the next game never starts on a deck they did not confirm.
   */
  setSideDeck(seriesId: number, guildId: string, playerId: number, deck: DuelDeck, resolve?: (code: number) => number): DuelSeriesSummary;
  /**
   * setSideDeck that also reports whether this save cleared the player's Ready, read inside the same
   * transaction (a snapshot taken before the call can miss a Ready that landed in between).
   */
  saveSideDeck(
    seriesId: number,
    guildId: string,
    playerId: number,
    deck: DuelDeck,
    resolve?: (code: number) => number,
  ): { series: DuelSeriesSummary; readyCleared: boolean };
  /**
   * The loser of the last game chooses to go first or second in the next game. Only that player, only
   * between games. A later call changes the choice until the next game is made. When nobody chooses,
   * the loser goes first.
   */
  setFirstChoice(seriesId: number, guildId: string, playerId: number, choice: DuelFirstChoice): DuelSeriesSummary;
  /** Ready also fixes the default (first) for a chooser who has not chosen. */
  setSideReady(seriesId: number, guildId: string, playerId: number): DuelSeriesSummary;
  /**
   * Takes back the player's Ready between games, e.g. when they start editing their side deck.
   * `readyCleared` is false when they were not ready.
   */
  clearSideReady(seriesId: number, guildId: string, playerId: number): { series: DuelSeriesSummary; readyCleared: boolean };
  /** between_games series whose deadline passed or whose players are both ready. */
  dueNextGames(nowMs: number, limit: number): Array<{ seriesId: number; guildId: string }>;
  /** Series games in lobby with two ready seats (auto-start recovery after a host restart). */
  dueStarts(limit: number): Array<{ slug: string; guildId: string }>;
  /**
   * Makes the next game in lobby: the loser of the last game chooses to go first
   * or second (default first); after a draw or interrupt, the players swap seats. Both decks from the series
   * current decks, both seats ready. Sets the series back to active.
   * Idempotent: returns the existing lobby game.
   */
  createNextGame(seriesId: number, guildId: string): DuelSession;
  /**
   * Stops an open series with no winner and cancels its lobby game. Idempotent.
   * A live game keeps running but its result no longer counts. Returns the
   * slugs of games that changed (for ws notify).
   */
  cancel(seriesId: number, guildId: string): { changedSlugs: string[] };
}

const SIDE_DECK_MIN_MAIN = 40;
const SIDE_DECK_MAX_MAIN = 60;
const DUE_CAP = 100;
// Reports remain identifiable by tournament and pairing after a reopen clears
// tm.match_id. Legacy match history cannot establish ordering without a watermark.
const SUPERSEDED_RESULT_FILTER = `
  tournament_match_id is not null and (
    exists (
      select 1 from duel_series newer
      where newer.tournament_match_id = duel_series.tournament_match_id and newer.id > duel_series.id
    ) or exists (
      select 1 from tournament_matches tm join matches m on m.tournament_id = tm.tournament_id
      where tm.id = duel_series.tournament_match_id
        and ((m.player_one_id = duel_series.player0_id and m.player_two_id = duel_series.player1_id)
          or (m.player_one_id = duel_series.player1_id and m.player_two_id = duel_series.player0_id))
        and (
          m.id = tm.match_id
          or m.id > json_extract(duel_series.settings_json, '$.resultMatchIdWatermark')
        )
    )
  )
`;
const NEEDS_RECONCILIATION_FILTER = `
  tournament_match_id is not null
  and json_extract(duel_series.settings_json, '$.resultMatchIdWatermark') is null
  and exists (
    select 1 from tournament_matches tm join matches m
      on m.id = tm.match_id or (
        m.tournament_id = tm.tournament_id
        and ((m.player_one_id = duel_series.player0_id and m.player_two_id = duel_series.player1_id)
          or (m.player_one_id = duel_series.player1_id and m.player_two_id = duel_series.player0_id))
      )
    where tm.id = duel_series.tournament_match_id
  )
`;
const UNRECORDED_RESULT_FILTER = `
  status = 'completed' and winner_player_id is not null and match_id is null
  and (ranked = 1 or tournament_match_id is not null)
  and not (${SUPERSEDED_RESULT_FILTER})
`;

export type SeriesRow = {
  id: number;
  guild_id: string;
  best_of: number;
  ranked: number;
  player0_id: number;
  player1_id: number;
  wins0: number;
  wins1: number;
  status: string;
  winner_player_id: number | null;
  tournament_match_id: number | null;
  match_id: number | null;
  mode: string;
  master_rule: number;
  settings_json: string;
  base_deck0_json: string | null;
  base_deck1_json: string | null;
  deck0_json: string | null;
  deck1_json: string | null;
  side_ready0: number;
  side_ready1: number;
  first_chooser: number | null;
  first_choice: string | null;
  vs_bot: number;
  next_game_at: string | null;
  created_by_player_id: number;
  created_at: string;
  ended_at: string | null;
};

/** The duel columns the series hooks need. A duels row satisfies this. */
export interface SeriesDuelRef {
  id: number;
  guild_id: string;
  series_id: number | null;
  game_number: number | null;
  mode: string;
  master_rule: number;
  best_of: number;
  ranked: number;
  organizer_player_id: number;
}

type GameRow = { id: number; slug: string; game_number: number; status: string; name: string; winner_player_id: number | null };

function parseSeriesDeck(raw: string | null): DuelDeck | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as DuelDeck;
    if (parsed && Array.isArray(parsed.main) && Array.isArray(parsed.extra) && Array.isArray(parsed.side)) return parsed;
  } catch {
    // Falls through to the error below.
  }
  throw new DuelServiceError("Saved series deck is corrupt", 500);
}

function asBestOf(value: number): DuelBestOf {
  return value === 3 ? 3 : 1;
}

function sameCounts(a: Map<number, number>, b: Map<number, number>): boolean {
  if (a.size !== b.size) return false;
  for (const [code, count] of a) if (b.get(code) !== count) return false;
  return true;
}

/** Same cards in the same order in every section: anything else is a deck change. */
function sameDeckLayout(a: DuelDeck, b: DuelDeck): boolean {
  const sameList = (x: readonly number[], y: readonly number[]) => x.length === y.length && x.every((code, i) => code === y[i]);
  return sameList(a.main, b.main) && sameList(a.extra, b.extra) && sameList(a.side, b.side)
    && (a.deckMaster ?? null) === (b.deckMaster ?? null);
}

type InsertSeriesParams = [
  guildId: string,
  bestOf: number,
  ranked: number,
  player0Id: number,
  player1Id: number,
  status: string,
  mode: string,
  masterRule: number,
  settingsJson: string,
  baseDeck0Json: string | null,
  baseDeck1Json: string | null,
  deck0Json: string | null,
  deck1Json: string | null,
  createdByPlayerId: number,
  tournamentMatchId: number | null,
];

/**
 * SQL helpers shared by the series service and the duel service. The duel
 * service calls `onActivate` and `onGameFinished` inside its own transactions.
 * INTERNAL: not part of the package exports.
 */
export function createSeriesStore(db: Database.Database) {
  const matches = createMatchService(db);

  const selectSeries = db.prepare<[number], SeriesRow>("select * from duel_series where id = ?");
  const selectUnrecordedResults = db.prepare<[string], SeriesRow & { needsReconciliation: number }>(
    `select *, (${NEEDS_RECONCILIATION_FILTER}) as needsReconciliation
      from duel_series where guild_id = ?
        and not exists (select 1 from duels f where f.series_id = duel_series.id and f.kind != 'play')
        and ${UNRECORDED_RESULT_FILTER} order by id`,
  );
  const selectSupersededResult = db.prepare<[number], { id: number }>(
    `select id from duel_series where id = ? and ${SUPERSEDED_RESULT_FILTER}`,
  );
  const selectNeedsReconciliation = db.prepare<[number], { id: number }>(
    `select id from duel_series where id = ? and ${NEEDS_RECONCILIATION_FILTER}`,
  );
  const selectRecordedMatch = db.prepare<[number, string], Match>(`
    select id, guild_id as guildId, player_one_id as playerOneId, player_two_id as playerTwoId,
      winner_id as winnerId, reporter_id as reporterId, approver_id as approverId,
      status, source, tournament_id as tournamentId
    from matches where id = ? and guild_id = ?
  `);
  const selectPlayerName = db.prepare<[number], { display_name: string }>("select display_name from players where id = ?");
  const selectLatestGame = db.prepare<[number], GameRow>(
    `
      select id, web_slug as slug, game_number, status, name, winner_player_id
      from duels where series_id = ? order by game_number desc limit 1
    `,
  );
  const selectGame1Name = db.prepare<[number], { name: string }>(
    "select name from duels where series_id = ? and game_number = 1",
  );
  const selectLastGameSeats = db.prepare<[number], { seat: number; player_id: number | null; is_bot: number }>(
    "select seat, player_id, is_bot from duel_seats where duel_id = ? order by seat",
  );
  const selectSeatDecks = db.prepare<[number], { seat: number; player_id: number | null; is_bot: number; deck_json: string | null }>(
    "select seat, player_id, is_bot, deck_json from duel_seats where duel_id = ? order by seat",
  );
  const selectTournamentLink = db.prepare<[number], { tournament_id: number; web_slug: string | null }>(
    `
      select tm.tournament_id, t.web_slug
      from tournament_matches tm
      join tournaments t on t.id = tm.tournament_id
      where tm.id = ?
    `,
  );
  const selectTournamentStatus = db.prepare<[number], { status: string }>(
    `
      select t.status
      from tournament_matches tm
      join tournaments t on t.id = tm.tournament_id
      where tm.id = ?
    `,
  );
  const selectDuelSeries = db.prepare<[number], { series_id: number | null }>("select series_id from duels where id = ?");
  const insertDuel = db.prepare<
    [string, string, string, number, string, number, string, string | null, number, number, number, number]
  >(
    `
      insert into duels (
        guild_id, web_slug, name, organizer_player_id, mode, master_rule, status, settings_json, invite_code,
        series_id, game_number, best_of, ranked
      )
      values (?, ?, ?, ?, ?, ?, 'lobby', ?, ?, ?, ?, ?, ?)
    `,
  );
  const insertSeat = db.prepare<[number, number, number | null, number, number, string | null]>(
    "insert into duel_seats (duel_id, seat, player_id, is_bot, ready, deck_json) values (?, ?, ?, ?, ?, ?)",
  );
  const insertSeries = db.prepare<InsertSeriesParams>(
    `
      insert into duel_series (
        guild_id, best_of, ranked, player0_id, player1_id, status, mode, master_rule, settings_json,
        base_deck0_json, base_deck1_json, deck0_json, deck1_json, created_by_player_id, tournament_match_id
      )
      values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
  );
  const cancelSeries = db.prepare<[number, string]>(`
    update duel_series
    set status = 'cancelled', ended_at = datetime('now'), next_game_at = null
    where id = ? and guild_id = ? and status in ('active', 'between_games')
  `);
  const selectLobbyGames = db.prepare<[number], { id: number; slug: string }>(
    "select id, web_slug as slug from duels where series_id = ? and status = 'lobby'",
  );
  const cancelLobbyGame = db.prepare<[number]>(`
    update duels
    set status = 'cancelled', ended_at = datetime('now'), archived_at = coalesce(archived_at, datetime('now')),
        winner_player_id = null, winner_seat = null, result_reason = 'Series cancelled', clock_json = null
    where id = ? and status = 'lobby'
  `);
  const lockDecks = db.prepare<[number, number, number]>(`
    update tournament_participants
    set deck_locked_at = coalesce(deck_locked_at, datetime('now'))
    where tournament_id = (select tournament_id from tournament_matches where id = ?)
      and player_id in (?, ?)
  `);

  const assertPlaySeries = (seriesId: number) => {
    if (db.prepare("select 1 from duels where series_id = ? and kind != 'play' limit 1").get(seriesId)) {
      throw new DuelServiceError("Replay forks cannot be linked to a series", 409);
    }
  };
  const storedPlayDuel = (duelId: number): SeriesDuelRef => {
    const row = db.prepare<[number], SeriesDuelRef & { kind: string }>("select * from duels where id = ?").get(duelId);
    if (!row) throw new DuelServiceError("Source duel not found", 404);
    if (row.kind !== "play") throw new DuelServiceError("Replay forks cannot change a series", 409);
    if (row.series_id !== null) assertPlaySeries(row.series_id);
    return row;
  };

  const byId = (seriesId: number): SeriesRow | undefined => selectSeries.get(seriesId);

  const requireSeries = (seriesId: number, guildId?: string): SeriesRow => {
    const row = selectSeries.get(seriesId);
    if (!row || (guildId !== undefined && row.guild_id !== guildId)) {
      throw new DuelServiceError("Duel series not found", 404);
    }
    assertPlaySeries(row.id);
    return row;
  };

  const playerName = (playerId: number): string => selectPlayerName.get(playerId)?.display_name ?? "";

  const summarize = (row: SeriesRow): DuelSeriesSummary => {
    assertPlaySeries(row.id);
    const latest = selectLatestGame.get(row.id);
    const link = row.tournament_match_id !== null ? selectTournamentLink.get(row.tournament_match_id) : undefined;
    const deck0 = parseSeriesDeck(row.deck0_json);
    const deck1 = parseSeriesDeck(row.deck1_json);
    return {
      id: row.id,
      bestOf: asBestOf(row.best_of),
      ranked: row.ranked === 1,
      status: row.status as DuelSeriesStatus,
      // A series against the practice bot: index 0 is the human, index 1 the bot (no player id).
      playerIds: [row.player0_id, row.vs_bot === 1 ? 0 : row.player1_id],
      displayNames: [playerName(row.player0_id), row.vs_bot === 1 ? PRACTICE_BOT_NAME : playerName(row.player1_id)],
      wins: [row.wins0, row.wins1],
      gameNumber: latest?.game_number ?? 1,
      currentDuelSlug: latest?.slug ?? null,
      winnerPlayerId: row.winner_player_id,
      tournamentId: link?.tournament_id ?? null,
      tournamentSlug: link?.web_slug ?? null,
      tournamentMatchId: row.tournament_match_id,
      nextGameAt: row.next_game_at,
      sideReady: [row.side_ready0 === 1, row.side_ready1 === 1],
      hasSide: [(deck0?.side.length ?? 0) > 0, (deck1?.side.length ?? 0) > 0],
      firstChooser: row.first_chooser === 0 ? 0 : row.first_chooser === 1 ? 1 : null,
      firstChoice: row.first_choice === "first" || row.first_choice === "second" ? row.first_choice : null,
      vsBot: row.vs_bot === 1,
    };
  };

  const playerIndex = (row: SeriesRow, playerId: number): 0 | 1 | null =>
    row.player0_id === playerId ? 0 : row.player1_id === playerId ? 1 : null;

  const requirePlayerIndex = (row: SeriesRow, playerId: number): 0 | 1 => {
    const index = playerIndex(row, playerId);
    if (index === null) throw new DuelServiceError("You are not a player in this series", 403);
    return index;
  };

  const insertGame = (input: {
    guildId: string;
    name: string;
    organizerPlayerId: number;
    mode: string;
    masterRule: number;
    settings: DuelSettings;
    seriesId: number;
    gameNumber: number;
    bestOf: DuelBestOf;
    ranked: boolean;
    seats: Array<{ playerId: number | null; deck: DuelDeck | null; ready: boolean; isBot?: boolean }>;
  }): { id: number; slug: string } => {
    const slug = generateWebSlug();
    const inviteCode = input.settings.visibility === "private" ? generateInviteCode() : null;
    const result = insertDuel.run(
      input.guildId,
      slug,
      input.name,
      input.organizerPlayerId,
      input.mode,
      input.masterRule,
      JSON.stringify(input.settings),
      inviteCode,
      input.seriesId,
      input.gameNumber,
      input.bestOf,
      input.ranked ? 1 : 0,
    );
    const id = Number(result.lastInsertRowid);
    input.seats.forEach((seat, index) => {
      insertSeat.run(id, index, seat.isBot ? null : seat.playerId, seat.isBot ? 1 : 0, seat.ready ? 1 : 0, seat.deck ? JSON.stringify(seat.deck) : null);
    });
    return { id, slug };
  };

  const cancelTx = db.transaction((seriesId: number, guildId: string) => {
    assertPlaySeries(seriesId);
    const changed = cancelSeries.run(seriesId, guildId).changes > 0;
    if (!changed) return { changedSlugs: [] as string[] };
    const games = selectLobbyGames.all(seriesId);
    for (const game of games) cancelLobbyGame.run(game.id);
    return { changedSlugs: games.map((game) => game.slug) };
  });

  /** True when the series belongs to a tournament that is no longer active. */
  const tournamentClosed = (row: SeriesRow): boolean =>
    row.tournament_match_id !== null &&
    (selectTournamentStatus.get(row.tournament_match_id)?.status ?? "cancelled") !== "active";

  /** Game 1 starts: attach an open table to a new series, preload challenge decks, lock tournament decks. */
  const onActivate = (duel: SeriesDuelRef, settings: DuelSettings) => {
    duel = storedPlayDuel(duel.id);
    const seats = selectSeatDecks.all(duel.id);
    if (duel.series_id === null) {
      const [first, second] = seats;
      if (seats.length !== 2 || !first || !second) return;
      const botSeat = seats.find((seat) => seat.is_bot === 1);
      if (botSeat) {
        // Only a Best of 3 against the practice bot makes a series; a single game against it stays a lone duel.
        const human = seats.find((seat) => seat.is_bot === 0);
        if (asBestOf(duel.best_of) !== 3 || !human || human.player_id === null) return;
        // Index 0 is the human, index 1 the bot. Nothing counts: the series is never ranked and records no match.
        const result = insertSeries.run(
          duel.guild_id,
          3,
          0,
          human.player_id,
          human.player_id,
          "active",
          duel.mode,
          duel.master_rule,
          JSON.stringify(settings),
          human.deck_json,
          botSeat.deck_json,
          human.deck_json,
          botSeat.deck_json,
          duel.organizer_player_id,
          null,
        );
        const seriesId = Number(result.lastInsertRowid);
        db.prepare<[number]>("update duel_series set vs_bot = 1 where id = ?").run(seriesId);
        db.prepare<[number, number]>("update duels set series_id = ?, game_number = 1, ranked = 0 where id = ?").run(seriesId, duel.id);
        return;
      }
      if (seats.some((seat) => seat.player_id === null)) return;
      const result = insertSeries.run(
        duel.guild_id,
        asBestOf(duel.best_of),
        duel.ranked === 1 ? 1 : 0,
        first.player_id as number,
        second.player_id as number,
        "active",
        duel.mode,
        duel.master_rule,
        JSON.stringify(settings),
        first.deck_json,
        second.deck_json,
        first.deck_json,
        second.deck_json,
        duel.organizer_player_id,
        null,
      );
      db.prepare<[number, number]>("update duels set series_id = ?, game_number = 1 where id = ?").run(
        Number(result.lastInsertRowid),
        duel.id,
      );
      return;
    }
    const series = selectSeries.get(duel.series_id);
    if (!series) return;
    const deckOf = (playerId: number) => seats.find((seat) => seat.is_bot === 0 && seat.player_id === playerId)?.deck_json ?? null;
    const deck0 = deckOf(series.player0_id);
    const deck1 = series.vs_bot === 1 ? (seats.find((seat) => seat.is_bot === 1)?.deck_json ?? null) : deckOf(series.player1_id);
    db.prepare<[string | null, string | null, string | null, string | null, number]>(
      `
        update duel_series
        set base_deck0_json = coalesce(base_deck0_json, ?), base_deck1_json = coalesce(base_deck1_json, ?),
            deck0_json = coalesce(deck0_json, ?), deck1_json = coalesce(deck1_json, ?)
        where id = ?
      `,
    ).run(deck0, deck1, deck0, deck1, series.id);
    if (series.tournament_match_id !== null) {
      lockDecks.run(series.tournament_match_id, series.player0_id, series.player1_id);
    }
  };

  // Inside finalization or retry, this savepoint isolates all recording writes,
  // including bracket progression, scoring and the series link.
  const recordResultTx = db.transaction((series: SeriesRow, winnerPlayerId: number): Match => {
    assertPlaySeries(series.id);
    const source = selectLatestGame.get(series.id);
    if (!source) throw new DuelServiceError("Source duel not found", 409);
    storedPlayDuel(source.id);
    const match = matches.recordConfirmedResult({
      guildId: series.guild_id,
      sourceDuelId: source.id,
      playerOneId: series.player0_id,
      playerTwoId: series.player1_id,
      winnerId: winnerPlayerId,
      source: series.tournament_match_id !== null ? "tournament" : "casual",
      tournamentMatchId: series.tournament_match_id,
    }, { strictScoring: true });
    db.prepare<[number, number]>("update duel_series set match_id = ? where id = ?").run(match.id, series.id);
    return match;
  });

  const retryResultTx = db.transaction((seriesId: number, guildId: string): SeriesResultRetry => {
    const series = requireSeries(seriesId, guildId);
    if (series.match_id !== null) {
      const match = selectRecordedMatch.get(series.match_id, guildId);
      if (!match) throw new DuelServiceError("Recorded match not found", 404);
      return { ok: true, match };
    }
    if (
      series.status !== "completed" || series.winner_player_id === null || series.vs_bot === 1 ||
      (series.ranked !== 1 && series.tournament_match_id === null)
    ) {
      throw new DuelServiceError("This series has no result awaiting recording", 409);
    }
    if (selectSupersededResult.get(series.id)) {
      return { ok: false, error: "superseded", code: "superseded" };
    }
    if (selectNeedsReconciliation.get(series.id)) {
      return { ok: false, error: "needs_reconciliation", code: "needs_reconciliation" };
    }
    return { ok: true, match: recordResultTx(series, series.winner_player_id) };
  });

  /** A game ended. Runs in the same transaction as the duel update. */
  const onGameFinished = (
    duel: { id: number; series_id: number | null; game_number: number | null },
    status: "completed" | "interrupted",
    winnerPlayerId: number | null,
    winnerIsBot = false,
  ) => {
    duel = storedPlayDuel(duel.id);
    if (duel.series_id === null) return;
    const series = selectSeries.get(duel.series_id);
    if (!series || series.status !== "active") return;
    const latest = selectLatestGame.get(series.id);
    if (!latest || latest.id !== duel.id) return;

    if (tournamentClosed(series)) {
      // The tournament ended while this game was live: close the series and record nothing.
      cancelTx(series.id, series.guild_id);
      return;
    }

    const now = Date.now();
    const tournament = series.tournament_match_id !== null;
    const needed = series.best_of === 3 ? 2 : 1;
    const vsBot = series.vs_bot === 1;
    // `chooser` is the series index of the loser of a decided game; null keeps the seat swap (draw, interrupt).
    // The practice bot is always ready, and when it lost it chooses to go first at once.
    const betweenGames = (
      wins0: number,
      wins1: number,
      nextGameAt: string | null,
      ready0: number,
      ready1: number,
      chooser: 0 | 1 | null = null,
    ) => {
      db.prepare<[number, number, string | null, number, number, number | null, string | null, number]>(
        `
          update duel_series
          set status = 'between_games', wins0 = ?, wins1 = ?, next_game_at = ?, side_ready0 = ?, side_ready1 = ?,
              first_chooser = ?, first_choice = ?
          where id = ?
        `,
      ).run(wins0, wins1, nextGameAt, ready0, vsBot ? 1 : ready1, chooser, vsBot && chooser === 1 ? "first" : null, series.id);
    };
    const sideWindow = (wins0: number, wins1: number, chooser: 0 | 1 | null = null) =>
      betweenGames(
        wins0,
        wins1,
        new Date(now + SERIES_SIDE_WINDOW_MS).toISOString(),
        // Every human must explicitly click Ready, even with no Side Deck or a saved turn choice.
        0,
        0,
        chooser,
      );

    if (status === "interrupted") {
      betweenGames(series.wins0, series.wins1, null, 0, 0);
      return;
    }

    const winnerIndex = winnerIsBot && vsBot ? 1 : winnerPlayerId === null ? null : playerIndex(series, winnerPlayerId);
    if (winnerIndex === null) {
      // Draw: no win for either player.
      if (series.best_of === 1 && !tournament) {
        db.prepare<[number]>(
          "update duel_series set status = 'completed', next_game_at = null, ended_at = datetime('now') where id = ?",
        ).run(series.id);
      } else if (series.best_of === 1) {
        betweenGames(series.wins0, series.wins1, new Date(now).toISOString(), 1, 1);
      } else {
        sideWindow(series.wins0, series.wins1);
      }
      return;
    }

    const wins0 = series.wins0 + (winnerIndex === 0 ? 1 : 0);
    const wins1 = series.wins1 + (winnerIndex === 1 ? 1 : 0);
    if ((winnerIndex === 0 ? wins0 : wins1) < needed) {
      sideWindow(wins0, wins1, winnerIndex === 0 ? 1 : 0);
      return;
    }

    // Remember insertion order before recording: timestamps have only second
    // precision, and a denied result survives organizer reopening of the slot.
    db.prepare<[number, number, number | null, number]>(
      `
        update duel_series
        set status = 'completed', wins0 = ?, wins1 = ?, winner_player_id = ?, next_game_at = null, ended_at = datetime('now'),
          settings_json = case when tournament_match_id is null then settings_json
            else json_set(settings_json, '$.resultMatchIdWatermark', (select coalesce(max(id), 0) from matches)) end
        where id = ?
      `,
    ).run(wins0, wins1, winnerIsBot ? null : (winnerPlayerId as number), series.id);
    // A series against the practice bot never counts.
    if (vsBot || (!tournament && series.ranked !== 1)) return;
    try {
      recordResultTx(series, winnerPlayerId as number);
    } catch (error) {
      console.error("[duel-series] recording the series result failed", {
        seriesId: series.id,
        tournamentMatchId: series.tournament_match_id,
        duelId: duel.id,
        error,
      });
    }
  };

  return {
    byId,
    requireSeries,
    summarize,
    /** Completed wins that should have a match but have not been recorded yet. */
    listUnrecordedResults(guildId: string): Array<SeriesRow & { needsReconciliation?: boolean }> {
      return selectUnrecordedResults.all(guildId).map(({ needsReconciliation, ...row }) =>
        needsReconciliation ? { ...row, needsReconciliation: true } : row,
      );
    },
    /** Repairs only recording; an existing match is returned without any writes. */
    retryResult(seriesId: number, guildId: string): SeriesResultRetry {
      try {
        return retryResultTx(seriesId, guildId);
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
    summaryById(seriesId: number): DuelSeriesSummary | null {
      const row = selectSeries.get(seriesId);
      return row ? summarize(row) : null;
    },
    summaryForDuel(duelId: number): DuelSeriesSummary | null {
      const link = selectDuelSeries.get(duelId);
      if (!link || link.series_id === null) return null;
      const row = selectSeries.get(link.series_id);
      return row ? summarize(row) : null;
    },
    playerIndex,
    requirePlayerIndex,
    /** The viewer's base and current decks, or null while the series has no decks yet. */
    sideState(row: SeriesRow, playerId: number): DuelSeriesSideState | null {
      const index = requirePlayerIndex(row, playerId);
      const current = parseSeriesDeck(index === 0 ? row.deck0_json : row.deck1_json);
      const base = parseSeriesDeck(index === 0 ? row.base_deck0_json : row.base_deck1_json) ?? current;
      if (!current || !base) return null;
      return { baseDeck: base, currentDeck: current };
    },
    insertGame,
    /** Inserts a series row; returns its id. */
    insertSeries(...params: InsertSeriesParams): number {
      return Number(insertSeries.run(...params).lastInsertRowid);
    },
    latestGame(seriesId: number): GameRow | undefined {
      return selectLatestGame.get(seriesId);
    },
    game1Name(seriesId: number): string | null {
      return selectGame1Name.get(seriesId)?.name ?? null;
    },
    gameSeats(duelId: number): Array<{ seat: number; player_id: number | null; is_bot: number }> {
      return selectLastGameSeats.all(duelId);
    },
    cancel(seriesId: number, guildId: string) {
      return cancelTx(seriesId, guildId);
    },
    tournamentClosed,
    lockDecks(tournamentMatchId: number, player0Id: number, player1Id: number) {
      lockDecks.run(tournamentMatchId, player0Id, player1Id);
    },
    onActivate,
    onGameFinished,
  };
}

export type DuelSeriesStore = ReturnType<typeof createSeriesStore>;

export function createDuelSeriesService(db: Database.Database): DuelSeriesService {
  const store = createSeriesStore(db);
  const duels = createDuelService(db);

  const selectPlayer = db.prepare<[number], { guild_id: string; user_id: number; discord_user_id: string | null; display_name: string }>(
    "select guild_id, user_id, discord_user_id, display_name from players where id = ?",
  );
  const assertPlayerGuild = (playerId: number, guildId: string) => {
    const player = selectPlayer.get(playerId);
    if (!player || player.guild_id !== guildId) {
      throw new DuelServiceError("Player must belong to the same guild as the duel", 400);
    }
    return player;
  };
  const selectSlot = db.prepare<
    [number],
    {
      id: number;
      tournament_id: number;
      match_id: number | null;
      player_one_id: number;
      player_two_id: number | null;
      round_number: number;
      status: string;
    }
  >("select id, tournament_id, match_id, player_one_id, player_two_id, round_number, status from tournament_matches where id = ?");
  const selectTournament = db.prepare<
    [number],
    {
      id: number;
      guild_id: string;
      name: string;
      status: string;
      created_by_user_id: number;
      best_of: number | null;
      duel_rules_json: string | null;
      draft_id: number | null;
    }
  >(`
    select t.id, t.guild_id, t.name, t.status, t.created_by_user_id, t.best_of, t.duel_rules_json,
      (select d.id from drafts d where d.tournament_id = t.id order by d.id limit 1) as draft_id
    from tournaments t
    where t.id = ?
  `);
  const selectParticipantDeck = db.prepare<[number, number], { deck_json: string | null }>(
    "select deck_json from tournament_participants where tournament_id = ? and player_id = ?",
  );
  const selectOpenForSlot = db.prepare<[number], { id: number }>(
    "select id from duel_series where tournament_match_id = ? and status in ('active', 'between_games') limit 1",
  );
  const selectUnrecordedForSlot = db.prepare<[number], { id: number }>(
    `select id from duel_series where tournament_match_id = ? and ${UNRECORDED_RESULT_FILTER} limit 1`,
  );
  const updateDeck0 = db.prepare<[string, number]>("update duel_series set deck0_json = ? where id = ?");
  const updateDeck1 = db.prepare<[string, number]>("update duel_series set deck1_json = ? where id = ?");
  const markSideReady0 = db.prepare<[number]>("update duel_series set side_ready0 = 1 where id = ?");
  const markSideReady1 = db.prepare<[number]>("update duel_series set side_ready1 = 1 where id = ?");
  const clearSideReady0 = db.prepare<[number]>("update duel_series set side_ready0 = 0 where id = ?");
  const clearSideReady1 = db.prepare<[number]>("update duel_series set side_ready1 = 0 where id = ?");
  const resetToActive = db.prepare<[number]>(
    "update duel_series set status = 'active', side_ready0 = 0, side_ready1 = 0, next_game_at = null, first_chooser = null, first_choice = null where id = ?",
  );
  const inheritInviteGrants = db.prepare<[number, number]>(
    `insert or ignore into duel_invite_grants (duel_id, player_id)
     select ?, player_id from duel_invite_grants where duel_id = ?`,
  );
  const updateFirstChoice = db.prepare<[string, number]>("update duel_series set first_choice = ? where id = ?");
  const selectDueNext = db.prepare<[string, number], { seriesId: number; guildId: string }>(
    `
      select id as seriesId, guild_id as guildId
      from duel_series
      where status = 'between_games'
        and not exists (select 1 from duels f where f.series_id = duel_series.id and f.kind != 'play')
        and ((side_ready0 = 1 and side_ready1 = 1 and (first_chooser is null or first_choice is not null))
          or (next_game_at is not null and next_game_at <= ?))
      order by id asc
      limit ?
    `,
  );
  const selectDueStarts = db.prepare<[number], { slug: string; guildId: string }>(
    `
      select d.web_slug as slug, d.guild_id as guildId
      from duels d
      join duel_series s on s.id = d.series_id
      where d.kind = 'play' and d.status = 'lobby'
        and not exists (select 1 from duels f where f.series_id = s.id and f.kind != 'play')
        and s.status = 'active'
        and (select count(*) from duel_seats x where x.duel_id = d.id and x.ready = 1) = 2
      order by d.id asc
      limit ?
    `,
  );

  const createChallengeTx = db.transaction((input: CreateChallengeInput): SeriesGameStart => {
    if (input.bestOf !== 1 && input.bestOf !== 3) throw new DuelServiceError("Best of must be 1 or 3", 400);
    if (typeof input.ranked !== "boolean") throw new DuelServiceError("Ranked must be true or false", 400);
    if (!isDuelMode(input.mode)) throw new DuelServiceError("Duel mode must be normal or domain", 400);
    if (input.challengerPlayerId === input.opponentPlayerId) {
      throw new DuelServiceError("You cannot challenge yourself", 400);
    }
    const challenger = assertPlayerGuild(input.challengerPlayerId, input.guildId);
    const opponent = assertPlayerGuild(input.opponentPlayerId, input.guildId);
    const masterRule = resolveMasterRule(input.mode, input.masterRule);
    const settings: DuelSettings = {
      ...wrapSettingsError(() => normalizeDuelSettings(input.mode, input.settings)),
      visibility: "private",
    };
    const name = input.name?.trim() || `${challenger.display_name} vs ${opponent.display_name}`;

    const seriesId = store.insertSeries(
      input.guildId,
      input.bestOf,
      input.ranked ? 1 : 0,
      input.challengerPlayerId,
      input.opponentPlayerId,
      "active",
      input.mode,
      masterRule,
      JSON.stringify(settings),
      null,
      null,
      null,
      null,
      input.challengerPlayerId,
      null,
    );
    const order = randomInt(2) === 0
      ? [input.challengerPlayerId, input.opponentPlayerId]
      : [input.opponentPlayerId, input.challengerPlayerId];
    const game = store.insertGame({
      guildId: input.guildId,
      name,
      organizerPlayerId: input.challengerPlayerId,
      mode: input.mode,
      masterRule,
      settings,
      seriesId,
      gameNumber: 1,
      bestOf: input.bestOf,
      ranked: input.ranked,
      seats: order.map((playerId) => ({ playerId, deck: null, ready: false })),
    });
    return {
      series: store.summarize(store.requireSeries(seriesId)),
      duel: duels.get(game.slug, input.guildId),
      created: true,
    };
  });

  const startTournamentMatchTx = db.transaction(
    (input: { guildId: string; tournamentMatchId: number; actorPlayerId: number }): SeriesGameStart => {
      const slot = selectSlot.get(input.tournamentMatchId);
      const tournament = slot ? selectTournament.get(slot.tournament_id) : undefined;
      if (!slot || !tournament || tournament.guild_id !== input.guildId) {
        throw new DuelServiceError("Tournament match not found", 404);
      }
      if (slot.player_two_id === null) throw new DuelServiceError("A bye has no duel to play", 400);
      const actor = assertPlayerGuild(input.actorPlayerId, input.guildId);
      const isPlayer = input.actorPlayerId === slot.player_one_id || input.actorPlayerId === slot.player_two_id;
      if (!isPlayer && actor.user_id !== tournament.created_by_user_id) {
        throw new DuelServiceError("Only a match player or the tournament organizer can start this duel", 403);
      }
      if (tournament.status !== "active") throw new DuelServiceError("Tournament is not active", 409);

      const slotName = `${tournament.name} · Round ${slot.round_number}`;
      const playerTwoId = slot.player_two_id;
      // Game 1 of a tournament series: decks preloaded, nobody ready, random seat order.
      const insertFirstGame = (
        series: { id: number; bestOf: DuelBestOf; mode: string; masterRule: number },
        settings: DuelSettings,
        decks: [string, string],
      ) => {
        const order = randomInt(2) === 0 ? [slot.player_one_id, playerTwoId] : [playerTwoId, slot.player_one_id];
        return store.insertGame({
          guildId: input.guildId,
          name: slotName,
          organizerPlayerId: slot.player_one_id,
          mode: series.mode,
          masterRule: series.masterRule,
          settings,
          seriesId: series.id,
          gameNumber: 1,
          bestOf: series.bestOf,
          ranked: false,
          seats: order.map((playerId) => ({
            playerId,
            deck: JSON.parse(playerId === slot.player_one_id ? decks[0] : decks[1]) as DuelDeck,
            ready: false,
          })),
        });
      };
      // An open series already exists: return it, giving it game 1 first if it has none.
      const resumeOpenSeries = (seriesId: number): SeriesGameStart => {
        const series = store.requireSeries(seriesId);
        const latest = store.latestGame(seriesId);
        if (!latest) {
          const deck0Json = series.deck0_json ?? series.base_deck0_json;
          const deck1Json = series.deck1_json ?? series.base_deck1_json;
          if (!deck0Json || !deck1Json) throw new DuelServiceError("This series has no decks yet", 409);
          const game = insertFirstGame(
            { id: series.id, bestOf: asBestOf(series.best_of), mode: series.mode, masterRule: series.master_rule },
            wrapSettingsError(() => parseStoredDuelSettings(series.settings_json), 500),
            [deck0Json, deck1Json],
          );
          store.lockDecks(slot.id, slot.player_one_id, playerTwoId);
          return {
            series: store.summarize(store.requireSeries(seriesId)),
            duel: duels.get(game.slug, input.guildId),
            created: false,
          };
        }
        return {
          series: store.summarize(series),
          duel: duels.get(latest.slug, input.guildId),
          created: false,
        };
      };

      const existing = selectOpenForSlot.get(slot.id);
      if (existing) return resumeOpenSeries(existing.id);
      if (selectUnrecordedForSlot.get(slot.id)) {
        throw new DuelServiceError("A completed series for this match is awaiting result recording", 409);
      }
      if (slot.status === "pending_approval" || slot.match_id !== null) {
        throw new DuelServiceError("A manual result for this match is waiting for approval", 409);
      }
      if (slot.status !== "open") throw new DuelServiceError("This match is already complete", 409);

      const deck0 = selectParticipantDeck.get(slot.tournament_id, slot.player_one_id)?.deck_json ?? null;
      const deck1 = selectParticipantDeck.get(slot.tournament_id, playerTwoId)?.deck_json ?? null;
      if (!deck0 || !deck1) {
        throw new DuelServiceError("Both players must register a deck before the duel can start", 409);
      }

      const rules = resolveTournamentDuelRules(tournament);
      let seriesId: number;
      try {
        seriesId = store.insertSeries(
          input.guildId,
          rules.bestOf,
          0,
          slot.player_one_id,
          playerTwoId,
          "active",
          rules.mode,
          rules.masterRule,
          JSON.stringify(rules.settings),
          deck0,
          deck1,
          deck0,
          deck1,
          slot.player_one_id,
          slot.id,
        );
      } catch (error) {
        // A concurrent start inserted the open series first: return that one.
        if ((error as { code?: string }).code === "SQLITE_CONSTRAINT_UNIQUE") {
          const winner = selectOpenForSlot.get(slot.id);
          if (winner) return resumeOpenSeries(winner.id);
        }
        throw error;
      }
      // The decks are the series' snapshot from now on, so they cannot change.
      store.lockDecks(slot.id, slot.player_one_id, playerTwoId);
      const game = insertFirstGame(
        { id: seriesId, bestOf: rules.bestOf, mode: rules.mode, masterRule: rules.masterRule },
        rules.settings,
        [deck0, deck1],
      );
      return {
        series: store.summarize(store.requireSeries(seriesId)),
        duel: duels.get(game.slug, input.guildId),
        created: true,
      };
    },
  );

  const setSideDeckTx = db.transaction(
    (seriesId: number, guildId: string, playerId: number, deck: DuelDeck, resolve?: (code: number) => number): { series: DuelSeriesSummary; readyCleared: boolean } => {
      const row = store.requireSeries(seriesId, guildId);
      const index = store.requirePlayerIndex(row, playerId);
      if (row.status !== "between_games") {
        throw new DuelServiceError("Side decking is only open between games", 409);
      }
      const state = store.sideState(row, playerId);
      if (!state) throw new DuelServiceError("This series has no decks yet", 409);
      const next = validateDuelDeckShape(deck, false);
      if (!sameCounts(deckCardCounts(next, resolve), deckCardCounts(state.currentDeck, resolve))) {
        throw new DuelServiceError("A sided deck must use the same cards as your current deck", 400);
      }
      if (next.side.length !== state.currentDeck.side.length) {
        throw new DuelServiceError("The side deck must keep the same number of cards", 400);
      }
      if (next.main.length !== state.currentDeck.main.length) {
        throw new DuelServiceError("The main deck must keep the same number of cards", 400);
      }
      if (next.extra.length !== state.currentDeck.extra.length) {
        throw new DuelServiceError("The extra deck must keep the same number of cards", 400);
      }
      const minMain = Math.min(SIDE_DECK_MIN_MAIN, state.baseDeck.main.length);
      if (next.main.length < minMain || next.main.length > SIDE_DECK_MAX_MAIN) {
        throw new DuelServiceError(`Main deck must have between ${minMain} and ${SIDE_DECK_MAX_MAIN} cards`, 400);
      }
      (index === 0 ? updateDeck0 : updateDeck1).run(JSON.stringify(next), row.id);
      const wasReady = (index === 0 ? row.side_ready0 : row.side_ready1) === 1;
      const changed = !sameDeckLayout(next, state.currentDeck);
      if (changed) {
        // Ready confirmed the old deck. Cleared in the same transaction as the deck write, so no advance
        // (the ready path or the tick sweep) can see the new deck together with the old Ready.
        (index === 0 ? clearSideReady0 : clearSideReady1).run(row.id);
      }
      return { series: store.summarize(store.requireSeries(row.id)), readyCleared: wasReady && changed };
    },
  );

  const setSideReadyTx = db.transaction((seriesId: number, guildId: string, playerId: number): DuelSeriesSummary => {
    const row = store.requireSeries(seriesId, guildId);
    const index = store.requirePlayerIndex(row, playerId);
    if (row.status !== "between_games") throw new DuelServiceError("The series is not between games", 409);
    (index === 0 ? markSideReady0 : markSideReady1).run(row.id);
    // Ready without a choice keeps the default: the loser goes first.
    if (row.first_chooser === index && row.first_choice === null) updateFirstChoice.run("first", row.id);
    return store.summarize(store.requireSeries(row.id));
  });

  const clearSideReadyTx = db.transaction(
    (seriesId: number, guildId: string, playerId: number): { series: DuelSeriesSummary; readyCleared: boolean } => {
      const row = store.requireSeries(seriesId, guildId);
      const index = store.requirePlayerIndex(row, playerId);
      if (row.status !== "between_games") throw new DuelServiceError("The series is not between games", 409);
      const wasReady = (index === 0 ? row.side_ready0 : row.side_ready1) === 1;
      if (wasReady) (index === 0 ? clearSideReady0 : clearSideReady1).run(row.id);
      return { series: store.summarize(store.requireSeries(row.id)), readyCleared: wasReady };
    },
  );

  const setFirstChoiceTx = db.transaction(
    (seriesId: number, guildId: string, playerId: number, choice: DuelFirstChoice): DuelSeriesSummary => {
      if (choice !== "first" && choice !== "second") throw new DuelServiceError("Choose first or second", 400);
      const row = store.requireSeries(seriesId, guildId);
      const index = store.requirePlayerIndex(row, playerId);
      if (row.status !== "between_games") throw new DuelServiceError("The series is not between games", 409);
      if (row.first_chooser === null) {
        throw new DuelServiceError("The seats swap after a draw or an unfinished game, so nobody chooses", 409);
      }
      if (row.first_chooser !== index) throw new DuelServiceError("Only the loser of the last game chooses who goes first", 403);
      updateFirstChoice.run(choice, row.id);
      return store.summarize(store.requireSeries(row.id));
    },
  );

  /** Null when the series was closed because its tournament is no longer active (the caller throws after the commit). */
  const createNextGameTx = db.transaction((seriesId: number, guildId: string): DuelSession | null => {
    const row = store.requireSeries(seriesId, guildId);
    if (row.status === "completed" || row.status === "cancelled") {
      throw new DuelServiceError("This series is over", 409);
    }
    if (store.tournamentClosed(row)) {
      store.cancel(row.id, guildId);
      return null;
    }
    const latest = store.latestGame(row.id);
    if (row.status === "active" && latest && (latest.status === "lobby" || latest.status === "active")) {
      return duels.get(latest.slug, guildId);
    }
    const deck0 = parseSeriesDeck(row.deck0_json ?? row.base_deck0_json);
    const deck1 = parseSeriesDeck(row.deck1_json ?? row.base_deck1_json);
    if (!deck0 || !deck1) throw new DuelServiceError("This series has no decks yet", 409);

    // The loser of the last game chooses to go first or second (default first); after a draw or an
    // interrupt the seats swap. `firstIndex` is the series index (0 or 1) who takes seat 0. Against the
    // practice bot, index 0 is the human and index 1 the bot.
    let firstIndex: 0 | 1 = 0;
    if (latest) {
      const lastSeats = store.gameSeats(latest.id);
      const indexOfSeat = (seat: { player_id: number | null; is_bot: number } | undefined, fallback: 0 | 1): 0 | 1 =>
        !seat ? fallback : seat.is_bot === 1 ? 1 : seat.player_id === row.player0_id ? 0 : 1;
      if (row.first_chooser !== null) {
        const chooser: 0 | 1 = row.first_chooser === 0 ? 0 : 1;
        firstIndex = row.first_choice === "second" ? (chooser === 0 ? 1 : 0) : chooser;
      } else if (latest.status === "completed" && latest.winner_player_id !== null && row.vs_bot !== 1) {
        // A series that was between games before the choice existed: the loser goes first.
        firstIndex = latest.winner_player_id === row.player0_id ? 1 : 0;
      } else {
        // The seats swap: the player who was second goes first.
        firstIndex = indexOfSeat(lastSeats[0], 0) === 0 ? 1 : 0;
      }
    }

    const baseName = (store.game1Name(row.id) ?? latest?.name ?? "Duel").replace(/ · Game \d+$/, "");
    const gameNumber = (latest?.game_number ?? 0) + 1;
    const settings = wrapSettingsError(() => parseStoredDuelSettings(row.settings_json), 500);
    const game = store.insertGame({
      guildId,
      name: `${baseName} · Game ${gameNumber}`,
      organizerPlayerId: row.created_by_player_id,
      mode: row.mode,
      masterRule: row.master_rule,
      settings,
      seriesId: row.id,
      gameNumber,
      bestOf: row.best_of === 3 ? 3 : 1,
      ranked: row.ranked === 1,
      seats: [firstIndex, firstIndex === 0 ? 1 : 0].map((index) => {
        if (index === 1 && row.vs_bot === 1) return { playerId: null, isBot: true, deck: deck1, ready: true };
        return { playerId: index === 0 ? row.player0_id : row.player1_id, deck: index === 0 ? deck0 : deck1, ready: true };
      }),
    });
    // Admission follows the series, including grants inherited by the previous game.
    if (latest) inheritInviteGrants.run(game.id, latest.id);
    resetToActive.run(row.id);
    return duels.get(game.slug, guildId);
  });

  return {
    createChallenge(input) {
      return createChallengeTx(input);
    },
    startTournamentMatch(input) {
      return startTournamentMatchTx(input);
    },
    get(seriesId, guildId) {
      return store.summarize(store.requireSeries(seriesId, guildId));
    },
    forDuel(duelId) {
      return store.summaryForDuel(duelId);
    },
    openForTournamentMatch(tournamentMatchId) {
      const open = selectOpenForSlot.get(tournamentMatchId);
      return open ? store.summaryById(open.id) : null;
    },
    sideState(seriesId, guildId, playerId) {
      const row = store.requireSeries(seriesId, guildId);
      const state = store.sideState(row, playerId);
      if (!state) throw new DuelServiceError("This series has no decks yet", 409);
      return state;
    },
    setSideDeck(seriesId, guildId, playerId, deck, resolve) {
      return setSideDeckTx(seriesId, guildId, playerId, deck, resolve).series;
    },
    saveSideDeck(seriesId, guildId, playerId, deck, resolve) {
      return setSideDeckTx(seriesId, guildId, playerId, deck, resolve);
    },
    setFirstChoice(seriesId, guildId, playerId, choice) {
      return setFirstChoiceTx(seriesId, guildId, playerId, choice);
    },
    setSideReady(seriesId, guildId, playerId) {
      return setSideReadyTx(seriesId, guildId, playerId);
    },
    clearSideReady(seriesId, guildId, playerId) {
      return clearSideReadyTx(seriesId, guildId, playerId);
    },
    dueNextGames(nowMs, limit) {
      const cap = Math.min(Math.max(1, Math.floor(limit)), DUE_CAP);
      return selectDueNext.all(new Date(Math.floor(nowMs)).toISOString(), cap);
    },
    dueStarts(limit) {
      const cap = Math.min(Math.max(1, Math.floor(limit)), DUE_CAP);
      return selectDueStarts.all(cap);
    },
    createNextGame(seriesId, guildId) {
      const game = createNextGameTx(seriesId, guildId);
      // Thrown after the commit so the series stays cancelled.
      if (!game) throw new DuelServiceError("This series is over: its tournament is no longer active", 409);
      return game;
    },
    cancel(seriesId, guildId) {
      return store.cancel(seriesId, guildId);
    },
  };
}
