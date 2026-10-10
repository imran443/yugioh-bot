import type { DuelFormat, DuelMode } from "@yugidraft/shared/duels";
import { seatCountFor } from "@yugidraft/shared/duels";
import { type BoardSpec, type DuelistSetup, DUELIST_IDS } from "../../src/presets/board.js";

export type SmokeLocation = "hand" | "field" | "set" | "grave" | "banished" | "deck" | "extra" | "pendulum" | "spell-zone" | "spell-support";
export interface SmokeCard { code: number; type: number; description: string; name?: string; prerelease?: boolean }
export interface SmokeCase { id: string; code: number; seed: number; mode: DuelMode; format: DuelFormat; location: SmokeLocation; board: BoardSpec }
const EXTRA = 0x40 | 0x2000 | 0x800000 | 0x4000000;

/** Location coverage is deliberately broader than text parsing: continuous and trigger effects need events too. */
export function smokeLocations(type: number, text: string): SmokeLocation[] {
  const locations: SmokeLocation[] = type & EXTRA ? ["field", "grave", "banished", "extra"] : ["hand", "field", "grave", "banished", "deck"];
  if (type & (2 | 4) || /FLIP:/i.test(text)) locations.push("set");
  if (type & 0x1000000) locations.push("pendulum");
  if ((type & 1) && /(?:as a|treated as a) Continuous Spell/i.test(text)) locations.push("spell-zone");
  return locations;
}

export function makeSmokeCases(card: SmokeCard, options: { seed?: number; formats?: DuelFormat[]; companions?: number[]; handCompanions?: number[]; fieldCompanion?: number; fieldSpellCompanion?: number; extraCompanions?: number[]; spellCompanions?: number[]; synchroMaterial?: number; typeCompanions?: number[] } = {}): SmokeCase[] {
  const cases: SmokeCase[] = [];
  const companions = (options.companions ?? []).filter(code => code !== card.code).slice(0, 16);
  for (const format of options.formats ?? ["1v1"]) for (const mode of ["normal", "domain"] as const) {
    const locations = smokeLocations(card.type, card.description);
    if (!(card.type & 1) && options.spellCompanions?.length && /Monster Cards?.*Spell & Trap Zone|Spell & Trap Zone.*Monster Card/is.test(card.description)) locations.push("spell-support");
    for (const location of locations) {
      const board: BoardSpec = { mode, format, deckSize: 24, skipOpeningDraw: true };
      for (const seat of DUELIST_IDS.slice(0, seatCountFor(format))) {
        const setup: DuelistSetup = {
          hand: ["Mystical Space Typhoon", "Poison of the Old Man", "Monster Reborn", "Alexandrite Dragon", ...(options.handCompanions ?? companions).slice(0, 6)],
          monsters: [null, options.fieldCompanion ?? options.typeCompanions?.[0] ?? "Mystical Elf", options.typeCompanions?.[1] ?? "Thousand-Eyes Idol", "Junk Synchron",
            ...(/0 ATK/i.test(card.description) ? ["Thousand-Eyes Idol"] : [])],
          spells: [{ card: "Jar of Greed", pos: "set" }, { card: "Dust Tornado", pos: "set" }],
          deck: [...companions, "Mystical Elf", "Alexandrite Dragon", "Monster Reborn", "Polymerization"],
          grave: [...companions, ...options.extraCompanions ?? [], "Mystical Elf", "Alexandrite Dragon", "Aqua Madoor", "Flamvell Guard", "Mechanicalchaser", "Baby Dragon", "Battle Ox", "Polymerization",
            "First of the Dragons", "Ally of Justice Catastor", "Number 17: Leviathan Dragon", "LANphorhynchus"],
          banished: ["Mystical Elf"],
          extra: [...options.extraCompanions ?? [], "Stardust Dragon", "Ally of Justice Catastor", "Number 39: Utopia", "Number 17: Leviathan Dragon", "Number 61: Volcasaurus", "First of the Dragons", "Sea Monster of Theseus", "LANphorhynchus", "Link Spider"],
          ...(mode === "domain" ? { deckMaster: "Mystical Elf" } : {}),
        };
        board[seat] = setup;
      }
      const own = board.p0!;
      for (const id of DUELIST_IDS.slice(1, seatCountFor(format))) board[id]!.monsters![3] = "Card Trooper";
      if (card.type & EXTRA) own.extra!.push(card.code);
      else own.deck!.push(card.code);
      if (options.fieldSpellCompanion) own.field = { card: options.fieldSpellCompanion, pos: "up" };
      if (location === "spell-support") own.spells = options.spellCompanions!.slice(0, card.type & 0x80000 ? 5 : 4).map(code => ({ card: code, pos: "up" }));
      if (location === "hand") own.hand!.unshift(card.code);
      else if (location === "grave") own.grave!.unshift(card.code);
      else if (location === "banished") own.banished!.unshift(card.code);
      else if (location === "deck") own.deck!.unshift(card.code);
      else if (location === "extra") {
        own.extra!.unshift(card.code);
        if (options.synchroMaterial) own.monsters = [null, "Junk Synchron", options.synchroMaterial];
      }
      else if (location === "pendulum") {
        own.spells![0] = null;
        own.pendulum = [card.code, null];
      }
      else if (location === "spell-zone") own.spells!.push({ card: card.code, pos: "up" });
      else if (location === "spell-support" && !(card.type & (4 | 0x80000))) own.hand!.unshift(card.code);
      else if (card.type & 1) own.monsters![0] = { card: card.code, pos: location === "set" ? "set" : "atk",
        ...(card.type & 0x800000 ? { materials: ["Mystical Elf", "Alexandrite Dragon"] } : {}) };
      else if (card.type & 0x80000) own.field = { card: card.code, pos: location === "set" ? "set" : "up" };
      else own.spells!.push({ card: card.code, pos: location === "set" ? "set" : "up" });
      const seed = ((options.seed ?? card.code) + Math.imul(cases.length, 0x9e3779b1)) >>> 0;
      cases.push({ id: `${mode}/${format}/${location}`, code: card.code, seed, mode, format, location, board });
    }
  }
  return cases;
}
