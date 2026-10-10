import { defaultDuelSettings, opponentSeatsOf, teamOfSeat } from "@yugidraft/shared/duels";
import type { DuelCardInfo, DuelChainLink, DuelEngineView, DuelEvent, DuelPrompt, DuelPromptOption, DuelRoom, DuelSeatView } from "@yugidraft/shared/duels";
import { CARDS } from "../../fx-lab/cards";
import { ATTRIBUTE } from "../../attack-styles";
import { LOCATION_DECK, LOCATION_HAND, LOCATION_MZONE, POS_FACEUP_ATTACK, TYPE_CONTINUOUS, TYPE_EFFECT, TYPE_MONSTER, TYPE_TRAP, zoneKey } from "../../constants";
import type { BattleAim, CameraState, TableFormat } from "../types";

import { cardAt, hiddenAt, MZ, SZ, link } from "../../fx-lab/board";

export { newSeat, cardAt, hiddenAt, MZ, SZ, HAND, GY, BANISHED, DECK, EXTRA, FIELD, link } from "../../fx-lab/board";

/** The nine states every mode shows in the preview. */
export const TABLE_STATE_IDS = [
  "main",
  "battle-aim",
  "chain-2",
  "target-pick",
  "choose-opponent",
  "direct-attack",
  "elimination",
  "spectator",
  "result",
] as const;
export type TableStateId = (typeof TABLE_STATE_IDS)[number];

export function isTableStateId(value: string | null | undefined): value is TableStateId {
  return value != null && (TABLE_STATE_IDS as readonly string[]).includes(value);
}

/** The FX lab cards plus the three the multiplayer fixtures also need (real passcodes, so the art loads). */
export const TABLE_CARDS = {
  ...CARDS,
  // The real printed text (6 lines in the peek, a one-line name): the card to hover when the peek must keep its art (Ryo's card in the 3-way table).
  blueEyes: {
    ...CARDS.blueEyes,
    description: "This legendary dragon is a powerful engine of destruction. Virtually invincible, very few have faced this awesome creature and lived to tell the tale.",
  },
  callOfTheHaunted: {
    code: 97077563,
    name: "Call of the Haunted",
    description: "Activate this card by targeting 1 monster in your GY; Special Summon that target in Attack Position.",
    type: TYPE_TRAP | TYPE_CONTINUOUS,
    attack: 0,
    defense: 0,
    level: 0,
    attribute: 0,
    race: "",
  },
  jinzo: {
    code: 77585513,
    name: "Jinzo",
    // A long, realistic effect text, so the preview shows the card panel at a normal long card length (about 650 characters).
    description:
      "Cannot be Normal Summoned/Set. Must first be Special Summoned (from your hand) by banishing 1 LIGHT and 1 DARK monster from your GY. You can only Special Summon \"Jinzo\" once per turn. (1) Once per turn: You can target 1 monster your opponent controls; banish it. (2) If this card attacks a monster, it can make a second attack during each Battle Phase, but only against a monster. (3) If this card is banished: You can send 1 card from your hand to the GY; return this card to the field, and if you do, you can add 1 banished card of yours to your hand. (4) While this card is face-up on the field, your opponent cannot activate the effects of banished cards, and each time a card is banished, you gain 300 LP. These effects are not negated while this card is in your Monster Zone.",
    type: TYPE_MONSTER | TYPE_EFFECT,
    attack: 2400,
    defense: 1500,
    level: 6,
    attribute: ATTRIBUTE.DARK,
    race: "Machine",
  },
  envoy: {
    code: 72989439,
    name: "Black Luster Soldier - Envoy of the Beginning",
    description: "Once per turn: banish 1 monster your opponent controls.",
    type: TYPE_MONSTER | TYPE_EFFECT,
    attack: 3000,
    defense: 2500,
    level: 8,
    attribute: ATTRIBUTE.LIGHT,
    race: "Warrior",
  },
} as const satisfies Record<string, DuelCardInfo>;

export interface TableFixtureState {
  /** One of the nine shared ids, or the id of a mode's own extra state (see `TableFixtureSet.extra`). */
  id: TableStateId | (string & {});
  label: string;
  room: DuelRoom;
  ui?: { aim?: BattleAim | null; camera?: Partial<CameraState>; initialOutOrder?: readonly (readonly number[])[] };
}
export interface TableFixtureSet {
  format: TableFormat;
  title: string;
  states: Readonly<Record<TableStateId, TableFixtureState>>;
  /** States only this mode shows (`?state=<id>`); they are not in the state links of the preview bar. */
  extra?: Readonly<Record<string, TableFixtureState>>;
}

/** The Text log lines of a fixture, as the engine words them ("Player N", seats counted from 1). Ids count up from 1. */
export function fixtureLog(...lines: string[]): DuelEngineView["log"] {
  return lines.map((text, index) => ({ id: index + 1, text }));
}

/** An engine view in the real shape. Team numbers come from the format; everything else is what the caller gives. */
export function fixtureEngine(o: {
  format: TableFormat;
  seats: DuelSeatView[];
  turn: number;
  turnSeat: number;
  phase: string;
  battleStep?: DuelEngineView["battleStep"];
  prompt?: DuelPrompt | null;
  chain?: DuelChainLink[];
  events?: DuelEvent[];
  log?: DuelEngineView["log"];
  result?: DuelEngineView["result"];
}): DuelEngineView {
  return {
    revision: 1,
    format: o.format,
    turn: o.turn,
    turnSeat: o.turnSeat,
    phase: o.phase,
    battleStep: o.battleStep ?? null,
    seats: o.seats.map((view) => ({ ...view, team: view.team ?? teamOfSeat(o.format, view.seat) })),
    prompt: o.prompt ?? null,
    chain: o.chain ?? [],
    events: o.events ?? [],
    log: o.log ?? [],
    result: o.result ?? null,
  };
}

/** A room as the duel page gets it. `viewerSeat: null` makes a spectator room. */
export function fixtureRoom(o: {
  format: TableFormat;
  names: readonly string[];
  viewerSeat: number | null;
  engine: DuelEngineView;
  clockMs?: readonly number[];
  /** A Domain table shows the Deck Master column. Default "normal". */
  mode?: "normal" | "domain";
}): DuelRoom {
  const mode = o.mode ?? "normal";
  const done = o.engine.result != null;
  const winnerSeat = o.engine.result?.winnerSeat ?? null;
  return {
    session: {
      id: 1,
      slug: `table-preview-${o.format}`,
      kind: "play",
      name: `Table preview (${o.format})`,
      guildId: "preview",
      organizerPlayerId: 1,
      mode,
      format: o.format,
      masterRule: 5,
      status: done ? "completed" : "active",
      settings: defaultDuelSettings(mode),
      seats: o.names.map((displayName, seat) => ({ seat, playerId: seat + 1, displayName, ready: true, isBot: false })),
      createdAt: "",
      endedAt: null,
      archivedAt: null,
      winnerPlayerId: winnerSeat == null ? null : winnerSeat + 1,
      winnerSeat,
      resultReason: o.engine.result?.reason ?? null,
    },
    role: o.viewerSeat == null ? "spectator" : "player",
    mySeat: o.viewerSeat,
    myDeck: null,
    engine: o.engine,
    clock: {
      turn: o.engine.turn,
      remainingMs: [...(o.clockMs ?? o.names.map(() => 192_000))],
      activeSeat: done ? null : o.engine.turnSeat,
      startedAt: null,
      serverNow: 0,
    },
    metadataOnly: false,
  };
}

/* ---------- builders for the mode fixture files ---------- */

/** Puts a face-up monster in a Monster Zone of a seat view (sequence 0-4 main, 5-6 Extra Monster Zones). */
export function putMonster(view: DuelSeatView, sequence: number, info: DuelCardInfo, position = POS_FACEUP_ATTACK): void {
  view.monsters[sequence] = cardAt(info, MZ(view.seat, sequence), position);
}

/** Puts a Spell/Trap in a zone of a seat view: face-up from `info`, or face-down (no identity) when `info` is null. */
export function putSpell(view: DuelSeatView, sequence: number, info: DuelCardInfo | null): void {
  view.spells[sequence] = info ? cardAt(info, SZ(view.seat, sequence), POS_FACEUP_ATTACK) : hiddenAt(SZ(view.seat, sequence), 0x0a);
}

/** The same seat views with every hand face-down: what a spectator, or a rival, gets. */
export function withHiddenHands(seats: readonly DuelSeatView[]): DuelSeatView[] {
  return seats.map((view) => ({ ...view, hand: view.hand.map((card) => hiddenAt({ controller: card.controller, location: card.location, sequence: card.sequence })) }));
}

/**
 * The nine preview states of a mode, built from one board. This is the scaffold's placeholder data: each mode file
 * replaces what it needs with hand-made states as its stage is built. `makeSeats` returns fresh seat views each call.
 * The viewer (seat 0) acts in every state except `spectator` and `result`.
 */
export function skeletonFixtureSet(o: {
  format: TableFormat;
  title: string;
  names: readonly string[];
  makeSeats: () => DuelSeatView[];
  turn: number;
  clockMs?: readonly number[];
}): TableFixtureSet {
  const { format, names } = o;
  const foes = opponentSeatsOf(format, 0);
  const firstFoe = foes[0];
  const lastFoe = foes[foes.length - 1];
  const nameOf = (seat: number) => names[seat] ?? `Player ${seat + 1}`;
  const foeMonster = (seats: DuelSeatView[], seat: number) => seats[seat].monsters.findIndex((card, index) => card != null && index < 5);
  const optionFor = (seat: number, sequence: number, label: string) => ({
    id: `m${seat}-${sequence}`,
    label,
    controller: seat,
    location: LOCATION_MZONE,
    sequence,
  });

  const build = (
    id: TableStateId,
    label: string,
    spec: {
      viewerSeat?: number | null;
      phase?: string;
      battleStep?: DuelEngineView["battleStep"];
      edit?: (seats: DuelSeatView[]) => void;
      prompt?: (seats: DuelSeatView[]) => DuelPrompt | null;
      chain?: DuelChainLink[];
      result?: DuelEngineView["result"];
      ui?: TableFixtureState["ui"];
    } = {},
  ): TableFixtureState => {
    const viewerSeat = spec.viewerSeat === undefined ? 0 : spec.viewerSeat;
    let seats = o.makeSeats();
    spec.edit?.(seats);
    if (viewerSeat == null) seats = withHiddenHands(seats);
    const engine = fixtureEngine({
      format,
      seats,
      turn: o.turn,
      turnSeat: 0,
      phase: spec.phase ?? "main1",
      battleStep: spec.battleStep,
      prompt: spec.prompt?.(seats) ?? null,
      chain: spec.chain,
      result: spec.result,
    });
    return { id, label, room: fixtureRoom({ format, names, viewerSeat, engine, clockMs: o.clockMs }), ui: spec.ui };
  };

  const attackerKey = zoneKey(0, LOCATION_MZONE, 0);
  const attackPrompt = (seats: DuelSeatView[]): DuelPrompt => ({
    id: "attack-target",
    seat: 0,
    kind: "cards",
    title: "Select an attack target",
    min: 1,
    max: 1,
    options: foes.flatMap((seat) =>
      seats[seat].monsters.flatMap((card, sequence) => (card && sequence < 5 ? [optionFor(seat, sequence, card.name ?? "Monster")] : [])),
    ),
  });
  const aimAt = (seats: DuelSeatView[]): NonNullable<TableFixtureState["ui"]>["aim"] => {
    const sequence = foeMonster(seats, firstFoe);
    return { mode: "aim", from: attackerKey, to: { zones: sequence < 0 ? [] : [zoneKey(firstFoe, LOCATION_MZONE, sequence)] } };
  };

  const states = {
    main: build("main", "Main Phase"),
    "battle-aim": build("battle-aim", "Battle: aim an attack", {
      phase: "battle",
      battleStep: "battle",
      prompt: attackPrompt,
      ui: { aim: aimAt(o.makeSeats()) },
    }),
    "chain-2": build("chain-2", "Chain link 2: respond", {
      phase: "battle",
      battleStep: "battle",
      chain: [link(1, firstFoe, TABLE_CARDS.mirrorForce), link(2, lastFoe, TABLE_CARDS.callOfTheHaunted)],
      prompt: () => ({
        id: "chain-2",
        seat: 0,
        kind: "choice",
        title: `${nameOf(lastFoe)} activated ${TABLE_CARDS.callOfTheHaunted.name}. Respond?`,
        context: { type: "chain", forced: false },
        options: [
          { id: "activate", label: `Activate ${TABLE_CARDS.solemn.name}`, card: TABLE_CARDS.solemn },
          { id: "pass", label: "Pass" },
        ],
      }),
    }),
    "target-pick": build("target-pick", "Pick a target", {
      prompt: (seats) => ({
        id: "target-pick",
        seat: 0,
        kind: "cards",
        title: "Select 1 monster to destroy",
        min: 1,
        max: 1,
        options: foes.flatMap((seat) =>
          seats[seat].monsters.flatMap((card, sequence) => (card && sequence < 5 ? [optionFor(seat, sequence, card.name ?? "Monster")] : [])),
        ),
      }),
    }),
    "choose-opponent": build("choose-opponent", "Choose an opponent", {
      prompt: () => ({
        id: "choose-opponent",
        seat: 0,
        kind: "choice",
        title: "Choose an opponent",
        context: { type: "opponent" },
        options: foes.map((seat) => ({ id: `opp-${seat}`, label: `Choose ${nameOf(seat)} as the opponent`, controller: seat })),
      }),
    }),
    "direct-attack": build("direct-attack", "Direct attack", {
      phase: "battle",
      battleStep: "battle",
      edit: (seats) => {
        seats[firstFoe].monsters = seats[firstFoe].monsters.map(() => null);
      },
      prompt: () => ({
        id: "direct-attack",
        seat: 0,
        kind: "choice",
        title: "Select a duelist to attack",
        options: foes.slice(0, 1).map((seat) => ({ id: `direct-${seat}`, label: `Attack ${nameOf(seat)} directly`, controller: seat })),
      }),
      ui: { aim: { mode: "aim", from: attackerKey, to: { lpSeat: firstFoe } } },
    }),
    elimination: build("elimination", "Elimination", {
      phase: "battle",
      battleStep: "damage",
      edit: (seats) => {
        for (const seat of format === "tag" ? opponentSeatsOf(format, 0) : [lastFoe]) {
          const view = seats[seat];
          view.lp = 0;
          view.eliminated = true;
          view.hand = [];
          view.monsters = view.monsters.map(() => null);
          view.spells = view.spells.map(() => null);
        }
      },
    }),
    spectator: build("spectator", "Spectator", { viewerSeat: null }),
    result: build("result", "Result", {
      edit: (seats) => {
        for (const seat of foes) {
          seats[seat].lp = 0;
          seats[seat].eliminated = true;
        }
      },
      result: { winnerSeat: 0, winnerTeam: format === "tag" ? 0 : null, reason: format === "tag" ? "The other team reached 0 LP" : "Last duelist standing" },
    }),
  } satisfies Record<TableStateId, TableFixtureState>;
  return { format, title: o.title, states };
}

/** Fourteen Red-Eyes cards of the Deck: the long "add to your hand" search of the card strip review (`?pick=cards`). */
const SEARCH_NAMES = [
  "Red-Eyes Black Dragon", "Red-Eyes Fang with Chain Dragon", "Red-Eyes Black Metal Dragon", "Red-Eyes Dark Dragoon",
  "Red-Eyes Slash Dragon", "Red-Eyes Darkness Metal Dragon", "Red-Eyes Wyvern", "Red-Eyes Archfiend of Lightning",
  "Red-Eyes Flare Metal Dragon", "Red-Eyes Zombie Dragon", "Red-Eyes B. Chick", "Red-Eyes Toon Dragon",
  "Red-Eyes Spirit Dragon", "Red-Eyes Black Dragon Sword",
] as const;
const SEARCH_CODES = [74677422, 4961232, 64335804, 37818794, 71408082, 88264978, 24611934, 29491334, 61140872, 63942330, 36262024, 31293090, 55460084, 19025379] as const;

/** The `?pick=cards` prompt: a pick among many cards of your Deck, so the strip has more cards than any window shows. */
export function searchPrompt(seat: number, count: number = SEARCH_NAMES.length): DuelPrompt {
  const options: DuelPromptOption[] = SEARCH_NAMES.slice(0, count).map((name, sequence) => ({
    id: `s${sequence}`,
    label: name,
    card: { ...TABLE_CARDS.redEyes, code: SEARCH_CODES[sequence], name },
    controller: seat,
    location: LOCATION_DECK,
    sequence,
  }));
  return { id: "pick-search", seat, kind: "cards", title: "Select a card", description: "Add to your hand", min: 1, max: 1, options };
}

/**
 * The "You can respond" prompt with `count` card options (2, 5 or 10 and more): the response panel of a chain, an optional
 * choice among the cards you can activate. The preview shows it as `?state=respond-<count>`.
 */
export function respondPrompt(seat: number, count: number, title: string): DuelPrompt {
  const options: DuelPromptOption[] = Array.from({ length: count }, (_, index) => {
    const name = SEARCH_NAMES[index % SEARCH_NAMES.length];
    return {
      id: `activate-${index}`,
      label: `Activate ${name}`,
      card: { ...TABLE_CARDS.solemn, code: SEARCH_CODES[index % SEARCH_CODES.length], name },
      controller: seat,
      location: LOCATION_HAND,
      sequence: index,
    };
  });
  return { id: `respond-${count}`, seat, kind: "choice", title, context: { type: "chain", forced: false }, cancelable: true, options };
}
