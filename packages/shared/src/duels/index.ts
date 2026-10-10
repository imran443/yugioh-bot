import type { DuelClock, DuelFormat, DuelSettings } from "./settings.js";
import type { DuelFirstChoice, DuelOpeningView } from "./opening.js";

export type DuelMode = "normal" | "domain";
export type DuelStatus = "lobby" | "active" | "completed" | "interrupted" | "cancelled";
export type DuelActorRole = "player" | "spectator";
export type DuelMasterRule = 1 | 2 | 3 | 4 | 5;

/** An opponent pick named a seat that is eliminated or leaving the duel. */
export const DUEL_SEAT_LEFT_ERROR_CODE = "seat_left" as const;
export type DuelErrorCode = typeof DUEL_SEAT_LEFT_ERROR_CODE;

export type {
  DuelCardPool,
  DuelClock,
  DuelClockState,
  DuelFormat,
  DuelSettings,
  DuelTimeout,
  DuelVisibility,
} from "./settings.js";
export {
  DEFAULT_DUEL_FORMAT,
  DUEL_FORMATS,
  MAX_DUEL_SEATS,
  isDuelFormat,
  opponentSeatsOf,
  partnerSeatOf,
  seatCountFor,
  seatsOfTeam,
  sharedExtraSeatOf,
  startingLpFor,
  teamCountFor,
  teamOfSeat,
  DUEL_CLOCK_INCREMENT_MS,
  DUEL_CLOCK_REGAIN_FRACTION,
  DUEL_CLOCK_REGAIN_MIN_MS,
  DUEL_OPENING_GRACE_MS,
  defaultDuelSettings,
  duelClockBankMs,
  duelClockRegainMs,
  duelClockRulesText,
  isCustomDomain,
  legacyDuelSettings,
  normalizeDuelSettings,
  NO_BANLIST_ID,
  PINNED_TCG_BANLIST_ID,
} from "./settings.js";
export { DEFAULT_DUEL_1V1_ENGINE, DUEL_1V1_ENGINE_ENV, duel1v1Engine, isDuelEngineChoice } from "./engine-switch.js";
export type { DuelEngineChoice } from "./engine-switch.js";
export { COIN_TIMING, COIN_TOSS_MS, COIN_SUMMARY_MS, COIN_CHAIN_BEAT_MAX_MS, MIN_DUEL_FX_SPEED, coinTossDurationMs } from "./coin-timing.js";
export {
  MULTIPLAYER_TABLES_ENV,
  MULTIPLAYER_TABLES_OFF_MESSAGE,
  enabledDuelFormats,
  multiplayerSeatsBlockReason,
  multiplayerTablesBlockReason,
  multiplayerTablesEnabled,
} from "./multiplayer-tables.js";
export { MULTI_CORE_UNAVAILABLE_MESSAGE, MULTI_DOMAIN_CORE_READY, MULTI_DOMAIN_UNAVAILABLE_MESSAGE, multiDomainBlockReason } from "./multi-domain.js";
export type { DuelTableCapabilities } from "./multi-domain.js";
export type { DuelBanlistOption } from "./banlist-options.js";
export type {
  DuelFirstChoice,
  DuelOpeningReveal,
  DuelOpeningState,
  DuelOpeningView,
  DuelRpsOpeningState,
  DuelRpsOpeningView,
  DuelRpsMove,
} from "./opening.js";
export {
  DUEL_OPENING_PICK_MS,
  DUEL_OPENING_REVEAL_MS,
  DUEL_OPENING_TIE_REVEAL_MS,
  DUEL_RPS_MOVES,
  isDiceOpening,
  isFirstChoice,
  isRpsMove,
  rpsWinner,
} from "./opening.js";
export type { CardIdentityCatalog, DeckPoolIssue } from "./pool.js";
export { canonicalCardCode, checkDeckAgainstPool, deckCardCounts, mapDeckCodes } from "./pool.js";
export { DUEL_BANLIST_OPTIONS } from "./banlist-options.js";

export interface DuelDeck {
  main: number[];
  extra: number[];
  side: number[];
  deckMaster?: number;
}

export interface SavedDeck {
  id: number;
  name: string;
  mode: DuelMode;
  deck: DuelDeck;
  createdAt: string;
  updatedAt: string;
  /** Set when the deck was built from the owner's pool in this draft. */
  draftId?: number | null;
}

export type DuelBestOf = 1 | 3;

/**
 * `active`: a game is in lobby or in progress. `between_games`: the side-deck
 * window before the next game. `completed`: a player won the series.
 * `cancelled`: stopped before a winner (lobby cancel or organizer result).
 */
export type DuelSeriesStatus = "active" | "between_games" | "completed" | "cancelled";

/**
 * Public state of a match of 1 or 3 games between two players. `playerIds`
 * order is fixed when the series is made; it is not the seat order of a game
 * (the loser of the last game takes seat 0 in the next one).
 */
export interface DuelSeriesSummary {
  id: number;
  bestOf: DuelBestOf;
  ranked: boolean;
  status: DuelSeriesStatus;
  playerIds: [number, number];
  displayNames: [string, string];
  wins: [number, number];
  /** Number of the latest game (1-based). */
  gameNumber: number;
  /** Slug of the latest game's duel; clients follow it to the next game. */
  currentDuelSlug: string | null;
  winnerPlayerId: number | null;
  tournamentId: number | null;
  tournamentSlug: string | null;
  tournamentMatchId: number | null;
  /** ISO time when the side-deck window ends; null when there is no deadline. */
  nextGameAt: string | null;
  /** Per playerIds index: the player clicked Ready (or has no side deck). */
  sideReady: [boolean, boolean];
  /** Per playerIds index: the player's deck has side deck cards. */
  hasSide: [boolean, boolean];
  /**
   * Between games after a decided game: the playerIds index of the loser, who chooses to go first or
   * second. Null before game 1, after a draw or an interrupt (the seats swap then), and while a game runs.
   */
  firstChooser: 0 | 1 | null;
  /** What the chooser picked for the next game; null until they choose (the default is first). */
  firstChoice: DuelFirstChoice | null;
  /** One player plays the practice bot: `playerIds[1]` is 0 and the bot's name stands in `displayNames[1]`. */
  vsBot: boolean;
}

/** The viewer's own decks in a series; only sent to that player. */
export interface DuelSeriesSideState {
  /** The registered deck (tournament) or the game 1 deck (casual). */
  baseDeck: DuelDeck;
  /** The deck for the next game, after side deck swaps. */
  currentDeck: DuelDeck;
}

export interface DuelDeckCardRef {
  section: "main" | "extra" | "side" | "deckMaster";
  index: number;
  code: number;
  name?: string;
}

export interface DuelDeckIssue {
  message: string;
  cards: DuelDeckCardRef[];
}

export interface DuelDeckValidation {
  issues: DuelDeckIssue[];
}

export interface DuelCardInfo {
  /** Preview data from BabelCDB; available to search and card-info consumers. */
  prerelease?: boolean;
  code: number;
  /** Engine artwork-family main; equals code for cards without an artwork alias. */
  canonicalPasscode?: number;
  name: string;
  description: string;
  type: number;
  attack: number;
  defense: number;
  level: number;
  attribute: number;
  race: string;
}

/** Hidden cards omit identity and stats; never serialize raw core queries. */
export interface DuelCard {
  controller: number;
  location: number;
  sequence: number;
  position: number;
  /** Opaque animation identity; hand order and sequence always come from the engine query. */
  handId?: string;
  code?: number;
  /** Engine artwork-family main, omitted with the rest of a hidden card's identity. */
  canonicalPasscode?: number;
  name?: string;
  description?: string;
  attack?: number;
  defense?: number;
  level?: number;
  type?: number;
  attribute?: number;
  race?: string;
  rank?: number;
  linkRating?: number;
  linkMarker?: number;
  counters?: Array<{ type: number; count: number }>;
  /**
   * True on a face-up monster or Spell/Trap on the field whose effects are negated (the core's STATUS_DISABLED:
   * a negating effect or a continuous one such as Skill Drain). Absent otherwise. A face-down card never carries it.
   */
  negated?: boolean;
  materials?: DuelCard[];
  /**
   * Set on a card that is equipped to a monster (an Equip Spell, a Union monster, or any card the
   * engine attaches with an effect): the monster's zone. Read live from the core, so it follows the
   * monster when it moves or changes control and is gone when either card leaves the field. A hidden
   * card carries nothing, so a face-down card never shows what it is attached to.
   */
  equippedTo?: DuelZoneRef;
}

export interface DuelPromptOption {
  id: string;
  label: string;
  card?: DuelCardInfo;
  controller?: number;
  location?: number;
  sequence?: number;
  /** Core-query result for an attack command; null when no query result is available. Direct targets are real seats. */
  attackTargets?: { monsters: Array<{ controller: number; location: number; sequence: number }>; direct: number[] } | null;
  /** False when an opponent effect (such as Patrician of Darkness) chooses the attack target. */
  attackerChoosesTarget?: boolean;
  /**
   * An Xyz material (location LOCATION_OVERLAY, sequence = its place under the monster) names the Xyz monster
   * it is attached to. It cannot be clicked on the board, so the prompt lists it as a card tile.
   * `name` is filled for a viewer who sees that monster.
   */
  host?: DuelZoneRef & { code?: number; name?: string };
  values?: number[];
  /** Current Level from this viewer's card projection; takes precedence over the printed Level. */
  currentLevel?: number;
  /** The card counts as another Level for a Synchro Summon (EFFECT_SYNCHRO_LEVEL), so its Level is not its contribution. */
  synchroLevelVaries?: boolean;
  max?: number;
  selected?: boolean;
  /** Full printed text of the card this option is bound to (absent when the card is hidden from the viewer). */
  cardText?: string;
  /**
   * The specific effect this option activates or applies, resolved from the card's strings
   * (no printf placeholders). Often a short label such as "Take control"; show `cardText` for the
   * accurate wording, including costs.
   */
  effectText?: string;
}

/** The card whose effect a prompt is about. `text` is its full printed text. */
export interface DuelPromptSource {
  code: number;
  name: string;
  /**
   * Seat that controls the card. When the engine gave no location (a card hint before a yes/no or
   * option prompt) this is the answering seat, which is the effect's controller in practice.
   */
  seat: number;
  /** Where the card is; absent when the engine only hinted the card code. */
  zone?: DuelZoneRef;
  text: string;
}

export type DuelPromptContext =
  | { type: "action"; phase: "main" | "battle" }
  | { type: "chain"; forced: boolean }
  | { type: "position" }
  /** The activating duelist picks the one opponent that a hand, Deck, draw or LP effect binds. Options carry `controller: seat`. */
  | { type: "opponent" }
  | { type: "deck-master-recall"; card: DuelCardInfo; returns: number; nextCost: number };

export interface DuelPrompt {
  id: string;
  seat: number;
  kind: "choice" | "cards" | "tribute" | "places" | "order" | "counters" | "number" | "announce-card" | "sum" | "toggle";
  title: string;
  description?: string;
  options: DuelPromptOption[];
  min?: number;
  max?: number;
  target?: number;
  /** Sum requirement (also used for a Synchro toggle's Level target), independent of card-count bounds. */
  sumMode?: "exact" | "at-least";
  mandatory?: string[];
  cancelable?: boolean;
  finishable?: boolean;
  context?: DuelPromptContext;
  /**
   * Present for prompts tied to one card: yes/no effect prompts, trigger prompts, option prompts
   * from an effect, and selections made while that card's effect resolves. Never names a card
   * the answering seat cannot see.
   */
  source?: DuelPromptSource;
}

export interface DuelAnswer {
  choice?: string;
  selected?: string[];
  counts?: Record<string, number>;
  value?: number;
  cardCode?: number;
  cancel?: boolean;
  finish?: boolean;
}

export interface DuelSeatView {
  seat: number;
  lp: number;
  hand: DuelCard[];
  deckCount: number;
  extraCount: number;
  extra: DuelCard[];
  monsters: Array<DuelCard | null>;
  spells: Array<DuelCard | null>;
  graveyard: DuelCard[];
  banished: DuelCard[];
  deckMaster?: { card: DuelCardInfo; inZone: boolean; returns: number; nextCost: number };
  /** Team of this seat (`teamOfSeat(format, seat)`). Absent in 1v1 views made before multi-player formats. */
  team?: number;
  /**
   * Living facing seat sharing these Extra Monster Zones in FFA4 and Tag (0/1, 2/3). Null in other formats or
   * when either seat is eliminated. Sequences 5/6 mirror to 6/5. Absent in older views.
   */
  sharedExtraWith?: number | null;
  /** True after this seat (FFA) or its team (Tag) lost while the duel goes on. Its fields are empty. */
  eliminated?: boolean;
  /**
   * True during the short FFA surrender window while the current chain finishes. It clears when the loss
   * lands or the duel ends. Time-limit losses can also set it until the next safe Adjust. Absent otherwise.
   */
  pendingElimination?: boolean;
  /**
   * Zones of this seat that an effect disabled (for example Field Disable effects), as a bit mask in the
   * layout of the low half of MSG_FIELD_DISABLED (Monster Zones from bit 0, Spell and Trap Zones from bit 8).
   * Absent when no zone is disabled.
   */
  disabledZones?: number;
}

/** A board position, in the same terms as DuelCard (controller, location bitmask, sequence). */
export interface DuelZoneRef {
  controller: number;
  location: number;
  sequence: number;
}

export type DuelMoveReason =
  | "summon" | "set" | "activate" | "destroy" | "send" | "return" | "banish" | "draw" | "add" | "discard" | "other";

/**
 * How a monster arrived on the field. "tribute" is a Normal Summon that used Tributes. The Extra
 * Deck kinds ("fusion", "synchro", "xyz", "link") are Special Summons of a monster of that type
 * from the Extra Deck (or the Domain Deck Master Zone); "ritual" is a Ritual Monster Special
 * Summoned from the hand; "pendulum" is a Pendulum Summon started from a Pendulum Zone card.
 * Everything else is "special".
 */
export type DuelSummonKind =
  | "normal" | "tribute" | "special" | "flip"
  | "fusion" | "synchro" | "xyz" | "link" | "ritual" | "pendulum";

/**
 * Where the Battle Phase is. "start" = Start Step, "battle" = Battle Step (attacks are declared
 * here), "damage" = Damage Step (before or after damage calculation), "damage-calculation" =
 * damage calculation inside the Damage Step, "end" = End Step. null outside the Battle Phase.
 */
export type DuelBattleStep = "start" | "battle" | "damage" | "damage-calculation" | "end";

/** The core's actual stats at damage calculation, before temporary effects expire. */
export interface DuelBattleStats {
  attack: number;
  defense: number;
  position: number;
}

/** One engine toss message, with all results in order. Dice are reserved for a future event producer. */
export type DuelToss =
  | { type: "coin"; results: Array<"heads" | "tails"> }
  | { type: "dice"; results: number[] };

/** Saved with a duel so recovery is independent of server environment changes. */
export type DuelScriptErrorMode = "tolerant" | "strict";

export interface DuelEvent {
  id: number;
  kind:
    | "script-error" | "summon" | "set" | "activate" | "target" | "chain-resolving" | "chain-resolved" | "chain-negated" | "chain-end"
    | "attack" | "attack-negated" | "battle" | "battle-end" | "phase" | "damage" | "recover" | "destroy" | "move" | "position" | "equip" | "confirm" | "toss";
  seat?: number;
  card?: DuelCardInfo;
  chainIndex?: number;
  /** Public choices known at this chain event. Retained for playback when the chain finishes in one batch. */
  chosenOptions?: DuelChainLink["chosenOptions"];
  /** target: the link's complete current target list (including [] when cleared). Coordinates only;
   * identities must come from the viewer's redacted board. Also accepted on activation events. */
  targets?: DuelZoneRef[];
  text: string;
  description?: string;
  /** toss: public outcomes; `card` names the resolving source when known. */
  toss?: DuelToss;
  /** confirm: the preceding move of this card, when known. Identity belongs to this confirmation only. */
  moveId?: number;
  /**
   * summon / set / activate: the zone the card is in.
   * attack: the attacking monster's zone.
   * destroy: the zone the card left.
   * move: the destination zone (the card's controller after the move is `seat`).
   * equip: the zone of the card that was equipped (it has no `card`; read it from the board).
   * confirm: where the confirmed card was at confirmation time. Does not expose its live slot.
   */
  zone?: DuelZoneRef;
  /** move: the zone the card left. Board positions are public even when the card is hidden. */
  from?: DuelZoneRef;
  /**
   * move: best-effort cause of the move, derived from the engine messages around it.
   * `card` on a move event is present only when the card is public at the source or destination
   * for the viewer, or the viewer controls the hand/deck it moved from or to.
   */
  reason?: DuelMoveReason;
  /** move: the card arrived face-down (Set, or banished/returned face-down). */
  faceDown?: boolean;
  /**
   * move: a card effect added the card to a hand (a search from the Deck, a salvage, a bounce); it was not
   * drawn. Set on moves to a hand that did not come from a draw. Absent on older events (a search from the
   * Deck then reads like a draw).
   */
  addedToHand?: true;
  /** move into hand: animation destination in the current engine view. Hidden shuffles stay anonymous. */
  handId?: string;
  /** move into hand: a public shuffle occurred since this arrival; unknown departures cannot identify it. */
  handShuffled?: true;
  /** attack: the attacked monster's zone; absent for a direct attack. equip: the monster it was equipped to. */
  target?: DuelZoneRef;
  /** attack: the defending seat of a direct attack. Absent in 1v1 and older events. */
  targetSeat?: number;
  /** battle: public MSG_BATTLE values; a direct attack has no target. These never replace live board stats. */
  battle?: { attacker: DuelBattleStats; target?: DuelBattleStats };
  /** damage: LP lost by `seat` (positive number). */
  amount?: number;
  /**
   * damage: "battle" for battle damage, "effect" for effect damage, "cost" for paid LP.
   * destroy / move (reason "destroy"): why the card was destroyed. "battle" = lost a battle,
   * "effect" = a card effect (see sourceCode), "rule" = a game rule, "cost" = paid as a cost,
   * "other" = anything else. Absent on events recorded before this field existed.
   */
  cause?: "battle" | "effect" | "cost" | "rule" | "other";
  /** destroy / move / toss: passcode of the source (the effect's card, or the opposing battler). */
  sourceCode?: number;
  /** destroy / move: engine artwork-family main of sourceCode; selected artwork stays in sourceCode. */
  sourceCanonicalCode?: number;
  /** destroy / move: card type of the source when it activated (monster, spell or trap). */
  sourceKind?: "monster" | "spell" | "trap";
  /** destroy / move: seat that controlled the reason (the player the destruction is attributed to). */
  sourceSeat?: number;
  /** summon: how the monster arrived. */
  summonKind?: DuelSummonKind;
  /**
   * position: the battle position the card left and the one it is in now (POS_* bitmasks:
   * 0x1 face-up Attack, 0x2 face-down Attack, 0x4 face-up Defense, 0x8 face-down Defense).
   * `zone` is the card's zone; `card` follows the move-event rule (present when the card is
   * face-up before or after the change, or the viewer controls it).
   * move / destroy: `fromPosition` is the Monster Zone position before departure, even when the
   * destination snapshot already removed the card. A Graveyard position is not its battle pose.
   */
  fromPosition?: number;
  toPosition?: number;
  /** position: the card turned face-up (a flip reveal). */
  flip?: true;
}

export interface DuelChainLink {
  index: number;
  seat: number;
  code?: number;
  name?: string;
  description?: string;
  /** Printed card text of the source, public like the name. Lets a reload mid-chain keep the effect text. */
  text?: string;
  /** Card type bits of the source (Spell/Trap/monster), so the client can pick the right part of the printed text. */
  cardType?: number;
  /** Where the source activated; retained when its activation leaves the event window. */
  zone?: DuelZoneRef;
  /** Current target coordinates, public to every viewer. No target names or passcodes. */
  targets?: DuelZoneRef[];
  /**
   * Public effect choices, added only after selection. Missing on older snapshots/replays.
   * `index` is the zero-based SELECT_OPTION prompt index, not a printed-text bullet or card-string index.
   * A script can announce an operation without a prompt; in that case only `text` is known.
   */
  chosenOptions?: { index?: number; text: string }[];
}

export interface DuelEngineView {
  revision: number;
  /** Seat and team layout. Absent means `1v1`. In Tag both partners' `lp` is the shared team LP. */
  format?: DuelFormat;
  turn: number;
  turnSeat: number;
  phase: string;
  /** The current Battle Phase step; null outside the Battle Phase. Best effort from core messages. */
  battleStep?: DuelBattleStep | null;
  seats: DuelSeatView[];
  /** Earliest losses first. Seats reported together share a place. Absent on older views and 1v1. */
  eliminationOrder?: number[][];
  prompt: DuelPrompt | null;
  /**
   * Public seat the engine is waiting on, including when that viewer cannot see the prompt.
   * null while processing or after the duel; absent in older clients' saved views/replays.
   * This reveals ownership only, never the answering player's prompt or options.
   */
  prioritySeat?: number | null;
  chain: DuelChainLink[];
  events: DuelEvent[];
  /** `eventId` links a toss result line to its FX event, so the client can wait until it lands. */
  log: Array<{ id: number; text: string; eventId?: number }>;
  /**
   * The viewing seat's own chain response mode. Present only in the view built for a seated player; never in an
   * opponent's, a teammate's or a spectator's view, and not at all where the host does not allow the switch.
   */
  chainMode?: DuelChainMode;
  /**
   * `winnerSeat` is the winning seat in 1v1 and FFA. In Tag it is the lowest seat of the winning team, and
   * `winnerTeam` names the team. Null means a draw.
   */
  result: { winnerSeat: number | null; winnerTeam?: number | null; reason: string } | null;
}

export interface DuelSeat {
  seat: number;
  playerId: number | null;
  displayName: string;
  ready: boolean;
  isBot: boolean;
  deckMaster?: number;
}

export interface DuelSession {
  id: number;
  slug: string;
  name: string;
  guildId: string;
  organizerPlayerId: number;
  mode: DuelMode;
  /** Seat and team layout. `1v1` for every duel made before multi-player formats. */
  format: DuelFormat;
  masterRule: DuelMasterRule;
  status: DuelStatus;
  settings: DuelSettings;
  seats: DuelSeat[];
  createdAt: string;
  endedAt: string | null;
  archivedAt: string | null;
  winnerPlayerId: number | null;
  winnerSeat: number | null;
  resultReason: string | null;
  /** Match length chosen at create time (a series game copies its series). */
  bestOf?: DuelBestOf;
  /** Ranked: a finished series writes a match record (Elo). */
  ranked?: boolean;
  /** Series this game belongs to; null for a duel with no series (practice bot, or not started). */
  seriesId?: number | null;
  /** 1-based game number inside the series. */
  gameNumber?: number | null;
}

export interface DuelRoom {
  session: DuelSession;
  role: DuelActorRole;
  mySeat: number | null;
  myDeck: DuelDeck | null;
  engine: DuelEngineView | null;
  clock: DuelClock | null;
  metadataOnly: boolean;
  error?: string;
  inviteCode?: string;
  /** The series of this game, or null. */
  series?: DuelSeriesSummary | null;
  /** The viewer's series decks when the viewer is a series player; otherwise null. */
  mySide?: DuelSeriesSideState | null;
  /** True when the duel host was busy and answered with the last view it built for this seat. The client asks again soon. */
  stale?: boolean;
  /** Rock-paper-scissors or FFA dice rolls before the game starts; null when there is none. */
  opening?: DuelOpeningView | null;
}

/** A table row in the lobby list or match history, as seen by one viewer. */
export interface DuelListItem extends DuelSession {
  /** The viewer's seat, or null when the viewer is not seated. */
  mySeat: number | null;
  /** Last start or accepted input; falls back to creation time. */
  lastActivityAt: string;
  /** The series of this game, or null. */
  series?: DuelSeriesSummary | null;
}

/** `mine` lists only duels the viewer played; `all` lists every duel the viewer may open. */
export type DuelHistoryScope = "mine" | "all";

export interface DuelReplayFrame {
  /** 0 is the opening board; n is the board after the nth accepted input. */
  step: number;
  /** Seat whose accepted input produced this frame; null for the opening and saved final frames. */
  actorSeat: number | null;
  /**
   * Board for the viewer's role, with `prompt` always null. `log` and `events`
   * hold only entries new since the previous frame; clients concatenate them.
   */
  view: DuelEngineView;
}

export interface DuelReplay {
  session: DuelSession;
  role: DuelActorRole;
  mySeat: number | null;
  frames: DuelReplayFrame[];
}

export interface DuelCommand {
  promptId: string;
  revision: number;
  answer: DuelAnswer;
}

/**
 * How a seat wants to be asked at response windows (chain links), changeable at any time during the duel.
 * - `auto`: ask only when a listed card fits the window (today's behaviour at a 1v1 table).
 * - `always`: ask at every window that lists a card, even when none fits (a bluff; the default at a table of three or four).
 * - `off`: pass every optional response window at once. Forced prompts and mandatory effects still ask.
 * The mode is private to its seat and is applied by the duel host, never by a client.
 */
export type DuelChainMode = "auto" | "always" | "off";
export const DUEL_CHAIN_MODES: readonly DuelChainMode[] = ["auto", "always", "off"];

export function isDuelChainMode(value: unknown): value is DuelChainMode {
  return value === "auto" || value === "always" || value === "off";
}

/** The mode every seat starts a duel in: the duel setting `stopAtEveryWindow` (undefined counts as on, like saved duels). */
export function defaultChainMode(settings?: { stopAtEveryWindow?: boolean }): DuelChainMode {
  return settings?.stopAtEveryWindow === false ? "auto" : "always";
}

/**
 * A mode change is journaled like an answer with `promptId` `chain-mode:<mode>` (and an empty answer), so that a
 * journal replay applies it at the same point and the automatic passes after it come out the same. Returns the mode,
 * or null for any other command. Every journal replayer uses this.
 */
export const CHAIN_MODE_PROMPT_PREFIX = "chain-mode:";
export function chainModeOf(promptId: string): DuelChainMode | null {
  if (!promptId.startsWith(CHAIN_MODE_PROMPT_PREFIX)) return null;
  const mode = promptId.slice(CHAIN_MODE_PROMPT_PREFIX.length);
  return isDuelChainMode(mode) ? mode : null;
}

/** Journal entries for mode changes one duel may hold. Past it a change is refused: an unjournaled change could not be replayed. */
export const CHAIN_MODE_JOURNAL_LIMIT = 400;

export type {
  CardArchetype,
  CardFacets,
  CardKindFilter,
  CardLimitStatus,
  CardMatch,
  CardPoolFilter,
  CardQuery,
  CardQueryResult,
  CardRange,
  CardSearchScope,
  CardSearchTerm,
  CardSort,
  DeckCardInfo,
  MonsterTypeKey,
  SortOrder,
  SpellTypeKey,
  TrapTypeKey,
} from "./card-query.js";
export {
  CARD_ATTRIBUTES,
  CARD_LIMIT_KEYS,
  CARD_POOL_OCG,
  CARD_POOL_TCG,
  CARD_QUERY_PAGE_MAX,
  CARD_QUERY_TEXT_MAX,
  CARD_RACES,
  CARD_TYPE_BITS,
  CardQueryError,
  LINK_ARROW_MASK,
  LINK_ARROWS,
  MONSTER_TYPE_BITS,
  MONSTER_TYPE_KEYS,
  SPELL_TYPE_KEYS,
  TRAP_TYPE_KEYS,
  cardLimit,
  cardTypeRank,
  emptyCardQuery,
  foldCardText,
  inArchetype,
  parseCardQuery,
  parseCardSearchTerms,
} from "./card-query.js";

export type { CardArtworkFamily, SelectableCardArtwork, CardArtworksResponse, DeckArtworkSwapRequest } from "./artworks.js";

export type { DuelDiceRound, DuelDiceOpeningState, DuelDiceOpeningView } from "./dice-opening.js";
export { DUEL_DICE_REVEAL_MS, MAX_DICE_ROUNDS as DUEL_DICE_MAX_ROUNDS } from "./dice-opening.js";
