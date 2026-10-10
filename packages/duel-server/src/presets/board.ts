import type { DuelDeck, DuelFormat, DuelMasterRule, DuelMode } from "@yugidraft/shared/duels";
import { defaultDuelSettings, seatCountFor } from "@yugidraft/shared/duels";
import type { EngineGameOptions } from "../engine.js";
import { resolveCard, type CardRef } from "./catalog.js";

/**
 * Duelist ids. "p0" and "p1" are seats 0 and 1. "p2" and "p3" are seats 2 and 3: a board that uses
 * them needs `format: "ffa3"`, `"ffa4"` or `"tag"` (Tag seats 0 and 2 are one team, 1 and 3 the other).
 * The default format is `1v1`, where the compiler rejects p2 and p3.
 */
export type DuelistId = "p0" | "p1" | "p2" | "p3";
export const DUELIST_IDS: DuelistId[] = ["p0", "p1", "p2", "p3"];

export function seatOf(id: DuelistId): number {
  const seat = DUELIST_IDS.indexOf(id);
  if (seat < 0) throw new Error(`Unknown duelist "${id}". Use p0, p1, p2 or p3.`);
  return seat;
}

export type Stance = "atk" | "def" | "set" | "up";

/** A card placed on the board. `pos` defaults to face-up (attack for monsters). */
export interface CardSpec {
  card: CardRef;
  /** atk / def = face-up; set = face-down (defense for monsters); up = face-up spell or trap. */
  pos?: Stance;
  /** Xyz materials, placed under the monster. */
  materials?: CardRef[];
  /** false = not properly summoned (default true for field monsters). */
  summoned?: boolean;
}

export type CardEntry = CardRef | CardSpec;

export function set(card: CardRef): CardSpec {
  return { card, pos: "set" };
}
export function def(card: CardRef): CardSpec {
  return { card, pos: "def" };
}
export function xyz(card: CardRef, materials: CardRef[]): CardSpec {
  return { card, materials };
}

export interface DuelistSetup {
  /** Life Points. Default: the duel's starting LP (8000). */
  lp?: number;
  /** Cards in hand. */
  hand?: CardEntry[];
  /** Main Monster Zones 0-4, then Extra Monster Zones 5-6. Use null for a gap. */
  monsters?: Array<CardEntry | null>;
  /** Spell and Trap Zones 0-4. Use null for a gap. */
  spells?: Array<CardEntry | null>;
  /** Field Spell zone. */
  field?: CardEntry;
  /** Pendulum Zones: [left, right]. */
  pendulum?: [CardEntry | null, CardEntry | null];
  grave?: CardRef[];
  banished?: CardRef[];
  /** Main Deck from the top card down. The rest of the Deck is filler (see `deckSize`). */
  deck?: CardRef[];
  /** Extra Deck cards. */
  extra?: CardRef[];
  /** Domain only: the Deck Master, waiting in its zone. */
  deckMaster?: CardRef;
}

export interface BoardSpec {
  /** "normal" (default) or "domain". */
  mode?: DuelMode;
  masterRule?: DuelMasterRule;
  /** Whose Main Phase 1 the scenario starts in. Default "p0". */
  turn?: DuelistId;
  /** Skip the opening Draw Phase when rebuilding a captured board. Later turns draw as usual. Default false. */
  skipOpeningDraw?: boolean;
  /** Let the turn player attack on the very first turn of the duel. Default false. */
  attackFirstTurn?: boolean;
  /** Total Main Deck size, filler included. Default 20. */
  deckSize?: number;
  /** Seat and team layout. Default "1v1". The format decides the seats: ffa3 = p0-p2, ffa4 and tag = p0-p3. */
  format?: DuelFormat;
  /** Reserved. The format fixes the teams. */
  teams?: DuelistId[][];
  /**
   * Test only: names of `Duel.*` functions that the core adds for the multi-player formats (for example "MPAttackedSeat"). They are set to nil
   * when the duel starts, so a scenario can run the fallback of the overlay that an older core without the function would take.
   */
  withoutCoreFunctions?: string[];
  /** Test only: ordinary Spell/Trap placements of monsters become Continuous Spells. Pendulum Zones retain their type. */
  monstersAsContinuousSpells?: boolean;
  p0?: DuelistSetup;
  p1?: DuelistSetup;
  p2?: DuelistSetup;
  p3?: DuelistSetup;
}

/** A vanilla Normal Monster with no script. Used to pad Decks. */
export const FILLER_CARD = "Mystical Elf";

const POS = { atk: "POS_FACEUP_ATTACK", def: "POS_FACEUP_DEFENSE", up: "POS_FACEUP", set: "POS_FACEDOWN" } as const;

function spec(entry: CardEntry): CardSpec {
  return typeof entry === "object" ? entry : { card: entry };
}

function luaPos(stance: Stance | undefined, monster: boolean): string {
  if (monster) {
    if (stance === "set") return "POS_FACEDOWN_DEFENSE";
    if (stance === "def") return POS.def;
    return POS.atk;
  }
  return stance === "set" ? POS.set : POS.up;
}

export interface CompiledBoard {
  options: Pick<EngineGameOptions, "mode" | "decks" | "settings" | "masterRule" | "startupScripts" | "format">;
  /** Every distinct passcode the board uses. */
  codes: number[];
}

/** Compile a board into Decks, settings and a startup Lua chunk (Debug.AddCard calls). */
export function compileBoard(board: BoardSpec, dir?: string): CompiledBoard {
  const mode: DuelMode = board.mode ?? "normal";
  const format: DuelFormat = board.format ?? "1v1";
  const seatCount = seatCountFor(format);
  const seatIds = DUELIST_IDS.slice(0, seatCount);
  for (const id of ["p2", "p3"] as const) {
    if (board[id] && !seatIds.includes(id)) {
      throw new Error(
        seatCount === 2
          ? `Board setup for ${id} needs a multi-player format. Set format: "ffa3", "ffa4" or "tag" (the default 1v1 has p0 and p1).`
          : `Board setup for ${id} does not fit format "${format}", which has ${seatIds.join(", ")}.`,
      );
    }
  }
  const turn = board.turn ?? "p0";
  if (!seatIds.includes(turn)) throw new Error(`Turn player ${turn} is not a seat of format "${format}"`);
  if (seatCount > 2 && turn !== "p0") throw new Error("A multi-player board starts on the turn of p0. Skipping turns to another seat is not supported yet.");
  const used = new Set<number>();
  const code = (ref: CardRef): number => {
    const value = resolveCard(ref, dir);
    used.add(value);
    return value;
  };

  const lua: string[] = [];
  const decks: DuelDeck[] = [];
  const deckSize = board.deckSize ?? 20;
  const filler = code(FILLER_CARD);

  for (const id of seatIds) {
    const seat = seatOf(id);
    const setup = board[id] ?? {};
    const add = (ref: CardRef, location: string, sequence: number, position: string, proc: boolean) => {
      lua.push(`Debug.AddCard(${code(ref)},${seat},${seat},${location},${sequence},${position},${proc})`);
    };
    if (setup.lp != null) lua.push(`Duel.SetLP(${seat},${setup.lp})`);
    for (const entry of setup.hand ?? []) add(spec(entry).card, "LOCATION_HAND", 0, "POS_FACEDOWN", false);
    (setup.monsters ?? []).forEach((entry, index) => {
      if (!entry) return;
      if (index > 6) throw new Error(`${id}.monsters has ${index + 1} slots. Zones are 0-4 (main) and 5-6 (Extra Monster Zones).`);
      const s = spec(entry);
      add(s.card, "LOCATION_MZONE", index, luaPos(s.pos, true), s.summoned !== false);
      for (const material of s.materials ?? []) add(material, "LOCATION_MZONE", index, "POS_FACEUP", false);
    });
    (setup.spells ?? []).forEach((entry, index) => {
      if (!entry) return;
      if (index > 4) throw new Error(`${id}.spells has ${index + 1} slots. Spell and Trap Zones are 0-4. Use field / pendulum for the others.`);
      const s = spec(entry);
      add(s.card, "LOCATION_SZONE", index, luaPos(s.pos, false), true);
      if (board.monstersAsContinuousSpells) lua.push(`do
        local c=Duel.GetFieldCard(${seat},LOCATION_SZONE,${index})
        if c and c:IsOriginalType(TYPE_MONSTER) then
          local e=Effect.CreateEffect(c)
          e:SetType(EFFECT_TYPE_SINGLE); e:SetCode(EFFECT_CHANGE_TYPE)
          e:SetProperty(EFFECT_FLAG_CANNOT_DISABLE)
          e:SetValue(TYPE_SPELL|TYPE_CONTINUOUS); e:SetReset(RESET_EVENT|(RESETS_STANDARD&~RESET_TURN_SET))
          c:RegisterEffect(e)
        end
      end`);
    });
    if (setup.field) {
      const s = spec(setup.field);
      add(s.card, "LOCATION_FZONE", 0, luaPos(s.pos, false), true);
    }
    (setup.pendulum ?? []).forEach((entry, index) => {
      if (!entry) return;
      const s = spec(entry);
      add(s.card, "LOCATION_PZONE", index, luaPos(s.pos, false), true);
    });
    for (const ref of setup.grave ?? []) add(ref, "LOCATION_GRAVE", 0, "POS_FACEUP", false);
    for (const ref of setup.banished ?? []) add(ref, "LOCATION_REMOVED", 0, "POS_FACEUP", false);

    const top = (setup.deck ?? []).map(code);
    if (top.length > deckSize) throw new Error(`${id}.deck lists ${top.length} cards but deckSize is ${deckSize}`);
    const main = [...top];
    while (main.length < deckSize) main.push(filler);
    const deck: DuelDeck = { main, extra: (setup.extra ?? []).map(code), side: [] };
    if (mode === "domain") {
      if (!setup.deckMaster) throw new Error(`${id} needs a deckMaster in domain mode`);
      deck.deckMaster = code(setup.deckMaster);
    } else if (setup.deckMaster) {
      throw new Error(`${id}.deckMaster only works with mode: "domain"`);
    }
    decks.push(deck);
  }

  if (turn === "p1" || board.skipOpeningDraw) {
    // A captured board has already passed its Draw Phase. Keep the skip until the first Main Phase 1;
    // a phase reset would be spent by the skipped p0 turn when p1 starts the scenario.
    lua.push("do");
    if (turn === "p1") {
      lua.push(
        "local skipTurn=Effect.GlobalEffect(); skipTurn:SetType(EFFECT_TYPE_FIELD); skipTurn:SetCode(EFFECT_SKIP_TURN)",
        "skipTurn:SetProperty(EFFECT_FLAG_PLAYER_TARGET); skipTurn:SetTargetRange(1,0); skipTurn:SetReset(RESET_PHASE+PHASE_END); Duel.RegisterEffect(skipTurn,0)",
      );
    }
    lua.push(
      "local skipDraw=Effect.GlobalEffect(); skipDraw:SetType(EFFECT_TYPE_FIELD); skipDraw:SetCode(EFFECT_SKIP_DP)",
      "skipDraw:SetProperty(EFFECT_FLAG_PLAYER_TARGET); skipDraw:SetTargetRange(1,1); Duel.RegisterEffect(skipDraw,0)",
      "local undo=Effect.GlobalEffect(); undo:SetType(EFFECT_TYPE_FIELD+EFFECT_TYPE_CONTINUOUS); undo:SetCode(EVENT_PHASE_START+PHASE_MAIN1)",
      "undo:SetOperation(function(e) skipDraw:Reset() e:Reset() end); Duel.RegisterEffect(undo,0)",
      "end",
    );
  }
  for (const name of board.withoutCoreFunctions ?? []) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`withoutCoreFunctions: "${name}" is not a function name`);
    lua.push(`Duel.${name}=nil`);
  }
  if (board.attackFirstTurn) {
    lua.push(
      "do",
      "local e=Effect.GlobalEffect(); e:SetType(EFFECT_TYPE_FIELD); e:SetCode(EFFECT_BP_FIRST_TURN)",
      "e:SetProperty(EFFECT_FLAG_PLAYER_TARGET); e:SetTargetRange(1,1); Duel.RegisterEffect(e,0)",
      "end",
    );
  }

  // stopAtEveryWindow stays on: scenarios and presets are written against every response window the core lists.
  const settings = { ...defaultDuelSettings(mode), startingHand: 0, shuffleDeck: false, validateDeck: false, stopAtEveryWindow: true };
  return {
    options: {
      mode,
      format,
      masterRule: board.masterRule,
      decks,
      settings,
      startupScripts: [{ name: "scenario-board.lua", content: lua.join("\n") }],
    },
    codes: [...used],
  };
}
