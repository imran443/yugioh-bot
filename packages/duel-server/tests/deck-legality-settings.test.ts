import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import type { DuelDeck, DuelSettings } from "@yugidraft/shared/duels";
import { TCG_2026_09_LIMITS, OCG_2026_07_LIMITS } from "../src/banlists/compiled.js";
import { inspectDeck, validateDeck } from "../src/deck-legality.js";
import { engineDataDirectory as DATA } from "./engine-data-dir.js";

const DARK_MAGICIAN = 46986414;
const DARK_MAGICIAN_ALT = 46986415;
const CYBER_DRAGON = 70095154;
const POT_OF_GREED = 55144522;
const KURIBOH_TOKEN = 40703223;
const BLUE_EYES_ULTIMATE = 23995346;
const ASH_BLOSSOM = 14558127;
const CALLED_BY_THE_GRAVE = 24224830;
const MIND_MASTER = 96782886;
const POLYMERIZATION = 24094653;

const TYPE_SPELL = 0x2;
const TYPE_MONSTER = 0x1;
const TYPE_TOKEN = 0x4000;
const TYPE_EXTRA = 0x40 | 0x2000 | 0x800000 | 0x4000000;

function settings(over: Partial<DuelSettings> = {}): DuelSettings {
  return {
    visibility: "public",
    banlist: "none",
    cardPool: "both",
    turnSeconds: 240,
    startingLP: 8000,
    startingHand: 5,
    drawPerTurn: 1,
    timeout: "loss",
    validateDeck: true,
    shuffleDeck: true,
    ...over,
  };
}

function fillerSpells(count: number, exclude: number[] = []): number[] {
  const db = new Database(join(DATA, "cards.cdb"), { readonly: true, fileMustExist: true });
  try {
    const rows = db
      .prepare(
        `SELECT datas.id FROM datas JOIN texts USING (id)
         WHERE type & ? != 0 AND type & ? = 0 AND type & ? = 0
           AND (ot & 3) != 0 AND alias = 0
           AND desc NOT LIKE '%always treated as%'
         ORDER BY datas.id`,
      )
      .all(TYPE_SPELL, TYPE_MONSTER, TYPE_TOKEN) as Array<{ id: number }>;
    const skip = new Set(exclude);
    const ids: number[] = [];
    for (const row of rows) {
      if (skip.has(row.id)) continue;
      ids.push(row.id);
      if (ids.length === count) return ids;
    }
    throw new Error(`Need ${count} filler spells, found ${ids.length}`);
  } finally {
    db.close();
  }
}

function tcgLegalFillers(count: number, exclude: number[] = []): number[] {
  const banned = Object.keys(TCG_2026_09_LIMITS).map(Number);
  return fillerSpells(count, [...exclude, ...banned]);
}

function ocgLegalFillers(count: number, exclude: number[] = []): number[] {
  const listed = Object.keys(OCG_2026_07_LIMITS).map(Number);
  return fillerSpells(count, [...exclude, ...listed]);
}

function regionOnlyCard(region: "tcg" | "ocg"): { id: number; name: string } {
  const db = new Database(join(DATA, "cards.cdb"), { readonly: true, fileMustExist: true });
  try {
    const want = region === "tcg" ? 2 : 1;
    const hide = region === "tcg" ? 1 : 2;
    const row = db
      .prepare(
        `SELECT datas.id, name FROM datas JOIN texts USING (id)
         WHERE type & ? != 0 AND type & ? = 0 AND type & ? = 0
           AND alias = 0 AND (ot & ?) != 0 AND (ot & ?) = 0
           AND (ot & 8) = 0 AND (ot & 16) = 0 AND (ot & 32) = 0 AND (ot & 512) = 0 AND (ot & 4096) = 0
         ORDER BY datas.id LIMIT 1`,
      )
      .get(TYPE_SPELL, TYPE_MONSTER, TYPE_TOKEN, want, hide) as { id: number; name: string } | undefined;
    if (!row) throw new Error(`Need a ${region}-only playable spell`);
    return row;
  } finally {
    db.close();
  }
}

function limitedAliasPair(): { primary: number; art: number; name: string } {
  const db = new Database(join(DATA, "cards.cdb"), { readonly: true, fileMustExist: true });
  try {
    for (const [id, limit] of Object.entries(TCG_2026_09_LIMITS)) {
      if (limit !== 1) continue;
      const code = Number(id);
      const art = db
        .prepare("SELECT id FROM datas WHERE alias = ? AND (ot & 3) != 0 ORDER BY id LIMIT 1")
        .get(code) as { id: number } | undefined;
      if (!art) continue;
      const text = db.prepare("SELECT name FROM texts WHERE id = ?").get(code) as { name: string } | undefined;
      if (!text) continue;
      return { primary: code, art: art.id, name: text.name };
    }
    throw new Error("Need a TCG-limited card with an alt art");
  } finally {
    db.close();
  }
}

describe("validateDeck settings banlist", () => {
  it("rejects a forbidden TCG card including when the rest of the deck is otherwise legal", () => {
    expect(() =>
      validateDeck(
        "normal",
        { main: [POT_OF_GREED, ...tcgLegalFillers(39, [POT_OF_GREED])], extra: [], side: [] },
        DATA,
        settings({ banlist: "tcg-2026-09" }),
      ),
    ).toThrow(/pot of greed is forbidden/i);
  });

  it("rejects two copies of a TCG limited card and allows one", () => {
    const two = [CALLED_BY_THE_GRAVE, CALLED_BY_THE_GRAVE, ...tcgLegalFillers(38, [CALLED_BY_THE_GRAVE])];
    expect(() =>
      validateDeck("normal", { main: two, extra: [], side: [] }, DATA, settings({ banlist: "tcg-2026-09" })),
    ).toThrow(/more than 1 copy of/i);
    expect(() =>
      validateDeck(
        "normal",
        { main: [CALLED_BY_THE_GRAVE, ...tcgLegalFillers(39, [CALLED_BY_THE_GRAVE])], extra: [], side: [] },
        DATA,
        settings({ banlist: "tcg-2026-09" }),
      ),
    ).not.toThrow();
  });

  it("counts a limited card and its alt art toward the same identity group", () => {
    const pair = limitedAliasPair();
    expect(() =>
      validateDeck(
        "normal",
        { main: [pair.primary, pair.art, ...tcgLegalFillers(38, [pair.primary, pair.art])], extra: [], side: [] },
        DATA,
        settings({ banlist: "tcg-2026-09" }),
      ),
    ).toThrow(/more than 1 copy of/i);
  });

  it("allows three Ash Blossom on TCG September 2026 and rejects the third on OCG July 2026", () => {
    const three = [ASH_BLOSSOM, ASH_BLOSSOM, ASH_BLOSSOM];
    expect(() =>
      validateDeck(
        "normal",
        { main: [...three, ...tcgLegalFillers(37, three)], extra: [], side: [] },
        DATA,
        settings({ banlist: "tcg-2026-09" }),
      ),
    ).not.toThrow();
    expect(() =>
      validateDeck(
        "normal",
        { main: [...three, ...ocgLegalFillers(37, three)], extra: [], side: [] },
        DATA,
        settings({ banlist: "ocg-2026-07" }),
      ),
    ).toThrow(/more than 2 copies of/i);
  });

  it("treats Mind Master as unlimited on the pinned TCG list after the 2026-09-28 delay", () => {
    expect(() =>
      validateDeck(
        "normal",
        { main: [MIND_MASTER, ...tcgLegalFillers(39, [MIND_MASTER])], extra: [], side: [] },
        DATA,
        settings({ banlist: "tcg-2026-09" }),
      ),
    ).not.toThrow();
  });

  it("rejects an unknown banlist id instead of skipping the list", () => {
    expect(() =>
      validateDeck("normal", { main: fillerSpells(40), extra: [], side: [] }, DATA, settings({ banlist: "tcg-2025-01" })),
    ).toThrow(/unknown banlist/i);
  });

  it("applies a custom banlist to the separate Domain Deck Master", () => {
    const cyberStein = 69015963;
    const deck = { main: tcgLegalFillers(60), extra: [], side: [], deckMaster: cyberStein };
    const { issues } = inspectDeck("domain", deck, DATA, settings({ banlist: "tcg-2026-09" }));
    expect(issues.flatMap((issue) => issue.cards)).toContainEqual(
      expect.objectContaining({ section: "deckMaster", index: 0, code: cyberStein }),
    );
    expect(inspectDeck("domain", deck, DATA, settings()).issues).toEqual([]);
    expect(inspectDeck("domain", deck, DATA, settings({ banlist: "tcg-2026-09", validateDeck: false })).issues).toEqual([]);
  });
});

describe("validateDeck settings card pool", () => {
  it("rejects an OCG-only card from a TCG pool and a TCG-only card from an OCG pool", () => {
    const ocgOnly = regionOnlyCard("ocg");
    const tcgOnly = regionOnlyCard("tcg");
    expect(() =>
      validateDeck(
        "normal",
        { main: [ocgOnly.id, ...tcgLegalFillers(39, [ocgOnly.id])], extra: [], side: [] },
        DATA,
        settings({ banlist: "none", cardPool: "tcg" }),
      ),
    ).toThrow(/not TCG legal/);
    expect(() =>
      validateDeck(
        "normal",
        { main: [tcgOnly.id, ...ocgLegalFillers(39, [tcgOnly.id])], extra: [], side: [] },
        DATA,
        settings({ banlist: "none", cardPool: "ocg" }),
      ),
    ).toThrow(/not OCG legal/);
  });
});

describe("validateDeck=false safety", () => {
  it("allows four Dark Magician copies and a short Main Deck when competitive checks are off", () => {
    const main = [DARK_MAGICIAN, DARK_MAGICIAN, DARK_MAGICIAN, DARK_MAGICIAN_ALT, ...fillerSpells(16, [DARK_MAGICIAN, DARK_MAGICIAN_ALT])];
    expect(() =>
      validateDeck("normal", { main, extra: [], side: [] }, DATA, settings({ validateDeck: false, startingHand: 5 })),
    ).not.toThrow();
  });

  it("still rejects tokens, extra-deck cards in Main, unknown ids, and oversize sections", () => {
    const short = fillerSpells(20);
    expect(() =>
      validateDeck(
        "normal",
        { main: [KURIBOH_TOKEN, ...fillerSpells(19)], extra: [], side: [] },
        DATA,
        settings({ validateDeck: false }),
      ),
    ).toThrow(/not a playable deck card/);
    expect(() =>
      validateDeck(
        "normal",
        { main: [BLUE_EYES_ULTIMATE, ...fillerSpells(19)], extra: [], side: [] },
        DATA,
        settings({ validateDeck: false }),
      ),
    ).toThrow(/Extra Deck/);
    expect(() =>
      validateDeck("normal", { main: [99999999, ...short.slice(1)], extra: [], side: [] }, DATA, settings({ validateDeck: false })),
    ).toThrow(/Unknown card 99999999/);
    expect(() =>
      validateDeck("normal", { main: fillerSpells(61), extra: [], side: [] }, DATA, settings({ validateDeck: false })),
    ).toThrow(/60 or fewer/);
  });

  it("still requires Main Deck length to cover startingHand", () => {
    expect(() =>
      validateDeck(
        "normal",
        { main: fillerSpells(4), extra: [], side: [] },
        DATA,
        settings({ validateDeck: false, startingHand: 5 }),
      ),
    ).toThrow(/at least 5 cards/);
  });

  it("still applies card-pool restriction when competitive checks are off", () => {
    const ocgOnly = regionOnlyCard("ocg");
    expect(() =>
      validateDeck(
        "normal",
        { main: [ocgOnly.id, ...fillerSpells(19, [ocgOnly.id])], extra: [], side: [] },
        DATA,
        settings({ validateDeck: false, cardPool: "tcg" }),
      ),
    ).toThrow(/not TCG legal/);
  });

  it("keeps Domain Side cards and an explicit monster Deck Master when competitive checks are off", () => {
    const deck: DuelDeck = {
      main: [CYBER_DRAGON, ...fillerSpells(19, [CYBER_DRAGON, DARK_MAGICIAN])],
      extra: [],
      side: [POLYMERIZATION],
      deckMaster: DARK_MAGICIAN,
    };
    expect(() => validateDeck("domain", deck, DATA, settings({ validateDeck: false }))).not.toThrow();
  });

  it("still requires a playable monster Deck Master in Domain when competitive checks are off", () => {
    expect(() =>
      validateDeck(
        "domain",
        { main: fillerSpells(20), extra: [], side: [], deckMaster: POT_OF_GREED },
        DATA,
        settings({ validateDeck: false }),
      ),
    ).toThrow("You can't use a Spell or Trap as your Deck Master.");
    expect(() =>
      validateDeck("domain", { main: fillerSpells(20), extra: [], side: [] }, DATA, settings({ validateDeck: false })),
    ).toThrow(/Deck Master is required/);
  });
});

describe("inspectDeck settings", () => {
  it("references every forbidden copy and still reports a short Main Deck", () => {
    const deck = {
      main: [POT_OF_GREED, ...tcgLegalFillers(37, [POT_OF_GREED])],
      extra: [] as number[],
      side: [POT_OF_GREED],
    };
    const { issues } = inspectDeck("normal", deck, DATA, settings({ banlist: "tcg-2026-09" }));
    expect(issues.some((issue) => /40-60/.test(issue.message))).toBe(true);
    const forbidden = issues.find((issue) => /pot of greed is forbidden/i.test(issue.message));
    expect(forbidden?.cards.map((card) => ({ section: card.section, index: card.index, code: card.code }))).toEqual([
      { section: "main", index: 0, code: POT_OF_GREED },
      { section: "side", index: 0, code: POT_OF_GREED },
    ]);
    expect(() => validateDeck("normal", deck, DATA, settings({ banlist: "tcg-2026-09" }))).toThrow(/40-60/);
  });

  it("highlights only limited copies beyond the allowance", () => {
    const two = [CALLED_BY_THE_GRAVE, CALLED_BY_THE_GRAVE, ...tcgLegalFillers(38, [CALLED_BY_THE_GRAVE])];
    const { issues } = inspectDeck("normal", { main: two, extra: [], side: [] }, DATA, settings({ banlist: "tcg-2026-09" }));
    const limited = issues.find((issue) => /more than 1 copy of/i.test(issue.message));
    expect(limited?.cards.map((card) => ({ section: card.section, index: card.index, code: card.code }))).toEqual([
      { section: "main", index: 1, code: CALLED_BY_THE_GRAVE },
    ]);
  });
});

