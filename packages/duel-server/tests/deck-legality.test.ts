import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import type { DuelDeck } from "@yugidraft/shared/duels";
import { inspectDeck, validateDeck } from "../src/deck-legality.js";
import { engineDataDirectory as DATA } from "./engine-data-dir.js";

const DARK_MAGICIAN = 46986414;
const DARK_MAGICIAN_GIRL = 38033121;
const CYBER_DRAGON = 70095154;
const BUSTER_BLADER = 78193831;
const BLUE_EYES = 89631139;
const BLUE_EYES_ULTIMATE = 23995346;
const HARPIE_LADY = 76812113;
const HARPIE_LADY_1 = 91932350;
const FLAME_SWORDSMAN = 45231177;
const POT_OF_GREED = 55144522;
const POLYMERIZATION = 24094653;
const KURIBOH_TOKEN = 40703223;
const UMI = 22702055;
const LEGENDARY_OCEAN = 295517;
const GEARFRIED = 423705;

const TYPE_SPELL = 0x2;
const TYPE_MONSTER = 0x1;
const TYPE_TOKEN = 0x4000;
const TYPE_EXTRA = 0x40 | 0x2000 | 0x800000 | 0x4000000;

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

function normalDeck(over: Partial<DuelDeck> = {}): DuelDeck {
  return { main: fillerSpells(40, over.main), extra: [], side: [], ...over };
}

function domainDeck(monster: number, extra: number[] = [], dm = DARK_MAGICIAN): DuelDeck {
  return {
    main: [monster, ...fillerSpells(59, [monster, POT_OF_GREED, POLYMERIZATION, UMI, LEGENDARY_OCEAN])],
    extra,
    side: [],
    deckMaster: dm,
  };
}

describe("validateDeck normal", () => {
  it("rejects fewer than 40 main deck cards", () => {
    expect(() => validateDeck("normal", { main: fillerSpells(39), extra: [], side: [] }, DATA)).toThrow(/40-60/);
  });

  it("rejects more than 3 copies by canonical name including alt arts", () => {
    const arts = [DARK_MAGICIAN, 46986415, 46986416, 46986417];
    expect(() =>
      validateDeck("normal", { main: [...arts, ...fillerSpells(36, arts)], extra: [], side: [] }, DATA),
    ).toThrow(/More than 3 copies of dark magician/i);
  });

  it("rejects an Extra Deck monster in the Main Deck", () => {
    expect(() =>
      validateDeck("normal", { main: [BLUE_EYES_ULTIMATE, ...fillerSpells(39)], extra: [], side: [] }, DATA),
    ).toThrow(/Extra Deck/);
  });

  it("rejects a Main Deck monster in the Extra Deck", () => {
    expect(() =>
      validateDeck("normal", { main: fillerSpells(40), extra: [DARK_MAGICIAN], side: [] }, DATA),
    ).toThrow(/Main Deck/);
  });

  it("rejects tokens", () => {
    expect(() =>
      validateDeck("normal", { main: [KURIBOH_TOKEN, ...fillerSpells(39)], extra: [], side: [] }, DATA),
    ).toThrow(/not a playable deck card/);
  });

  it("rejects unknown passcodes instead of treating them as legal", () => {
    expect(() => validateDeck("normal", { main: [99999999, ...fillerSpells(39)], extra: [], side: [] }, DATA)).toThrow(
      /Unknown card 99999999/,
    );
  });

  it("rejects a missing engine database", () => {
    const empty = mkdtempSync(join(tmpdir(), "duel-engine-"));
    expect(() => validateDeck("normal", { main: fillerSpells(40), extra: [], side: [] }, empty)).toThrow(
      /Cannot read engine card database/,
    );
  });

  it("rejects a Deck Master in Normal Format", () => {
    expect(() => validateDeck("normal", { ...normalDeck(), deckMaster: DARK_MAGICIAN }, DATA)).toThrow(/does not use a Deck Master/);
  });

  it("counts always-treated-as names toward the copy limit", () => {
    expect(() =>
      validateDeck(
        "normal",
        { main: [UMI, UMI, LEGENDARY_OCEAN, LEGENDARY_OCEAN, ...fillerSpells(36, [UMI, LEGENDARY_OCEAN])], extra: [], side: [] },
        DATA,
      ),
    ).toThrow(/More than 3 copies of umi/i);
  });
});

describe("validateDeck domain", () => {
  it("rejects monsters outside type, attribute, archetype, and mentions", () => {
    expect(() => validateDeck("domain", domainDeck(CYBER_DRAGON), DATA)).toThrow(/outside the Deck Master's Domain/);
  });

  it("rejects a Dragon that is not mentioned when the Deck Master does not include Dragon", () => {
    expect(() => validateDeck("domain", domainDeck(GEARFRIED, [], DARK_MAGICIAN_GIRL), DATA)).toThrow(
      /outside the Deck Master's Domain/,
    );
  });

  it("rejects alias duplicates including Harpie Lady 1", () => {
    const main = [HARPIE_LADY, HARPIE_LADY_1, ...fillerSpells(58, [HARPIE_LADY, HARPIE_LADY_1])];
    expect(() => validateDeck("domain", { main, extra: [], side: [], deckMaster: BUSTER_BLADER }, DATA)).toThrow(
      /Duplicate card/,
    );
  });

  it("rejects always-treated-as name duplicates", () => {
    const main = [UMI, LEGENDARY_OCEAN, ...fillerSpells(58, [UMI, LEGENDARY_OCEAN])];
    expect(() => validateDeck("domain", { main, extra: [], side: [], deckMaster: DARK_MAGICIAN }, DATA)).toThrow(
      /Duplicate card/,
    );
  });

  it("rejects the Deck Master appearing in the Main Deck", () => {
    expect(() => validateDeck("domain", domainDeck(DARK_MAGICIAN), DATA)).toThrow(/cannot appear/);
  });

  it("rejects the Deck Master's alias appearing in the deck", () => {
    const main = [46986415, ...fillerSpells(59, [46986415])];
    expect(() => validateDeck("domain", { main, extra: [], side: [], deckMaster: DARK_MAGICIAN }, DATA)).toThrow(/cannot appear/);
  });

  it("allows a Main Deck Pendulum monster as Deck Master", () => {
    expect(() =>
      validateDeck("domain", { main: fillerSpells(60), extra: [], side: [], deckMaster: 16178681 }, DATA),
    ).not.toThrow();
  });

  it("allows an Extra Deck Pendulum monster as Deck Master", () => {
    const db = new Database(join(DATA, "cards.cdb"), { readonly: true, fileMustExist: true });
    const extraPendulum = db
      .prepare(
        `SELECT datas.id FROM datas JOIN texts USING (id)
         WHERE type & 1 != 0 AND type & 16777216 != 0 AND type & ? != 0
           AND alias = 0 AND (ot & 3) != 0
         ORDER BY datas.id LIMIT 1`,
      )
      .get(TYPE_EXTRA) as { id: number } | undefined;
    db.close();
    expect(extraPendulum, "pinned card data must include an Extra Pendulum monster").toBeDefined();
    expect(() =>
      validateDeck("domain", { main: fillerSpells(60), extra: [], side: [], deckMaster: extraPendulum!.id }, DATA),
    ).not.toThrow();
  });


  it("rejects a non-monster Deck Master", () => {
    expect(() =>
      validateDeck("domain", { main: fillerSpells(60), extra: [], side: [], deckMaster: POT_OF_GREED }, DATA),
    ).toThrow("You can't use a Spell or Trap as your Deck Master.");
  });

  it("rejects a missing Deck Master", () => {
    expect(() => validateDeck("domain", { main: fillerSpells(60), extra: [], side: [] }, DATA)).toThrow(/Deck Master is required/);
  });

  it("rejects a side deck in Domain Format", () => {
    expect(() =>
      validateDeck("domain", { main: fillerSpells(60), extra: [], side: [POLYMERIZATION], deckMaster: DARK_MAGICIAN }, DATA),
    ).toThrow(/does not use a Side Deck/);
  });

  it("does not treat vanilla flavor text as Domain mentions", () => {
    const db = new Database(join(DATA, "cards.cdb"), { readonly: true, fileMustExist: true });
    const vanilla = db
      .prepare(
        `SELECT datas.id, name, desc, race, attribute, type FROM datas JOIN texts USING (id)
         WHERE type & 16 != 0 AND type & 32 = 0 AND type & 1 != 0 AND type & ? = 0
           AND alias = 0 AND (ot & 3) != 0 AND desc LIKE '%Dragon%' AND race != 8192 AND attribute != 16
         LIMIT 1`,
      )
      .get(TYPE_EXTRA) as { id: number; name: string } | undefined;
    db.close();
    expect(vanilla, "pinned card data must include the flavor-text fixture").toBeDefined();
    expect(() => validateDeck("domain", domainDeck(BLUE_EYES, [], vanilla!.id), DATA)).toThrow(/outside the Deck Master's Domain/);
  });

  it("rejects 16 extra deck cards", () => {
    const extras = [BLUE_EYES_ULTIMATE, FLAME_SWORDSMAN];
    const db = new Database(join(DATA, "cards.cdb"), { readonly: true, fileMustExist: true });
    const more = db
      .prepare(
        `SELECT datas.id FROM datas JOIN texts USING (id)
         WHERE type & ? != 0 AND type & ? != 0 AND alias = 0 AND (ot & 3) != 0
         ORDER BY datas.id LIMIT 20`,
      )
      .all(TYPE_MONSTER, TYPE_EXTRA) as Array<{ id: number }>;
    db.close();
    const extra = [...new Set([...extras, ...more.map((row) => row.id)])].slice(0, 16);
    expect(() => validateDeck("domain", { main: fillerSpells(60), extra, side: [], deckMaster: DARK_MAGICIAN }, DATA)).toThrow(
      /15 or fewer/,
    );
  });
});

describe("validateDeck engine bundle", () => {
  it("rejects strings.conf missing rather than skipping archetype checks", () => {
    const empty = mkdtempSync(join(tmpdir(), "duel-engine-"));
    writeFileSync(join(empty, "cards.cdb"), "not a database");
    expect(() => validateDeck("normal", { main: [1], extra: [], side: [] }, empty)).toThrow(/strings\.conf/);
  });
});

function refOf(card: { section: string; index: number; code: number }) {
  return { section: card.section, index: card.index, code: card.code };
}

describe("inspectDeck", () => {
  it("aggregates independent size and card issues and validateDeck throws the first", () => {
    const deck: DuelDeck = {
      main: [BLUE_EYES_ULTIMATE, KURIBOH_TOKEN, ...fillerSpells(37)],
      extra: [DARK_MAGICIAN],
      side: [],
    };
    const { issues } = inspectDeck("normal", deck, DATA);
    expect(issues.map((issue) => issue.message)).toEqual([
      "Main Deck must have 40-60 cards",
      expect.stringMatching(/Extra Deck/),
      expect.stringMatching(/not a playable deck card/),
      expect.stringMatching(/Main Deck/),
    ]);
    expect(issues[1]?.cards.map(refOf)).toEqual([{ section: "main", index: 0, code: BLUE_EYES_ULTIMATE }]);
    expect(issues[2]?.cards.map(refOf)).toEqual([{ section: "main", index: 1, code: KURIBOH_TOKEN }]);
    expect(issues[3]?.cards.map(refOf)).toEqual([{ section: "extra", index: 0, code: DARK_MAGICIAN }]);
    expect(() => validateDeck("normal", deck, DATA)).toThrow(issues[0]!.message);
  });

  it("highlights only copies beyond the allowance in main/extra/side order", () => {
    const arts = [DARK_MAGICIAN, 46986415, 46986416, 46986417];
    const { issues } = inspectDeck(
      "normal",
      {
        main: [arts[0]!, arts[1]!, ...fillerSpells(38, arts)],
        extra: [],
        side: [arts[2]!, arts[3]!],
      },
      DATA,
    );
    const copies = issues.find((issue) => /more than 3 copies of dark magician/i.test(issue.message));
    expect(copies?.cards.map(refOf)).toEqual([
      { section: "side", index: 1, code: 46986417 },
    ]);
  });

  it("still reports size, loadable, and copy issues when the Deck Master is missing", () => {
    const deck: DuelDeck = {
      main: [HARPIE_LADY, HARPIE_LADY_1, CYBER_DRAGON, ...fillerSpells(56, [HARPIE_LADY, HARPIE_LADY_1, CYBER_DRAGON])],
      extra: [],
      side: [POLYMERIZATION, UMI],
    };
    const { issues } = inspectDeck("domain", deck, DATA);
    expect(issues.some((issue) => /Deck Master is required/.test(issue.message))).toBe(true);
    expect(issues.some((issue) => /exactly 60 cards/.test(issue.message))).toBe(true);
    const noSide = issues.find((issue) => /does not use a Side Deck/.test(issue.message));
    expect(noSide?.cards.map(refOf)).toEqual([
      { section: "side", index: 0, code: POLYMERIZATION },
      { section: "side", index: 1, code: UMI },
    ]);
    expect(issues.some((issue) => /Duplicate card/.test(issue.message))).toBe(true);
    expect(issues.some((issue) => /outside the Deck Master's Domain/.test(issue.message))).toBe(false);
  });

  it("still reports copy and size issues when the Deck Master is invalid", () => {
    const deck: DuelDeck = {
      main: [UMI, LEGENDARY_OCEAN, ...fillerSpells(57, [UMI, LEGENDARY_OCEAN])],
      extra: [],
      side: [],
      deckMaster: POT_OF_GREED,
    };
    const { issues } = inspectDeck("domain", deck, DATA);
    expect(issues.some((issue) => issue.message === "You can't use a Spell or Trap as your Deck Master.")).toBe(true);
    expect(issues.some((issue) => /exactly 60 cards/.test(issue.message))).toBe(true);
    expect(issues.some((issue) => /Duplicate card/.test(issue.message))).toBe(true);
    expect(issues.find((issue) => issue.message === "You can't use a Spell or Trap as your Deck Master.")?.cards.map(refOf)).toEqual([
      { section: "deckMaster", index: 0, code: POT_OF_GREED },
    ]);
  });

  it("references every Side card on the Domain no-Side issue", () => {
    const deck: DuelDeck = {
      main: fillerSpells(60),
      extra: [],
      side: [POLYMERIZATION, UMI],
      deckMaster: DARK_MAGICIAN,
    };
    const { issues } = inspectDeck("domain", deck, DATA);
    const noSide = issues.find((issue) => /does not use a Side Deck/.test(issue.message));
    expect(noSide?.cards).toEqual([
      { section: "side", index: 0, code: POLYMERIZATION, name: expect.any(String) },
      { section: "side", index: 1, code: UMI, name: expect.any(String) },
    ]);
  });

  it("highlights Deck Master duplicates in the deck, not the master slot", () => {
    const { issues } = inspectDeck("domain", domainDeck(DARK_MAGICIAN, [], DARK_MAGICIAN), DATA);
    const duplicateMaster = issues.find((issue) => /cannot appear/.test(issue.message));
    expect(duplicateMaster?.cards.map(refOf)).toEqual([{ section: "main", index: 0, code: DARK_MAGICIAN }]);
    expect(duplicateMaster?.cards.some((card) => card.section === "deckMaster")).toBe(false);
  });
});

