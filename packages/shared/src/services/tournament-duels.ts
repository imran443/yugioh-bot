import type Database from "better-sqlite3";
import type { DuelBestOf, DuelDeck, DuelMasterRule, DuelMode, DuelSettings } from "../duels/index.js";
import { DuelSettingsError, NO_BANLIST_ID, normalizeDuelSettings } from "../duels/settings.js";
import { createDuelSeriesService } from "./duel-series.js";
import { createMatchService } from "./matches.js";

export class TournamentDuelError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "TournamentDuelError";
    this.status = status;
  }
}

/** The rules every online game of a tournament uses. */
export interface TournamentDuelRules {
  bestOf: DuelBestOf;
  mode: DuelMode;
  masterRule: DuelMasterRule;
  /** Normalized; visibility is always public for tournament games, so anyone in the guild can watch. */
  settings: DuelSettings;
  /** Set when the tournament was made from a draft (drafts.tournament_id). */
  draftId: number | null;
}

export interface TournamentDeckRegistration {
  tournamentId: number;
  playerId: number;
  savedDeckId: number | null;
  /** Copy taken at registration. */
  deck: DuelDeck;
  registeredAt: string;
  /** Set when the player's first tournament game starts; the deck cannot change after that. */
  lockedAt: string | null;
}

export interface TournamentDuelService {
  rules(tournamentId: number): TournamentDuelRules;
  /**
   * True when `setRules` would refuse a change for state reasons: the
   * tournament is closed, or a tournament game has started (a series exists or
   * a deck is locked).
   */
  rulesLocked(tournamentId: number): boolean;
  /**
   * Organizer only. Allowed until the first tournament game starts. Draft
   * tournaments keep their fixed rules (no banlist, validateDeck false) and
   * accept only bestOf.
   */
  setRules(
    tournamentId: number,
    organizerUserId: number,
    input: { bestOf?: DuelBestOf; mode?: DuelMode; masterRule?: DuelMasterRule; settings?: unknown },
  ): TournamentDuelRules;
  registration(tournamentId: number, playerId: number): TournamentDeckRegistration | null;
  /** One row per participant, for the tournament page. */
  registrations(tournamentId: number): Array<{ playerId: number; registered: boolean; lockedAt: string | null }>;
  /**
   * Stores a copy of the deck. The caller has already checked the deck against
   * the rules (and the draft pool). The service checks: the player is a
   * participant, the deck is not locked, the tournament is pending or active,
   * and for a draft tournament the saved deck has draft_id = the tournament's
   * draft and belongs to the player.
   */
  registerDeck(input: {
    tournamentId: number;
    playerId: number;
    savedDeckId: number | null;
    deck: DuelDeck;
  }): TournamentDeckRegistration;
  /** Sets deck_locked_at if it is not set. Idempotent. */
  lockDeck(tournamentId: number, playerId: number): void;
  /**
   * Organizer sets the result of an open or pending_approval slot: cancels an
   * open series of the slot, denies a pending manual report, then records an
   * approved result through matches.recordConfirmedResult.
   */
  setResultByOrganizer(input: {
    tournamentMatchId: number;
    organizerUserId: number;
    winnerPlayerId: number;
  }): {
    tournamentId: number;
    /** Games of the cancelled series (lobby game cancelled, latest game); empty when no series was open. */
    changedDuelSlugs: string[];
    /** True when this result finished the tournament. */
    tournamentCompleted: boolean;
  };
}

type TournamentRulesRow = {
  best_of: number | null;
  duel_rules_json: string | null;
  draft_id: number | null;
};

/**
 * Rules for a tournament row. A draft tournament always uses a normal duel,
 * Master Rule 5, no banlist and no deck legality check (the pool is the
 * limit); only its match length can change. Visibility is always public: anyone
 * in the guild can watch a tournament game. Seats stay fixed to the two players
 * (takeSeat refuses series games) and spectators only get the public board.
 */
export function resolveTournamentDuelRules(row: TournamentRulesRow): TournamentDuelRules {
  const bestOf: DuelBestOf = row.best_of === 1 ? 1 : 3;
  const draftId = row.draft_id ?? null;
  if (draftId !== null) {
    const settings = normalizeDuelSettings("normal", { banlist: NO_BANLIST_ID, validateDeck: false });
    return { bestOf, mode: "normal", masterRule: 5, settings: { ...settings, visibility: "public" }, draftId };
  }
  let stored: { mode?: unknown; masterRule?: unknown; settings?: unknown } = {};
  if (row.duel_rules_json) {
    try {
      const parsed: unknown = JSON.parse(row.duel_rules_json);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) stored = parsed as typeof stored;
    } catch {
      // Bad stored rules fall back to the defaults.
    }
  }
  const mode: DuelMode = stored.mode === "domain" ? "domain" : "normal";
  const masterRule: DuelMasterRule = [1, 2, 3, 4, 5].includes(stored.masterRule as number)
    ? (stored.masterRule as DuelMasterRule)
    : 5;
  let settings: DuelSettings;
  try {
    settings = normalizeDuelSettings(mode, stored.settings);
  } catch {
    settings = normalizeDuelSettings(mode, undefined);
  }
  return { bestOf, mode, masterRule, settings: { ...settings, visibility: "public" }, draftId };
}

/**
 * Validates and serializes the rules stored in tournaments.duel_rules_json.
 * Shared by the tournament create/update paths. Throws TournamentDuelError (400).
 */
export function serializeTournamentDuelRules(input: {
  mode?: unknown;
  masterRule?: unknown;
  settings?: unknown;
}, current?: { mode: DuelMode; masterRule: DuelMasterRule; settings: DuelSettings }): string {
  if (input.mode !== undefined && input.mode !== "normal" && input.mode !== "domain") {
    throw new TournamentDuelError("Duel mode must be normal or domain", 400);
  }
  if (input.masterRule !== undefined && ![1, 2, 3, 4, 5].includes(input.masterRule as number)) {
    throw new TournamentDuelError("Master Rule must be 1 to 5", 400);
  }
  const mode: DuelMode = (input.mode as DuelMode | undefined) ?? current?.mode ?? "normal";
  const masterRule: DuelMasterRule = (input.masterRule as DuelMasterRule | undefined) ?? current?.masterRule ?? 5;
  let settings: DuelSettings;
  try {
    settings =
      input.settings === undefined && current && current.mode === mode
        ? current.settings
        : normalizeDuelSettings(mode, input.settings);
  } catch (error) {
    if (error instanceof DuelSettingsError) throw new TournamentDuelError(error.message, 400);
    throw error;
  }
  return JSON.stringify({ mode, masterRule, settings: { ...settings, visibility: "public" } });
}

function assertBestOf(value: unknown): asserts value is DuelBestOf {
  if (value !== 1 && value !== 3) throw new TournamentDuelError("Best of must be 1 or 3", 400);
}

type TournamentRow = {
  id: number;
  guild_id: string;
  status: string;
  created_by_user_id: number;
};

type RegistrationRow = {
  saved_deck_id: number | null;
  deck_json: string | null;
  deck_registered_at: string | null;
  deck_locked_at: string | null;
};

function parseDeck(raw: string): DuelDeck {
  const parsed = JSON.parse(raw) as DuelDeck;
  const deck: DuelDeck = { main: parsed.main, extra: parsed.extra, side: parsed.side };
  if (parsed.deckMaster !== undefined) deck.deckMaster = parsed.deckMaster;
  return deck;
}

function copyDeck(deck: DuelDeck): DuelDeck {
  const copy: DuelDeck = { main: [...deck.main], extra: [...deck.extra], side: [...deck.side] };
  if (deck.deckMaster !== undefined) copy.deckMaster = deck.deckMaster;
  return copy;
}

export function createTournamentDuelService(db: Database.Database): TournamentDuelService {
  const selectRules = db.prepare<[number], TournamentRulesRow>(`
    select t.best_of, t.duel_rules_json,
      (select d.id from drafts d where d.tournament_id = t.id order by d.id limit 1) as draft_id
    from tournaments t
    where t.id = ?
  `);
  const selectTournament = db.prepare<[number], TournamentRow>(
    "select id, guild_id, status, created_by_user_id from tournaments where id = ?",
  );
  const selectParticipant = db.prepare<[number, number], { user_id: number }>(`
    select p.user_id
    from tournament_participants tp
    inner join players p on p.id = tp.player_id
    where tp.tournament_id = ? and tp.player_id = ?
  `);
  const selectRegistration = db.prepare<[number, number], RegistrationRow>(`
    select saved_deck_id, deck_json, deck_registered_at, deck_locked_at
    from tournament_participants
    where tournament_id = ? and player_id = ?
  `);
  const selectRegistrations = db.prepare<
    [number],
    { player_id: number; deck_json: string | null; deck_locked_at: string | null }
  >(`
    select player_id, deck_json, deck_locked_at
    from tournament_participants
    where tournament_id = ?
    order by joined_at asc, rowid asc
  `);
  const selectSavedDeck = db.prepare<[number], { guild_id: string; owner_user_id: number; draft_id: number | null }>(
    "select guild_id, owner_user_id, draft_id from saved_decks where id = ?",
  );
  const selectGameStarted = db.prepare<[number, number], { started: number }>(`
    select (
      exists (
        select 1 from duel_series s
        inner join tournament_matches tm on tm.id = s.tournament_match_id
        where tm.tournament_id = ?
      )
      or exists (
        select 1 from tournament_participants
        where tournament_id = ? and deck_locked_at is not null
      )
    ) as started
  `);
  const selectMatch = db.prepare<
    [number],
    {
      id: number;
      tournament_id: number;
      match_id: number | null;
      player_one_id: number;
      player_two_id: number | null;
      status: string;
    }
  >("select id, tournament_id, match_id, player_one_id, player_two_id, status from tournament_matches where id = ?");
  const selectOpenSeries = db.prepare<[number], { id: number; guild_id: string }>(`
    select id, guild_id from duel_series
    where tournament_match_id = ? and status in ('active', 'between_games')
  `);
  const selectLatestGameSlug = db.prepare<[number], { slug: string | null }>(
    "select web_slug as slug from duels where kind = 'play' and series_id = ? order by game_number desc, id desc limit 1",
  );
  const selectPlayerByUser = db.prepare<[string, number], { id: number }>(
    "select id from players where guild_id = ? and user_id = ?",
  );
  const selectMatchStatus = db.prepare<[number], { status: string }>("select status from matches where id = ?");
  const denyPendingMatch = db.prepare<[number | null, number]>(`
    update matches
    set status = 'denied', approver_id = ?, resolved_at = current_timestamp
    where id = ? and status = 'pending'
  `);
  const reopenSlot = db.prepare<[number]>(
    "update tournament_matches set status = 'open', match_id = null where id = ?",
  );
  const updateBestOf = db.prepare<[number, number]>("update tournaments set best_of = ? where id = ?");
  const updateRulesJson = db.prepare<[string, number]>("update tournaments set duel_rules_json = ? where id = ?");
  const updateRegistration = db.prepare<[number | null, string, number, number]>(`
    update tournament_participants
    set saved_deck_id = ?, deck_json = ?, deck_registered_at = datetime('now')
    where tournament_id = ? and player_id = ?
  `);
  const lock = db.prepare<[number, number]>(`
    update tournament_participants
    set deck_locked_at = coalesce(deck_locked_at, datetime('now'))
    where tournament_id = ? and player_id = ?
  `);

  const loadTournament = (tournamentId: number): TournamentRow => {
    const row = selectTournament.get(tournamentId);
    if (!row) throw new TournamentDuelError("Tournament not found", 404);
    return row;
  };

  const rulesFor = (tournamentId: number): TournamentDuelRules => {
    const row = selectRules.get(tournamentId);
    if (!row) throw new TournamentDuelError("Tournament not found", 404);
    return resolveTournamentDuelRules(row);
  };

  const gameStarted = (tournamentId: number): boolean =>
    Boolean(selectGameStarted.get(tournamentId, tournamentId)?.started);

  const setRulesTx = db.transaction(
    (
      tournamentId: number,
      organizerUserId: number,
      input: { bestOf?: DuelBestOf; mode?: DuelMode; masterRule?: DuelMasterRule; settings?: unknown },
    ): TournamentDuelRules => {
      const tournament = loadTournament(tournamentId);
      if (tournament.created_by_user_id !== organizerUserId) {
        throw new TournamentDuelError("Only the organizer can change the duel rules", 403);
      }
      if (tournament.status !== "pending" && tournament.status !== "active") {
        throw new TournamentDuelError(`Cannot edit the rules of a ${tournament.status} tournament`, 409);
      }
      if (gameStarted(tournamentId)) {
        throw new TournamentDuelError("The rules cannot change after a tournament game has started", 409);
      }
      const current = rulesFor(tournamentId);
      const changesRules = input.mode !== undefined || input.masterRule !== undefined || input.settings !== undefined;
      if (current.draftId !== null && changesRules) {
        throw new TournamentDuelError("A draft tournament has fixed duel rules; only Best of can change", 400);
      }
      if (input.bestOf !== undefined) assertBestOf(input.bestOf);
      // Validate before any write so a bad rule changes nothing.
      const rulesJson = changesRules ? serializeTournamentDuelRules(input, current) : null;
      if (input.bestOf !== undefined) updateBestOf.run(input.bestOf, tournamentId);
      if (rulesJson !== null) updateRulesJson.run(rulesJson, tournamentId);
      return rulesFor(tournamentId);
    },
  );

  const registerDeckTx = db.transaction(
    (input: {
      tournamentId: number;
      playerId: number;
      savedDeckId: number | null;
      deck: DuelDeck;
    }): TournamentDeckRegistration => {
      const tournament = loadTournament(input.tournamentId);
      if (tournament.status !== "pending" && tournament.status !== "active") {
        throw new TournamentDuelError(`Decks cannot be registered for a ${tournament.status} tournament`, 409);
      }
      const participant = selectParticipant.get(input.tournamentId, input.playerId);
      if (!participant) throw new TournamentDuelError("You are not a participant in this tournament", 403);
      if (selectRegistration.get(input.tournamentId, input.playerId)?.deck_locked_at) {
        throw new TournamentDuelError("Your deck is locked because your first tournament game has started", 409);
      }
      const { draftId } = rulesFor(input.tournamentId);
      if (draftId !== null && input.savedDeckId === null) {
        throw new TournamentDuelError("A draft tournament needs your saved draft deck", 400);
      }
      if (input.savedDeckId !== null) {
        const saved = selectSavedDeck.get(input.savedDeckId);
        if (!saved || saved.guild_id !== tournament.guild_id) {
          throw new TournamentDuelError("Saved deck not found", 404);
        }
        if (saved.owner_user_id !== participant.user_id) {
          throw new TournamentDuelError("That saved deck belongs to another player", 403);
        }
        if (draftId !== null && saved.draft_id !== draftId) {
          throw new TournamentDuelError("A draft tournament accepts only your deck from that draft", 400);
        }
      }
      const deck = copyDeck(input.deck);
      updateRegistration.run(input.savedDeckId, JSON.stringify(deck), input.tournamentId, input.playerId);
      const registration = selectRegistration.get(input.tournamentId, input.playerId)!;
      return {
        tournamentId: input.tournamentId,
        playerId: input.playerId,
        savedDeckId: registration.saved_deck_id,
        deck,
        registeredAt: registration.deck_registered_at!,
        lockedAt: registration.deck_locked_at,
      };
    },
  );

  const setResultTx = db.transaction(
    (input: { tournamentMatchId: number; organizerUserId: number; winnerPlayerId: number }) => {
      const slot = selectMatch.get(input.tournamentMatchId);
      if (!slot) throw new TournamentDuelError("Tournament match not found", 404);
      const tournament = loadTournament(slot.tournament_id);
      if (tournament.created_by_user_id !== input.organizerUserId) {
        throw new TournamentDuelError("Only the organizer can set a result", 403);
      }
      if (tournament.status !== "active") {
        throw new TournamentDuelError("Tournament is not active", 409);
      }
      if (slot.player_two_id === null) {
        throw new TournamentDuelError("A BYE has no result to set", 409);
      }
      if (slot.status !== "open" && slot.status !== "pending_approval") {
        throw new TournamentDuelError("Tournament match is already completed", 409);
      }
      if (input.winnerPlayerId !== slot.player_one_id && input.winnerPlayerId !== slot.player_two_id) {
        throw new TournamentDuelError("Winner must be one of the match players", 400);
      }
      if (db.prepare(`select 1 from duels d join duel_series s on s.id = d.series_id
        where s.tournament_match_id = ? and d.kind != 'play' limit 1`).get(slot.id)) {
        throw new TournamentDuelError("Replay forks cannot be linked to a tournament result", 409);
      }
      const organizer = selectPlayerByUser.get(tournament.guild_id, input.organizerUserId);

      const changedDuelSlugs = new Set<string>();
      const series = createDuelSeriesService(db);
      for (const open of selectOpenSeries.all(slot.id)) {
        for (const slug of series.cancel(open.id, open.guild_id).changedSlugs) changedDuelSlugs.add(slug);
        const latest = selectLatestGameSlug.get(open.id)?.slug;
        if (latest) changedDuelSlugs.add(latest);
      }

      if (slot.status === "pending_approval" && slot.match_id !== null) {
        // Same effect as matches.deny: the organizer overrides the pending report.
        if (selectMatchStatus.get(slot.match_id)?.status === "pending") {
          denyPendingMatch.run(organizer?.id ?? null, slot.match_id);
        }
        reopenSlot.run(slot.id);
      }

      createMatchService(db).recordConfirmedResult({
        guildId: tournament.guild_id,
        playerOneId: slot.player_one_id,
        playerTwoId: slot.player_two_id,
        winnerId: input.winnerPlayerId,
        source: "tournament",
        tournamentMatchId: slot.id,
        recordedById: organizer?.id ?? null,
      });

      return {
        tournamentId: tournament.id,
        changedDuelSlugs: [...changedDuelSlugs],
        tournamentCompleted: loadTournament(tournament.id).status === "completed",
      };
    },
  );

  return {
    rules: rulesFor,

    rulesLocked(tournamentId) {
      const tournament = loadTournament(tournamentId);
      if (tournament.status !== "pending" && tournament.status !== "active") return true;
      return gameStarted(tournamentId);
    },

    setRules(tournamentId, organizerUserId, input) {
      return setRulesTx(tournamentId, organizerUserId, input);
    },

    registration(tournamentId, playerId) {
      const row = selectRegistration.get(tournamentId, playerId);
      if (!row || row.deck_json === null || row.deck_registered_at === null) return null;
      return {
        tournamentId,
        playerId,
        savedDeckId: row.saved_deck_id,
        deck: parseDeck(row.deck_json),
        registeredAt: row.deck_registered_at,
        lockedAt: row.deck_locked_at,
      };
    },

    registrations(tournamentId) {
      return selectRegistrations.all(tournamentId).map((row) => ({
        playerId: row.player_id,
        registered: row.deck_json !== null,
        lockedAt: row.deck_locked_at,
      }));
    },

    registerDeck(input) {
      return registerDeckTx(input);
    },

    lockDeck(tournamentId, playerId) {
      lock.run(tournamentId, playerId);
    },

    setResultByOrganizer(input) {
      return setResultTx(input);
    },
  };
}
