import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterAll, describe, expect, it } from "vitest";
import { loadScenarios, parseAdrRules, type ScenarioLike } from "../../../scripts/rule-coverage.js";
import { CARD_RULE_PROOF, MULTIPLAYER_CARD_RULES, MULTIPLAYER_FORBIDDEN } from "../../../src/banlists/multiplayer.js";
import { engineDataDirectory } from "../../engine-data-dir.js";
import {
  CARD_RULE_EVIDENCE,
  FORBIDDEN_EVIDENCE,
  GROUP_ALL,
  GROUP_ONE,
  LIVE_PROOF,
  SCENARIOS,
  type CatalogScenario,
  type Evidence,
} from "./catalog.js";

// Catalog checks for the multiplayer card scenarios. No duel runs here. The sketches are data. A sketch whose card has live
// proof (LIVE_PROOF) shows as a test, and this file checks that the live scenarios exist. The live scenarios run in the other
// test files of this folder. See docs/specs/2026-09-30-multiplayer-card-scenarios.md.

const __dirname = dirname(fileURLToPath(import.meta.url));
const scripts = join(engineDataDirectory, "card-scripts");
const db = new Database(join(engineDataDirectory, "cards.cdb"), { readonly: true, fileMustExist: true });
afterAll(() => db.close());

const cardName = (code: number): string | undefined =>
  (db.prepare("SELECT t.name AS name FROM datas d JOIN texts t USING (id) WHERE d.id = ?").get(code) as { name: string } | undefined)
    ?.name;

const overlay = join(__dirname, "../../../domain-core/multi-scripts");
const evidenceFile = (file: string) => file.startsWith("overlay/") ? join(overlay, file.slice(8)) : join(scripts, file);
const fileLines = new Map<string, string[]>();
function linesOf(file: string): string[] {
  let lines = fileLines.get(file);
  if (!lines) {
    lines = readFileSync(evidenceFile(file), "utf8").split(/\r?\n/);
    fileLines.set(file, lines);
  }
  return lines;
}

function evidenceProblems(evidence: Evidence[]): string[] {
  const problems: string[] = [];
  for (const item of evidence) {
    if (item.file.startsWith("manifest/")) {
      const code = Number(item.file.slice(9));
      const manifest = JSON.parse(readFileSync(join(overlay, "MANIFEST.json"), "utf8")) as { cards: { code: number; kind: string }[] };
      const entry = manifest.cards.find((card) => card.code === code);
      if (!entry || `kind:${entry.kind}` !== item.token) problems.push(`${item.file} does not contain "${item.token}"`);
      continue;
    }
    if (!existsSync(evidenceFile(item.file))) {
      problems.push(`${item.file} does not exist`);
      continue;
    }
    const text = linesOf(item.file)[item.line - 1];
    if (text === undefined) problems.push(`${item.file}:${item.line} is past the end of the file`);
    else if (!text.includes(item.token)) problems.push(`${item.file}:${item.line} does not contain "${item.token}"`);
  }
  return problems;
}

const hasScript = (code: number) => ["official", "pre-release"].some(folder => existsSync(join(scripts, folder, `c${code}.lua`)));
const dup = <T>(values: T[]) => values.filter((value, index) => values.indexOf(value) !== index);
// The live scenario data has more fields than ScenarioLike names. The table of a scenario is setup.format (1v1 when absent).
const formatOf = async () =>
  new Map(((await loadScenarios()) as (ScenarioLike & { setup?: { format?: string } })[]).map((scenario) => [scenario.id, scenario.setup?.format ?? "1v1"]));

describe("multiplayer card catalog", () => {
  it("keeps 21 all-seat or ongoing cards and 45 one-opponent cards after the FFA rule change", () => {
    expect(GROUP_ALL).toHaveLength(21);
    expect(GROUP_ONE).toHaveLength(45);
    expect(MULTIPLAYER_FORBIDDEN).toHaveLength(48);
    expect(MULTIPLAYER_FORBIDDEN.filter((entry) => entry.formats.includes("tag"))).toHaveLength(26);
  });

  it("puts opponent-field cards in the one-opponent group with the declaration or response rule", () => {
    for (const code of [12580477, 18144506, 44095762, 2314238, 14532163, 35480699, 55063751, 69162969, 66788016, 88240808]) {
      const row = SCENARIOS.find((scenario) => scenario.code === code);
      expect(row?.group, String(code)).toBe("one");
      expect(row?.binding, String(code)).toBeDefined();
      expect(row?.rules, String(code)).toContain(row?.binding === "event-opponent" ? "R-FFA-OPP-RESPONSE" : "R-FFA-OPP-ONE");
    }
    for (const row of GROUP_ONE.filter((scenario) => scenario.binding === "event-opponent")) {
      expect(row.rules, row.id).not.toContain("R-FFA-OPP-ONE");
      expect(row.rules, row.id).toContain("R-FFA-OPP-RESPONSE");
    }
    expect(SCENARIOS.find((scenario) => scenario.code === 14532163)?.rules).not.toContain("R-COMMON-ALL-BOTH");
    expect(SCENARIOS.find((scenario) => scenario.code === 44095762)?.rules).toContain("R-FFA-OPP-RESPONSE");
    expect(SCENARIOS.find((scenario) => scenario.code === 35480699)?.rules).toContain("R-COMMON-ALL-BOTH");
    expect(SCENARIOS.flatMap((scenario) => scenario.rules)).not.toContain("R-COMMON-OPP-FIELD");
  });

  it("binds Kycoo to the opponent that took the battle damage and registers both new proofs", () => {
    const kycoo = GROUP_ONE.find(row => row.code === 88240808)!;
    expect(kycoo.binding).toBe("event-opponent");
    expect(kycoo.rules).toContain("R-FFA-OPP-RESPONSE");
    for (const text of [kycoo.oneVsOne, ...Object.values(kycoo.results)]) {
      expect(text).toContain("up to 2 monsters");
      expect(text).toContain("GY");
      expect(text).not.toContain("field");
    }
    for (const format of ["ffa3", "ffa4"] as const) {
      expect(kycoo.results[format]).toContain("the opponent that took the battle damage");
      expect(kycoo.results[format]).not.toContain("declared");
    }
    for (const [code, slug] of [[88240808, "kycoo-battle-opponent"], [55063751, "gameciel-tribute-controller"]] as const) {
      for (const format of ["ffa3", "ffa4", "tag"]) {
        expect(LIVE_PROOF[code]).toContain(`p3-catalog-${format}-${slug}`);
        expect(LIVE_PROOF[code]).toContain(`p3-catalog-${format}-${slug}-domain`);
      }
    }
  });

  it("keeps Creature Swap legal and states the FFA rotation and Tag swap", () => {
    const row = SCENARIOS.find((scenario) => scenario.code === 31036355)!;
    expect(row.group).toBe("all");
    expect(row.forbidden).not.toBe(true);
    expect(row.binding).toBeUndefined();
    expect(row.formats).toEqual(["ffa3", "ffa4", "tag"]);
    expect(row.rules).toContain("R-COMMON-EACH-PLAYER");
    expect(row.rules).toContain("R-FFA-RESOURCE-ROTATION");
    expect(row.rules).not.toContain("R-FFA-OPP-ONE");
    expect(row.results.ffa3).toMatch(/next living seat/);
    expect(row.results.tag).toMatch(/swap control/);
    expect(FORBIDDEN_EVIDENCE[31036355]).toBeUndefined();
    expect(MULTIPLAYER_FORBIDDEN.some((entry) => entry.code === 31036355)).toBe(false);
  });

  it("names every one-opponent catalog row with the current group", () => {
    for (const row of GROUP_ONE) expect(row.id).toBe(`mp-one-${row.code}`);
  });

  it("uses only passcodes that exist in cards.cdb and have an official or retained prerelease script", () => {
    const codes = [
      ...SCENARIOS.map((scenario) => scenario.code),
      ...MULTIPLAYER_FORBIDDEN.map((entry) => entry.code),
      ...MULTIPLAYER_CARD_RULES.map((entry) => entry.code),
    ];
    const bad = codes.filter((code) => cardName(code) === undefined || !hasScript(code));
    expect(bad).toEqual([]);
  });

  it("uses the name in cards.cdb for every card", () => {
    const wrong: string[] = [];
    for (const item of [...SCENARIOS.map((s) => ({ code: s.code, name: s.card })), ...MULTIPLAYER_FORBIDDEN, ...MULTIPLAYER_CARD_RULES]) {
      if (cardName(item.code) !== item.name) wrong.push(`${item.code}: ${item.name} vs ${cardName(item.code)}`);
    }
    expect(wrong).toEqual([]);
  });

  it("has no duplicate card inside a group", () => {
    expect(dup(GROUP_ALL.map((s) => s.code))).toEqual([]);
    expect(dup(GROUP_ONE.map((s) => s.code))).toEqual([]);
    expect(dup(MULTIPLAYER_FORBIDDEN.map((e) => e.code))).toEqual([]);
    expect(dup(MULTIPLAYER_CARD_RULES.map((e) => e.code))).toEqual([]);
    expect(dup(SCENARIOS.map((s) => s.id))).toEqual([]);
    expect(dup(SCENARIOS.map((s) => s.code))).toEqual([]);
  });

  it("puts every card in at most one of the forbidden list and the rule list", () => {
    const forbidden = new Set(MULTIPLAYER_FORBIDDEN.map((entry) => entry.code));
    expect(MULTIPLAYER_CARD_RULES.filter((entry) => forbidden.has(entry.code)).map((entry) => entry.name)).toEqual([]);
  });

  it("forbids the 17 'you win' cards in every format (owner decision 2026-10-01)", () => {
    const winCards = [
      37984331, 42776960, 13893596, 10000040, 15862758, 5008836, 53334641, 6165656, 66765023,
      69553552, 77751766, 8062132, 81171949, 94212438, 96637156, 97795930, 48995978,
    ];
    for (const code of winCards) {
      const entry = MULTIPLAYER_FORBIDDEN.find((item) => item.code === code);
      expect(entry?.category, String(code)).toBe("alt-win");
      expect(entry?.formats, String(code)).toEqual(["ffa3", "ffa4", "tag"]);
    }
    // Every script that calls Duel.Win is on the forbidden list, so none is left open.
    const withWin = readdirSync(join(scripts, "official"))
      .filter((file) => /^c\d+\.lua$/.test(file) && readFileSync(join(scripts, "official", file), "utf8").includes("Duel.Win("))
      .map((file) => Number(file.slice(1, -4)));
    const forbidden = new Set(MULTIPLAYER_FORBIDDEN.map((entry) => entry.code));
    expect(withWin.filter((code) => !forbidden.has(code))).toEqual([]);
  });

  it("forbids Convulsion of Nature in every multiplayer format with Deck reverse evidence", () => {
    const entry = MULTIPLAYER_FORBIDDEN.find((item) => item.code === 62966332);
    expect(entry?.name).toBe("Convulsion of Nature");
    expect(entry?.category).toBe("symmetry");
    expect(entry?.formats).toEqual(["ffa3", "ffa4", "tag"]);
    expect(FORBIDDEN_EVIDENCE[62966332]).toEqual([
      { file: "official/c62966332.lua", line: 5, token: "GLOBALFLAG_DECK_REVERSE_CHECK" },
      { file: "official/c62966332.lua", line: 14, token: "EFFECT_REVERSE_DECK" },
      { file: "official/c62966332.lua", line: 17, token: "SetTargetRange(1,1)" },
    ]);
  });

  it("gives every Kaiju and Lava procedure card the same rule (Tribute goes to the field of the Tributed monster)", () => {
    const files = readdirSync(join(scripts, "official")).filter((file) => /^c\d+\.lua$/.test(file));
    const withProcedure = files
      .filter((file) => /aux\.Add(Kaiju|Lava)Procedure/.test(readFileSync(join(scripts, "official", file), "utf8")))
      .map((file) => Number(file.slice(1, -4)));
    expect(withProcedure.length).toBeGreaterThanOrEqual(12);
    const ruled = new Map(MULTIPLAYER_CARD_RULES.map((entry) => [entry.code, entry]));
    expect(withProcedure.filter((code) => !ruled.has(code))).toEqual([]);
    for (const code of withProcedure) expect(ruled.get(code)?.rule, String(code)).toMatch(/field of the player whose monster was Tributed/);
  });

  it("gives every card that Special Summons to the field of an opponent a rule (the summoning player picks one opponent)", () => {
    const files = readdirSync(join(scripts, "official")).filter((file) => /^c\d+\.lua$/.test(file));
    const found = files
      .filter((file) => {
        const text = readFileSync(join(scripts, "official", file), "utf8");
        // An effect with Special Summon sumplayer tp, target player 1-tp, or a Special Summon procedure with target range (position,1).
        return /SpecialSummon(Step)?\([^\n]*,\s*tp\s*,\s*1-tp\s*,/.test(text) || /SetTargetRange\(\s*POS_[A-Z_+]*\s*,\s*1\s*\)/.test(text);
      })
      .map((file) => Number(file.slice(1, -4)));
    expect(found.length).toBeGreaterThanOrEqual(100);
    const covered = new Set([...MULTIPLAYER_FORBIDDEN, ...MULTIPLAYER_CARD_RULES].map((entry) => entry.code));
    expect(found.filter((code) => !covered.has(code))).toEqual([]);
    const ruled = new Map(MULTIPLAYER_CARD_RULES.map((entry) => [entry.code, entry]));
    for (const code of [64203620, 91697229, 75732622]) expect(ruled.get(code)?.rule, String(code)).toMatch(/picks one opponent/);
  });

  it("decides the count rules (Pineapple Blast, Evenly Matched) and Royal Tribute", () => {
    const rule = (code: number) => MULTIPLAYER_CARD_RULES.find((entry) => entry.code === code)?.rule ?? "";
    for (const code of [90669991, 15693423]) {
      expect(rule(code), String(code)).toMatch(/pick one opponent/);
      expect(rule(code), String(code)).toMatch(/fields of the two opposing members are joined/);
      expect(SCENARIOS.find((scenario) => scenario.code === code)?.group, String(code)).toBe("one");
    }
    expect(rule(72405967)).toMatch(/every duelist, the partner included/);
  });

  it("states the rule of every card and marks it native only with live proof", () => {
    for (const entry of MULTIPLAYER_CARD_RULES) {
      expect(entry.rule.trim().length, entry.name).toBeGreaterThan(20);
      expect(entry.engine, entry.name).toBe(entry.proven.length > 0 ? "native" : "pending");
      expect([...entry.proven], entry.name).toEqual((["ffa3", "ffa4", "tag"] as const).filter((format) => entry.proven.includes(format)));
    }
    expect(Object.keys(CARD_RULE_PROOF).map(Number).filter((code) => !MULTIPLAYER_CARD_RULES.some((entry) => entry.code === code))).toEqual([]);
  });

  it("states the Ra rule: all Tributes come from one opponent, and the card goes to that field", () => {
    const ra = MULTIPLAYER_CARD_RULES.find((entry) => entry.code === 10000080);
    expect(ra?.rule).toMatch(/ONE opponent/);
    expect(ra?.rule).toMatch(/field of that opponent/);
    expect(ra?.rule).not.toMatch(/picks one opponent when they summon/);
  });

  it("states what happens to a Kaiju when the bound opponent is eliminated: no summon, it stays in hand", () => {
    const kaiju = MULTIPLAYER_CARD_RULES.filter((item) => /Kaiju$/.test(item.name) && item.rule.includes("Tributed"));
    expect(kaiju.length).toBe(7);
    for (const entry of kaiju) {
      expect(entry.rule, entry.name).toMatch(/eliminated before the summon is done, the card is not summoned and stays in your hand/);
    }
  });

  it("decides Mystic Mine, Numeron Dragon, Ultimate Sky and Dice Jar", () => {
    const rule = (code: number) => MULTIPLAYER_CARD_RULES.find((entry) => entry.code === code)?.rule ?? "";
    expect(rule(76375976)).toMatch(/alone controls more monsters than you/);
    expect(rule(57314798)).toMatch(/direct attack goes at YOU/);
    expect(rule(38817295)).toMatch(/pick one opponent/);
    expect(rule(3549275)).toMatch(/one opponent, picked when it flips, each roll a die/);
  });

  it("gives every sketch all fields (the sketch data stays pending, LIVE_PROOF says which cards have live proof)", () => {
    for (const scenario of SCENARIOS) {
      expect(scenario.pending, scenario.id).toBe(true);
      for (const field of ["setup", "action", "expected", "oneVsOne"] as const) {
        expect(scenario[field].trim(), `${scenario.id} ${field}`).not.toBe("");
      }
      for (const format of ["ffa3", "ffa4", "tag"] as const) {
        expect(scenario.results[format].trim(), `${scenario.id} ${format}`).not.toBe("");
      }
      expect(scenario.evidence.length, scenario.id).toBeGreaterThan(0);
    }
  });

  it("tags every scenario with known ADR-0002 rule ids", () => {
    const adr = readFileSync(join(__dirname, "../../../../../docs/adr/0002-multiplayer-duel-rules.md"), "utf8");
    const known = new Set(parseAdrRules(adr).map((rule) => rule.id));
    expect(known.size).toBeGreaterThan(0);
    const bad: string[] = [];
    for (const scenario of SCENARIOS) {
      if (scenario.rules.length === 0) bad.push(`${scenario.id}: no rules`);
      for (const rule of scenario.rules) if (!known.has(rule)) bad.push(`${scenario.id}: unknown rule ${rule}`);
    }
    expect(bad).toEqual([]);
  });

  it("gives every group (b) card a binding source", () => {
    for (const scenario of GROUP_ONE) expect(scenario.binding, scenario.id).toBeDefined();
  });

  it("cites only script lines that exist and contain the cited token", () => {
    const problems = [
      ...SCENARIOS.flatMap((scenario) => evidenceProblems(scenario.evidence).map((p) => `${scenario.card}: ${p}`)),
      ...Object.entries(FORBIDDEN_EVIDENCE).flatMap(([code, list]) =>
        evidenceProblems(list).map((p) => `${cardName(Number(code))}: ${p}`),
      ),
      ...Object.entries(CARD_RULE_EVIDENCE).flatMap(([code, list]) =>
        evidenceProblems(list).map((p) => `${cardName(Number(code))}: ${p}`),
      ),
    ];
    expect(problems).toEqual([]);
  });

  it("keeps the core's resolution picker summary aligned with the reviewed Lua helper", () => {
    const helper = linesOf("overlay/mp-utility.lua");
    const start = helper.findIndex((line) => line === "function aux.MPChooseOpponent(tp)");
    const finish = helper.findIndex((line, index) => index > start && line === "end");
    const patch = readFileSync(join(overlay, "../patches/0100-resolution-opponent-decisions.patch"), "utf8");
    const summary = patch.slice(patch.indexOf("inline bool resolution_opponent_picker"));
    const span = summary.match(/p->linedefined==(\d+) && p->lastlinedefined==(\d+)/);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(span).not.toBeNull();
    expect([start + 1, finish + 1]).toEqual(span!.slice(1).map(Number));
  });

  it("cites only scripts of the card itself for the card-owned evidence", () => {
    const wrong = SCENARIOS.flatMap((s) =>
      s.evidence.filter((item) => item.file.startsWith("official/") && item.file !== `official/c${s.code}.lua`).map(() => s.card),
    );
    expect(wrong).toEqual([]);
  });

  it("has evidence for every forbidden card and every rule card", () => {
    expect(MULTIPLAYER_FORBIDDEN.filter((e) => !(FORBIDDEN_EVIDENCE[e.code]?.length)).map((e) => e.name)).toEqual([]);
    expect(MULTIPLAYER_CARD_RULES.filter((e) => !(CARD_RULE_EVIDENCE[e.code]?.length)).map((e) => e.name)).toEqual([]);
  });

  it("keeps the evidence keys inside the two lists", () => {
    const forbidden = new Set(MULTIPLAYER_FORBIDDEN.map((e) => e.code));
    const ruled = new Set(MULTIPLAYER_CARD_RULES.map((e) => e.code));
    expect(Object.keys(FORBIDDEN_EVIDENCE).map(Number).filter((c) => !forbidden.has(c))).toEqual([]);
    expect(Object.keys(CARD_RULE_EVIDENCE).map(Number).filter((c) => !ruled.has(c))).toEqual([]);
  });

  it("agrees that cards marked forbidden in a scenario are on the forbidden list", () => {
    const forbidden = new Set(MULTIPLAYER_FORBIDDEN.map((e) => e.code));
    for (const scenario of SCENARIOS.filter((s) => s.forbidden)) expect(forbidden.has(scenario.code), scenario.card).toBe(true);
  });

  describe("live proof", () => {
    it("names only live scenarios that exist, for cards of the catalog or the rule list", async () => {
      const byId = await formatOf();
      const known = new Set([...SCENARIOS.map((s) => s.code), ...MULTIPLAYER_CARD_RULES.map((e) => e.code)]);
      const problems: string[] = [];
      for (const [code, ids] of Object.entries(LIVE_PROOF)) {
        if (!known.has(Number(code))) problems.push(`${code} is in neither the catalog nor the rule list`);
        if (dup([...ids]).length > 0) problems.push(`${code} names a scenario twice`);
        for (const id of ids) {
          const format = byId.get(id);
          if (format === undefined) problems.push(`${code}: no live scenario ${id}`);
          else if (format === "1v1") problems.push(`${code}: ${id} is a 1v1 scenario`);
        }
      }
      expect(problems).toEqual([]);
    });

    it("keeps CARD_RULE_PROOF equal to the formats of the live scenarios of each rule card", async () => {
      const byId = await formatOf();
      const wrong: string[] = [];
      for (const entry of MULTIPLAYER_CARD_RULES) {
        const formats = new Set((LIVE_PROOF[entry.code] ?? []).map((id) => byId.get(id)));
        const derived = (["ffa3", "ffa4", "tag"] as const).filter((format) => formats.has(format));
        if (derived.join() !== entry.proven.join()) wrong.push(`${entry.name}: live ${derived.join("+") || "none"}, list ${entry.proven.join("+") || "none"}`);
      }
      expect(wrong).toEqual([]);
    });
  });

  describe("sketch scenarios", () => {
    for (const scenario of SCENARIOS as CatalogScenario[]) {
      const ids = LIVE_PROOF[scenario.code] ?? [];
      if (ids.length === 0) {
        it.todo(`${scenario.id}: ${scenario.card} (${scenario.formats.join(", ")})`);
        continue;
      }
      it(`${scenario.id}: ${scenario.card} has live proof (${ids.length} scenarios)`, async () => {
        const byId = await formatOf();
        const formats = ids.map((id) => byId.get(id));
        expect(formats.filter((format) => format === undefined)).toEqual([]);
        // A proven table is one of the tables of the sketch.
        for (const format of formats) expect(scenario.formats as string[], `${scenario.card}: ${format}`).toContain(format);
      });
    }
  });
});
