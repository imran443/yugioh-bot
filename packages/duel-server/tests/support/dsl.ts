import type { DuelAnswer, DuelErrorCode, DuelEvent } from "@yugidraft/shared/duels";
import type { BoardSpec, DuelistId, Stance } from "./board.js";
import type { CardRef } from "./card-catalog.js";

export type { CardRef } from "./card-catalog.js";
export type { BoardSpec, DuelistId, DuelistSetup, CardSpec, CardEntry, Stance } from "./board.js";
export { set as faceDown, def as defense, xyz } from "./board.js";

export type Where = "hand" | "mzone" | "szone" | "grave" | "banished" | "deck" | "extra" | "dmz";

/** Picks one card among the options of the current prompt. */
export type CardSel =
  | CardRef
  | {
      card: CardRef;
      /** Whose card. Default: any. */
      owner?: DuelistId;
      from?: Where;
      /** Sequence (zone index) of the card. */
      seq?: number;
      /** Pick the nth match (0-based) when several options match. */
      nth?: number;
      /** Substring of the option text, to choose between effects of one card. */
      effect?: string;
    };

/** A zone on the field. m0-m4 Main Monster Zones, emz0/emz1 Extra Monster Zones, s0-s4 Spell/Trap, f Field, pz0/pz1 Pendulum
 * (Master Rule 5: pz0 is the same zone as s0 and pz1 the same as s4). */
export type Zone =
  | "m0" | "m1" | "m2" | "m3" | "m4" | "emz0" | "emz1"
  | "s0" | "s1" | "s2" | "s3" | "s4" | "f" | "pz0" | "pz1";

export type ActionKind =
  | "activate" | "normalSummon" | "set" | "specialSummon" | "changePosition" | "attack" | "tributeSummon";

export interface EventMatch {
  kind: DuelEvent["kind"];
  card?: CardRef;
  by?: DuelistId;
  summonKind?: string;
  cause?: string;
  amount?: number;
  /** Substring of the event text. */
  text?: string;
}

/**
 * One option of the open prompt, by what a player sees. Every field given must match: `seat` the controller of the option (the
 * seat of an opponent pick, the owner of a card or zone), `card` the card of the option, `label` a substring of the option
 * label (ignores case), `id` the exact option id.
 */
export interface OptionRef {
  seat?: DuelistId;
  card?: CardRef;
  label?: string;
  id?: string;
}

/** The options of the open prompt: an array means exactly these options (each used once, any order). */
export type OptionsExpect = OptionRef[] | { include?: OptionRef[]; exclude?: OptionRef[]; count?: number };

export type ListExpect = CardRef[] | { include?: CardRef[]; exclude?: CardRef[]; count?: number };

export type ZoneExpect =
  | CardRef
  | null
  | {
      card: CardRef;
      pos?: Stance | "faceup" | "facedown";
      materials?: number;
      /** Current ATK, including continuous effects and negation. */
      attack?: number;
      defense?: number;
      /** The negated mark of the view: true = effects negated, false = not (the field is absent when false). */
      negated?: boolean;
      /** Exact counters on the card: counter type to count. {} means no counters. */
      counters?: Record<number, number>;
    };

export interface DuelistExpect {
  lp?: number;
  hand?: ListExpect;
  grave?: ListExpect;
  banished?: ListExpect;
  extra?: ListExpect;
  deckCount?: number;
  /** Exact zones. null means empty. Zones not listed are not checked. */
  zones?: Partial<Record<Zone, ZoneExpect>>;
  /** Cards on the monster zones, any position. */
  monsters?: ListExpect;
  /** Cards on the Spell/Trap, Field and Pendulum zones. */
  spells?: ListExpect;
  deckMaster?: { inZone?: boolean; returns?: number; nextCost?: number };
}

export type BoardExpect = Partial<Record<DuelistId, DuelistExpect>>;

export interface PromptExpect {
  by?: DuelistId;
  kind?: string;
  /** Substring of the prompt title. */
  title?: string;
  /** "action" | "chain" | "position" | "deck-master-recall" */
  context?: string;
  /** Option ids that must be offered, for example "to_bp", "to_ep", "shuffle". */
  offers?: string[];
  /** Option ids that must not be offered. */
  notOffers?: string[];
}

export type Step =
  | { op: "expectPrivateCards"; cards: Array<{ owner: DuelistId; from: "hand" | "mzone" | "szone"; seq: number; card: CardRef; visibleTo: DuelistId[] }> }
  | { op: "activate"; sel: CardSel; by?: DuelistId }
  | { op: "normalSummon"; sel: CardSel; by?: DuelistId }
  | { op: "set"; sel: CardSel; by?: DuelistId }
  | { op: "specialSummon"; sel: CardSel; by?: DuelistId }
  | { op: "changePosition"; sel: CardSel; by?: DuelistId }
  | { op: "attack"; attacker: CardSel; target: CardSel | "direct"; by?: DuelistId }
  | { op: "phase"; to: "battle" | "main2" | "end"; by?: DuelistId }
  | { op: "pass"; by?: DuelistId }
  | { op: "surrender"; seat: DuelistId; reason?: number }
  | { op: "choose"; match: string; by?: DuelistId }
  | { op: "select"; sels: CardSel[]; by?: DuelistId }
  | { op: "selectCardAt"; owner: DuelistId; zone: Zone; by?: DuelistId }
  | { op: "auto"; by?: DuelistId }
  | { op: "zone"; owner: DuelistId; zone: Zone; by?: DuelistId }
  | { op: "position"; pos: "atk" | "def" | "set"; by?: DuelistId }
  | { op: "yes"; by?: DuelistId }
  | { op: "no"; by?: DuelistId }
  | { op: "finish"; by?: DuelistId }
  | { op: "number"; value: number; by?: DuelistId }
  | { op: "announce"; card: CardRef; by?: DuelistId }
  | { op: "raw"; answer: DuelAnswer; by?: DuelistId }
  | { op: "expectBoard"; board: BoardExpect }
  | { op: "expectEvents"; events: EventMatch[] }
  | { op: "expectNoEvent"; event: EventMatch }
  | { op: "expectLog"; lines: string[] }
  | { op: "expectNoLog"; text: string }
  | { op: "expectLogSeen"; viewer: DuelistId | "spectator"; has?: string[]; lacks?: string[] }
  | { op: "expectResolved"; order: CardRef[] }
  | { op: "expectChain"; links: CardRef[] }
  | { op: "expectPrompt"; prompt: PromptExpect }
  | { op: "expectNoPrompt" }
  | { op: "expectOffered"; action: ActionKind | "choice"; sel: CardSel; by?: DuelistId }
  | { op: "expectNotOffered"; action: ActionKind | "choice"; sel: CardSel; by?: DuelistId }
  | { op: "expectSeatNotOffered"; action: ActionKind | "choice"; sel: CardSel; by: DuelistId }
  | { op: "expectResult"; winner?: DuelistId | null; team?: number | null; reason?: string }
  | { op: "expectEliminated"; seats: DuelistId[] }
  | { op: "expectLp"; who: { seat: DuelistId } | { team: number }; value: number }
  | { op: "expectResponseOrder"; seats: DuelistId[] }
  | { op: "expectTurn"; seat: DuelistId; turn?: number }
  | { op: "expectPickSeats"; seats: DuelistId[]; by?: DuelistId }
  | { op: "pickOpponent"; seat: DuelistId; by?: DuelistId }
  | { op: "expectPickOptions"; options: OptionsExpect; by?: DuelistId }
  | { op: "expectLabel"; option: OptionRef; text: string; by?: DuelistId }
  | { op: "expectRetry"; answer: DuelAnswer; as?: DuelistId; error?: string; code?: DuelErrorCode; by?: DuelistId };

// Actions -------------------------------------------------------------------------------------
export const activate = (sel: CardSel, by?: DuelistId): Step => ({ op: "activate", sel, by });
/** Respond to a chain window with a card effect. Same as activate. */
export const respond = activate;
export const normalSummon = (sel: CardSel, by?: DuelistId): Step => ({ op: "normalSummon", sel, by });
/** Set a monster or a Spell/Trap from the hand. */
export const setCard = (sel: CardSel, by?: DuelistId): Step => ({ op: "set", sel, by });
export const specialSummon = (sel: CardSel, by?: DuelistId): Step => ({ op: "specialSummon", sel, by });
export const changePosition = (sel: CardSel, by?: DuelistId): Step => ({ op: "changePosition", sel, by });
/** Attack with a monster. Enters the Battle Phase first when the duelist is in Main Phase. */
export const attack = (attacker: CardSel, target: CardSel | "direct", by?: DuelistId): Step => ({
  op: "attack", attacker, target, by,
});
export const changePhase = (to: "battle" | "main2" | "end", by?: DuelistId): Step => ({ op: "phase", to, by });
export const endTurn = (by?: DuelistId): Step => ({ op: "phase", to: "end", by });
/** Decline to chain (a chain prompt answered with "no response"). */
export const pass = (by?: DuelistId): Step => ({ op: "pass", by });

/**
 * FFA surrender uses Debug.SurrenderDuelist. With no chain, the seat leaves immediately. With an open chain, all
 * links resolve normally before the seat leaves. The engine answers the leaver's prompts. Living choices stay open;
 * an optional response to the departed turn player closes, while a response involving only living players stays open.
 * Requires the immediate-surrender core. Use while the duel has an open prompt.
 */
export const surrender = (seat: DuelistId): Step => ({ op: "surrender", seat });
/**
 * Reason 0 is surrender and uses Debug.SurrenderDuelist with the timing above. A nonzero reason uses
 * Debug.EliminateDuelist and lands at the next safe Adjust. Fails if the seat is out or the duel has only two seats.
 */
export const eliminate = (seat: DuelistId, reason = 0): Step => ({ op: "surrender", seat, reason });

// Answers to the next prompt ----------------------------------------------------------------------
/** Pick a choice by option id or label substring. */
export const choose = (match: string, by?: DuelistId): Step => ({ op: "choose", match, by });
/** Answer a card-selection prompt (cards, tributes, materials). */
export const select = (...sels: CardSel[]): Step => ({ op: "select", sels });
/** Select an existing field card by public coordinates, including an opponent's face-down card. */
export const selectCardAt = (owner: DuelistId, zone: Zone, by?: DuelistId): Step => ({ op: "selectCardAt", owner, zone, by });
/** Answer a selection prompt with the first legal options. */
export const auto = (by?: DuelistId): Step => ({ op: "auto", by });
export const zone = (owner: DuelistId, z: Zone, by?: DuelistId): Step => ({ op: "zone", owner, zone: z, by });
export const position = (pos: "atk" | "def" | "set", by?: DuelistId): Step => ({ op: "position", pos, by });
export const yes = (by?: DuelistId): Step => ({ op: "yes", by });
export const no = (by?: DuelistId): Step => ({ op: "no", by });
export const finish = (by?: DuelistId): Step => ({ op: "finish", by });
export const number = (value: number, by?: DuelistId): Step => ({ op: "number", value, by });
export const announce = (card: CardRef, by?: DuelistId): Step => ({ op: "announce", card, by });
/** Escape hatch: send a raw answer to whatever prompt is open. */
export const raw = (answer: DuelAnswer, by?: DuelistId): Step => ({ op: "raw", answer, by });

// Expectations ------------------------------------------------------------------------------------
export const expectBoard = (board: BoardExpect): Step => ({ op: "expectBoard", board });
/** Check the real projection of each private card for every seat and the spectator. Hidden cards have only their place and position. */
export const expectPrivateCards = (cards: Extract<Step, { op: "expectPrivateCards" }>["cards"]): Step => ({ op: "expectPrivateCards", cards });
/** These events happened in this order (other events may sit between them). */
export const expectEvents = (...events: EventMatch[]): Step => ({ op: "expectEvents", events });
export const expectNoEvent = (event: EventMatch): Step => ({ op: "expectNoEvent", event });
/** The duel log (view.log: dice rolls, coin tosses and other lines that are no event) has these lines, each as a substring, in this order. */
export const expectLog = (...lines: string[]): Step => ({ op: "expectLog", lines });
/** No line of the duel log contains this text. */
export const expectNoLog = (text: string): Step => ({ op: "expectNoLog", text });
/** What one viewer's duel log holds: every `has` text appears in some line, no `lacks` text appears. A seat sees its own private lines, the spectator only public ones. */
export const expectLogSeen = (viewer: DuelistId | "spectator", seen: { has?: string[]; lacks?: string[] }): Step => ({ op: "expectLogSeen", viewer, ...seen });
/** The chain links resolved in exactly this order (every chain-resolving event so far). */
export const expectResolved = (...order: CardRef[]): Step => ({ op: "expectResolved", order });
/** The chain stack now, from link 1 up. */
export const expectChain = (...links: CardRef[]): Step => ({ op: "expectChain", links });
export const expectPrompt = (prompt: PromptExpect): Step => ({ op: "expectPrompt", prompt });
export const expectNoPrompt = (): Step => ({ op: "expectNoPrompt" });
/** The open prompt offers this action on this card. */
export const expectOffered = (action: ActionKind | "choice", sel: CardSel, by?: DuelistId): Step => ({
  op: "expectOffered", action, sel, by,
});
/** The open prompt does NOT offer this action on this card. Fails if it does. */
export const expectNotOffered = (action: ActionKind | "choice", sel: CardSel, by?: DuelistId): Step => ({
  op: "expectNotOffered", action, sel, by,
});
/**
 * This seat's private view has no offer for the card. Passes when the seat has no open prompt,
 * including when another seat has the prompt. This does not prove the card is illegal in a response window.
 * To prove that a card is not offered in a real window, open that seat's prompt and use expectNotOffered.
 */
export const expectSeatNotOffered = (action: ActionKind | "choice", sel: CardSel, by: DuelistId): Step => ({
  op: "expectSeatNotOffered", action, sel, by,
});
/** What the final result must be. `seat: null` or `team: null` means a draw. Omitted fields are not checked. */
export interface ResultExpect {
  /** Winning seat. In Tag any seat of the winning team matches. */
  seat?: DuelistId | null;
  team?: number | null;
  /** Substring of the result reason. */
  reason?: string;
}
/** The duel is over. `expectResult("p0", "lp")` (1v1) or `expectResult({ team: 1, reason: "lp" })` (any format). */
export function expectResult(winner: DuelistId | null, reason?: string): Step;
export function expectResult(expected: ResultExpect): Step;
export function expectResult(arg: DuelistId | null | ResultExpect, reason?: string): Step {
  if (arg === null || typeof arg === "string") return { op: "expectResult", winner: arg, reason };
  return { op: "expectResult", winner: arg.seat, team: arg.team, reason: arg.reason };
}
/** Exactly these seats are eliminated (FFA seat, or every seat of an eliminated Tag team). Every other seat is still in. */
export const expectEliminated = (...seats: Array<DuelistId | DuelistId[]>): Step => ({ op: "expectEliminated", seats: seats.flat() });
/** LP of a seat, or of a team (every seat of the team shows the team LP in Tag). */
export const expectLp = (who: { seat: DuelistId } | { team: number }, value: number): Step => ({ op: "expectLp", who, value });
/**
 * The seats that got a chain-response prompt, in order, since the last expectResponseOrder (or the start).
 * Pass and respond steps answer them. A chain prompt that is open now counts as the last one.
 */
export const expectResponseOrder = (...seats: Array<DuelistId | DuelistId[]>): Step => ({ op: "expectResponseOrder", seats: seats.flat() });
/** It is the turn of this seat now. With `turn`, the turn counter must match too (the first turn is 1, every duelist's turn counts). */
export const expectTurn = (seat: DuelistId, turn?: number): Step => ({ op: "expectTurn", seat, turn });
/**
 * The open prompt offers choices on exactly these seats: the seats named by its options (the seats of a pick, or the controllers
 * of the cards of a target list). Order does not matter. `by` also checks which duelist holds the prompt.
 */
export const expectPickSeats = (seats: Array<DuelistId | DuelistId[]>, by?: DuelistId): Step => ({ op: "expectPickSeats", seats: seats.flat(), by });
/** Answer the "pick one opponent" prompt of a direct attack (N-seat formats): attack this seat. */
export const pickOpponent = (seat: DuelistId, by?: DuelistId): Step => ({ op: "pickOpponent", seat, by });

/**
 * The open prompt offers exactly these options (array), or the options that `include` / `exclude` name, with `count` in all.
 * An option is named by its seat, card, label substring or id (see OptionRef). Use it for a pick: the seats of an opponent pick,
 * the cards of one opponent in a card pick, the pool of a chooser. `by` also checks which duelist holds the prompt.
 * Unlike `expectPickSeats` it can also check cards and labels, and it counts options.
 */
export const expectPickOptions = (options: OptionsExpect, by?: DuelistId): Step => ({ op: "expectPickOptions", options, by });
/**
 * The label that the player sees on one option of the open prompt contains `text` (ignores case). The option is named as in
 * `expectPickOptions` and must be exactly one. It checks the text on screen, for example "Attack Player 3 directly" or "Player 2".
 * It does NOT read Lua values: an effect label or a flag-effect label has no view in the engine.
 */
export const expectLabel = (option: OptionRef, text: string, by?: DuelistId): Step => ({ op: "expectLabel", option, text, by });
/**
 * Send an answer that the engine must refuse (the core reports MSG_RETRY, or the host rejects the option). The step passes when the
 * answer throws an engine error, the same prompt is still open and every seat view is byte for byte the same as before.
 * `as` is the seat that sends the answer (default: the seat that holds the prompt), so a wrong seat can answer. `error` is a
 * substring of the error message ("Wrong seat", "Invalid answer", "Stale prompt"). `code` checks the error code.
 * `by` checks which duelist holds the prompt.
 * Fails when the engine takes the answer.
 */
export const expectRetry = (answer: DuelAnswer, opts: { as?: DuelistId; error?: string; code?: DuelErrorCode; by?: DuelistId } = {}): Step => ({
  op: "expectRetry", answer, as: opts.as, error: opts.error, code: opts.code, by: opts.by,
});

// Scenario ------------------------------------------------------------------------------------------
export interface Scenario {
  /** Unique, kebab-case. Also the test name. */
  id: string;
  title: string;
  /** Ruling URL or rulebook reference that proves the expected result. Required. */
  source: string;
  /** Mechanics and families, for example "chain", "summon", "trap", "domain". Card codes are added on their own. */
  tags: string[];
  /**
   * ADR-0002 rule ids this scenario proves. This is the rule-coverage marker: scripts/rule-coverage.ts counts a rule
   * as covered only by a scenario with `rules` that runs on a real engine and asserts an outcome after an action.
   */
  rules?: string[];
  setup: BoardSpec;
  steps: Step[];
  /** Change the duel seed (default ["1","2","3","4"]). Only needed when shuffles matter. */
  seed?: string[];
  /**
   * Set when the engine gives a wrong result. The scenario runs as it.fails: the suite stays
   * green while the bug exists and turns red when it is fixed. Describe the bug here.
   */
  knownBug?: string;
}

export function defineScenario(scenario: Scenario): Scenario {
  return scenario;
}
