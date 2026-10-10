import { expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { execFileSync } from "node:child_process";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { summarizeCard, renderSmokeMarkdown, runSmokePool, smokeCasesForCard, smokeIsSetCard, smokeMissingEffect, smokeRetryParent, smokeRetrySeed } from "../scripts/lib/new-card-smoke-pool.js";
import { loadCardDatabase } from "../src/cards.js";
import { resolveCard } from "../src/presets/catalog.js";
import { smokeExitCode } from "../scripts/new-card-smoke.js";
import { itWithCores, needs } from "./support/cores.js";

it("reports missing activations as WARN and script errors as FAIL, with replay seeds", () => {
  const card = { code: 42, name: "Needs | conditions", type: 33, description: "You can draw 1 card." };
  const test = { id: "normal/1v1/grave", seed: 7, steps: 3, offered: [], activated: [], replayed: true, expected: [{ id: "effect", label: "Draw" }] };
  expect(summarizeCard(card, [test]).status).toBe("WARN");
  expect(summarizeCard(card, [{ ...test, offered: ["effect"] }]).status).toBe("WARN");
  expect(summarizeCard(card, [{ ...test, offered: ["effect"], activated: ["effect"] }]).status).toBe("PASS");
  expect(summarizeCard(card, [{ ...test, failure: "Lua script error" }]).status).toBe("FAIL");
  expect(renderSmokeMarkdown({ cards: [summarizeCard(card, [test])], durationMs: 12, jobs: 2, bundleVersion: "pin" })).toContain("Needs \\| conditions");
  expect(renderSmokeMarkdown({ cards: [summarizeCard(card, [test])], durationMs: 12, jobs: 2, bundleVersion: "pin" })).toContain("7");
});
it("does not give a card with no completed cases a PASS", () => {
  expect(summarizeCard({ code: 42, name: "Normal", type: 17, description: "Flavor text." }, []).status).toBe("FAIL");
});
it("chooses a fresh setup seed while preserving the requested branch variant", () => {
  expect(smokeRetrySeed(42, 43, new Set([44]), 0, 2)).toBe(46);
  expect(smokeRetrySeed(42, 43, new Set([43, 44]))).toBe(45);
});
it("retries using the combined inventory when another setup discovers a missing branch", () => {
  const common = { seed: 1, steps: 3, offered: [], replayed: true };
  const first = { ...common, id: "normal/1v1/hand", expected: [{ id: "effect", label: "Activation" }], activated: ["effect"] };
  const later = { ...common, id: "domain/1v1/field", expected: [...first.expected, { id: "branch", label: "Set it", parent: "effect" }], activated: ["effect", "branch"] };
  expect(summarizeCard({ code: 42, type: 33, description: "" }, [first, later]).status).toBe("WARN");
  expect(smokeMissingEffect([first, later], first)).toBe("branch");
  expect(smokeMissingEffect([first, later], later)).toBeUndefined();
});
it("retries a merged missing branch in the setup that discovered it", () => {
  const common = { seed: 1, steps: 3, offered: [], replayed: true };
  const root = { id: "effect", label: "Banished ignition" };
  const hand = { ...common, id: "normal/1v1/hand", expected: [root], activated: [] };
  const banished = { ...common, id: "normal/1v1/banished", expected: [root,
    { id: "mode:effect:A", label: "A", parent: "effect" }, { id: "mode:effect:B", label: "B", parent: "effect" }],
    activated: ["effect", "mode:effect:A"] };
  expect(smokeRetryParent([hand, banished])?.id).toBe(banished.id);
});
it("does not retry text-only printed branches that can never resolve", () => {
  const description = "Choose an effect;\n● Draw 1 card.\n● Destroy 1 card.";
  const test = { id: "normal/1v1/hand", seed: 1, steps: 3, offered: [], replayed: true,
    expected: [{ id: "effect", label: "Choose an effect" }], activated: ["effect"] };
  expect(summarizeCard({ code: 42, type: 33, description }, [test]).status).toBe("WARN");
  expect(smokeMissingEffect([test], test, description)).toBeUndefined();
  expect(smokeRetryParent([test], description)).toBeUndefined();
  const unresolved = { ...test, activated: [] };
  expect(smokeMissingEffect([unresolved], unresolved, description)).toBe("effect");
  expect(smokeRetryParent([unresolved], description)?.id).toBe(test.id);
});
it("prioritizes FAIL over incompleteness and gives incomplete-only reports code 3", () => {
  const report = { cards: [], durationMs: 0, jobs: 1, bundleVersion: "test", incomplete: true };
  const failure = summarizeCard({ code: 42, type: 17, description: "" }, []);
  expect(smokeExitCode({ ...report, cards: [failure] })).toBe(1);
  expect(renderSmokeMarkdown({ ...report, cards: [failure] })).toContain("Exit 1");
  expect(smokeExitCode(report)).toBe(3);
  expect(smokeExitCode({ ...report, incomplete: false })).toBe(0);
  expect(renderSmokeMarkdown(report)).toContain("Exit 3");
});
it("classifies Dark Time Wizard by its known inventory, independent of coin guesses", () => {
  const card = { code: 40235813, type: 97, description: "Toss a coin and call it." };
  const expected = [{ id: "activate", label: "Activate" },
    { id: "heads-outcome", label: "Heads outcome", parent: "activate" }, { id: "tails-outcome", label: "Tails outcome", parent: "activate" }];
  const test = { id: "normal/1v1/field", seed: 1, steps: 3, expected, replayed: true,
    offered: ["mode:40235813:opt:0:Heads", "mode:40235813:opt:1:Tails"], activated: expected.map(e => e.id) };
  expect(summarizeCard(card, [test]).status).toBe("PASS");
  expect(summarizeCard(card, [{ ...test, activated: ["activate", "heads-outcome"] }]).status).toBe("WARN");
});
itWithCores("counts Medius's two printed branches even when neither is legal at runtime", [needs.cards()], () => {
  const cards = loadCardDatabase(process.env.DUEL_DATA_DIR!), card = cards.get(90875418)!;
  const expected = [{ id: "ignition", label: "Special Summon" }, { id: "trigger", label: "If a monster is banished" }];
  const result = summarizeCard({ ...card, type: cards.cardData(card.code)!.type }, [{ id: "normal/1v1/hand", seed: 1, steps: 3,
    expected, offered: [], activated: expected.map(e => e.id), replayed: true }]);
  expect(result.status).toBe("WARN");
  expect(result.reason).toContain("2 of 4");
  expect(result.reason).toContain("card-text branch");
});
it("warns about a registered effect which never becomes selectable, with k of n coverage", () => {
  const card = { code: 42, type: 33, description: "Two effects." };
  const test = { id: "normal/1v1/hand", seed: 7, steps: 3, offered: ["draw"], activated: ["draw"], replayed: true,
    expected: [{ id: "draw", label: "Draw" }, { id: "unreachable", label: "Unreachable trigger" }] };
  const result = summarizeCard(card, [test]);
  expect(result.status).toBe("WARN");
  expect(result.reason).toContain("1 of 2");
  expect(result.reason).toContain("Unreachable trigger");
  expect(summarizeCard(card, [{ ...test, activated: ["draw", "unreachable"] }]).status).toBe("PASS");
});
it("keeps offered-effect coverage separate for each core and format", () => {
  const card = { code: 42, type: 33, description: "Two effects." };
  const test = { seed: 7, steps: 3, offered: ["a", "b"], replayed: true };
  expect(summarizeCard(card, [{ ...test, id: "normal/1v1/hand", activated: ["a"] },
    { ...test, id: "domain/1v1/hand", activated: ["b"] }]).status).toBe("WARN");
});
it("rejects timeouts that Node would clamp to one millisecond", async () => {
  await expect(runSmokePool([], ".", { timeoutMs: 2147483648 })).rejects.toThrow(/timer/);
  await expect(runSmokePool([], ".", { cardTimeoutMs: 1000000000, multiCards: [42] })).rejects.toThrow(/timer/);
});
it("uses IsSetCard base and sub-archetype membership", () => {
  expect(smokeIsSetCard(0x3008, 0x8)).toBe(true);
  expect(smokeIsSetCard(0x1008, 0x1008)).toBe(true);
  expect(smokeIsSetCard(0x3008, 0x1008)).toBe(true);
  expect(smokeIsSetCard(0x2008, 0x1008)).toBe(false);
  expect(smokeIsSetCard(0x8, 0x1008)).toBe(false);
  expect(smokeIsSetCard(0x1009, 0x1008)).toBe(false);
});
itWithCores("uses bounded real workers and retains results in input order", [needs.standard(), needs.domain(), needs.cards()], async () => {
  const report = await runSmokePool([55144522, 5318639, 8842266], process.env.DUEL_DATA_DIR!, { jobs: 2, limits: { maxSteps: 100, maxTurns: 2 } });
  expect(report.cards.map(c => c.code)).toEqual([55144522, 5318639, 8842266]);
  expect(report.cards.every(c => c.status !== "FAIL")).toBe(true);
  expect(report.peakWorkers).toBe(2);
  expect(report.configuration!.caseTimeoutMs).toBe(30000);
}, 30000);
itWithCores("stops synchronous Lua loops and starts a fresh worker for the next card", [needs.standard(), needs.domain(), needs.cards()], async () => {
  const directory = process.env.DUEL_DATA_DIR!, root = await mkdtemp(join(tmpdir(), "smoke-watchdog-"));
  try {
    for (const file of ["cards.cdb", "strings.conf", "card-remaps.json", "manifest.json", "ocgcore.standard.wasm", "ocgcore.domain.wasm"]) await cp(join(directory, file), join(root, file));
    execFileSync("cp", ["-al", join(directory, "card-scripts"), join(root, "card-scripts")]);
    const code = 99999992, db = new Database(join(root, "cards.cdb"));
    db.exec(`INSERT INTO datas SELECT ${code}, ot, alias, setcode, type, atk, def, level, race, attribute, category FROM datas WHERE id=55144522`);
    db.exec(`INSERT INTO texts SELECT ${code}, 'Loop smoke card', 'Draw a card.', str1,str2,str3,str4,str5,str6,str7,str8,str9,str10,str11,str12,str13,str14,str15,str16 FROM texts WHERE id=55144522`); db.close();
    await writeFile(join(root, "card-scripts", `c${code}.lua`), `local s,id=GetID()
function s.initial_effect(c)
local e=Effect.CreateEffect(c); e:SetType(EFFECT_TYPE_ACTIVATE); e:SetCode(EVENT_FREE_CHAIN)
e:SetOperation(function() while true do end end); c:RegisterEffect(e)
end`);
    const completionOrder: number[] = [];
    const report = await runSmokePool([code, 55144522], root, { jobs: 1, timeoutMs: 700, cardTimeoutMs: 6000,
      onCard: card => completionOrder.push(card.code), limits: { maxSteps: 100, maxTurns: 2 } });
    expect(report.cards[0]?.status).toBe("FAIL"); expect(report.cards[0]?.reason).toContain("time limit");
    expect(report.cards[0]?.cases.some(c => c.timeoutRetried)).toBe(true);
    expect(report.timeoutRetries).toBe(1);
    expect(completionOrder).toEqual([55144522, code]);
    expect(report.cards[1]?.status).toBe("PASS");
    const exact = await runSmokePool([code], root, { jobs: 1, timeoutMs: 700, cardTimeoutMs: 6000,
      caseId: "normal/1v1/hand/branch-1", seed: 7, limits: { maxSteps: 100, maxTurns: 2 } });
    expect(exact.cards[0]?.reason).toContain("case time limit reached after isolated retry");
    expect(exact.cards[0]?.reason).not.toContain("Unknown recovery case");
  } finally { await rm(root, { recursive: true, force: true }); }
}, 30000);
itWithCores("fails an unconfirmed case timeout when the suite ends before its isolated retry", [needs.standard(), needs.cards()], async () => {
  const directory = process.env.DUEL_DATA_DIR!, root = await mkdtemp(join(tmpdir(), "smoke-watchdog-"));
  try {
    for (const file of ["cards.cdb", "strings.conf", "card-remaps.json", "manifest.json", "ocgcore.standard.wasm"]) await cp(join(directory, file), join(root, file));
    execFileSync("cp", ["-al", join(directory, "card-scripts"), join(root, "card-scripts")]);
    const code = 99999992, db = new Database(join(root, "cards.cdb"));
    db.exec(`INSERT INTO datas SELECT ${code}, ot, alias, setcode, type, atk, def, level, race, attribute, category FROM datas WHERE id=55144522`);
    db.exec(`INSERT INTO texts SELECT ${code}, 'Loop smoke card', 'Draw a card.', str1,str2,str3,str4,str5,str6,str7,str8,str9,str10,str11,str12,str13,str14,str15,str16 FROM texts WHERE id=55144522`); db.close();
    await writeFile(join(root, "card-scripts", `c${code}.lua`), `local s,id=GetID()
function s.initial_effect(c)
local e=Effect.CreateEffect(c); e:SetType(EFFECT_TYPE_ACTIVATE); e:SetCode(EVENT_FREE_CHAIN)
e:SetOperation(function() while true do end end); c:RegisterEffect(e)
end`);
    const now = performance.now.bind(performance);
    let elapsed = 0;
    const clock = vi.spyOn(performance, "now").mockImplementation(() => now() + elapsed);
    try {
      const exhausted = await runSmokePool([code, 55144522], root, { jobs: 1, timeoutMs: 700, cardTimeoutMs: 6000, suiteTimeoutMs: 10000, caseId: "normal/1v1/hand",
        onCard: card => { if (card.code === 55144522) elapsed = 10000; }, limits: { maxSteps: 100, maxTurns: 2 } });
      expect(exhausted.timeoutRetries).toBe(0);
      expect(exhausted.incomplete).toBe(true);
      expect(exhausted.cards[0]?.status).toBe("FAIL");
      expect(exhausted.cards[0]?.reason).toContain("case timeout not confirmed");
      expect(exhausted.cards[0]?.cases.some(c => c.failure === "case timeout not confirmed")).toBe(true);
      expect(renderSmokeMarkdown(exhausted)).toContain("case timeout not confirmed");
      expect(smokeExitCode(exhausted)).toBe(1);
      elapsed = 0;
      const started = now();
      const interrupted = await runSmokePool([code, 55144522], root, { jobs: 1, timeoutMs: 700, cardTimeoutMs: 6000, suiteTimeoutMs: 10000,
        caseId: "normal/1v1/hand", onCard: card => { if (card.code === 55144522) elapsed = 9850 - (now() - started); },
        limits: { maxSteps: 100, maxTurns: 2 } });
      expect(interrupted.timeoutRetries).toBe(1);
      expect(interrupted.cards[0]?.reason).toContain("case timeout not confirmed");
      expect(interrupted.cards[0]?.cases.some(c => c.failure === "case timeout not confirmed" && c.timeoutRetried)).toBe(true);
      expect(smokeExitCode(interrupted)).toBe(1);
    } finally { clock.mockRestore(); }
  } finally { await rm(root, { recursive: true, force: true }); }
}, 30000);
itWithCores("keeps tokens out of decks and puts only monster companions in monster zones", [needs.cards()], () => {
  const directory = process.env.DUEL_DATA_DIR!, cards = loadCardDatabase(directory);
  for (const code of [3064783, 39053882, 41458361, 11895663]) for (const test of smokeCasesForCard(code, directory, ["1v1"])) {
    for (const seat of [test.board.p0!, test.board.p1!]) {
      for (const companion of seat.deck ?? []) if (typeof companion === "number") expect(cards.cardData(companion)!.type & 0x4000).toBe(0);
      for (const monster of seat.monsters ?? []) if (typeof monster === "number") expect(cards.cardData(monster)!.type & 1).toBe(1);
    }
  }
});
itWithCores("places the named Umi support face-up in the Field Zone", [needs.cards()], () => {
  const directory = process.env.DUEL_DATA_DIR!, cards = loadCardDatabase(directory);
  const test = smokeCasesForCard(76660178, directory, ["1v1"])[0]!;
  const field = test.board.p0!.field as { card: number; pos: string };
  expect(field).toBeDefined(); expect(field.pos).toBe("up");
  expect(cards.get(field.card)!.name).toBe("Umi");
  expect(cards.cardData(field.card)!.type & 0x80000).toBeTruthy();
});
itWithCores("reports a suite deadline as incomplete without failing untested cards", [needs.standard(), needs.domain(), needs.cards()], async () => {
  const report = await runSmokePool([55144522, 5318639], process.env.DUEL_DATA_DIR!, { jobs: 1, suiteTimeoutMs: 1 });
  expect(report.incomplete).toBe(true);
  expect(report.incompleteCodes).toContain(5318639);
  expect(report.cards.some(c => c.status === "FAIL")).toBe(false);
  expect(smokeExitCode(report)).toBe(3);
});
itWithCores("reports an aggregate card budget as incomplete, while continuing the pool", [needs.standard(), needs.domain(), needs.cards()], async () => {
  const report = await runSmokePool([55144522, 5318639], process.env.DUEL_DATA_DIR!, { jobs: 1, cardTimeoutMs: 1 });
  expect(report.incomplete).toBe(true);
  expect(report.incompleteCodes).toEqual([5318639, 55144522]);
  expect(report.cards.some(c => c.status === "FAIL")).toBe(false);
  expect(smokeExitCode(report)).toBe(3);
});
itWithCores("gives Endgame Problem five real Angelechy Monster Cards and Seneschal legal Synchro materials", [needs.cards()], () => {
  const directory = process.env.DUEL_DATA_DIR!, cards = loadCardDatabase(directory);
  const threshold = smokeCasesForCard(101402095, directory, ["1v1"]).find(test => test.location === "spell-support")!;
  expect(threshold.board.p0!.spells).toHaveLength(5);
  for (const entry of threshold.board.p0!.spells!) expect(cards.get((entry as { card: number }).card)!.name.startsWith("Angelechy")).toBe(true);
  const summon = smokeCasesForCard(101402091, directory, ["1v1"]).find(test => test.location === "extra")!;
  expect(summon.board.p0!.monsters).toEqual([null, "Junk Synchron", expect.any(Number)]);
  expect(cards.cardData(summon.board.p0!.monsters![2] as number)!.level).toBe(7);
});
itWithCores("provides diverse GY, zero ATK, varied Extra Deck, named archetypes, types, mentions, and another copy", [needs.cards()], () => {
  const directory = process.env.DUEL_DATA_DIR!, cards = loadCardDatabase(directory);
  const setup = (code: number) => smokeCasesForCard(code, directory, ["1v1"])[0]!.board.p0!;
  const doriado = setup(50208444);
  const data = (ref: unknown) => cards.cardData(resolveCard(typeof ref === "object" ? (ref as { card: number }).card : ref as string | number, directory))!;
  const gy = doriado.grave!.map(data);
  expect(new Set(gy.filter(c => c.type & 1).map(c => c.attribute)).size).toBeGreaterThanOrEqual(3);
  const garbage = setup(28968609);
  expect(garbage.monsters!.filter(Boolean).some(ref => data(ref).attack === 0)).toBe(true);
  for (const mask of [0x40, 0x2000, 0x800000, 0x4000000]) expect(garbage.extra!.filter(ref => data(ref).type & mask).length).toBeGreaterThan(1);
  expect(new Set(garbage.extra!.filter(ref => data(ref).type & 0x800000).map(ref => data(ref).level)).size).toBeGreaterThanOrEqual(3);
  const dino = setup(3841104);
  expect(dino.monsters!.filter(ref => typeof ref === "number" && data(ref).race & 0x10000n).length).toBeGreaterThanOrEqual(2);
  expect(dino.extra!.some(ref => typeof ref === "number" && (data(ref).type & 0x40) && (data(ref).race & 0x10000n))).toBe(true);
  const invocation = setup(76334960);
  expect(invocation.grave!.some(ref => typeof ref === "number" && cards.get(ref)!.name.includes("Aleister"))).toBe(true);
  expect(invocation.extra!.some(ref => typeof ref === "number" && cards.get(ref)!.name.startsWith("Invoked"))).toBe(true);
  const atlantis = setup(65785782);
  expect(atlantis.deck!.some(ref => typeof ref === "number" && (data(ref).type & 1) && /CARD_ATLANTIS_CITY_OF_THE_SEA_DRAGON/.test(cards.readScript(`c${ref}.lua`) ?? ""))).toBe(true);
  expect(setup(101402089).deck).toContain(101402089);
  expect(setup(4881365).deck!.some(ref => typeof ref === "number" && (data(ref).type & (2 | 4)) && /CARD_DARK_TIME_WIZARD/.test(cards.readScript(`c${ref}.lua`) ?? ""))).toBe(true);
  for (const mask of [0x40, 0x2000, 0x800000, 0x4000000]) expect(garbage.grave!.some(ref => data(ref).type & mask)).toBe(true);
  const master = setup(54641720).monsters!.find(ref => typeof ref === "number");
  expect(cards.get(master as number)!.name).toBe("Destiny HERO - Dreadmaster");
  expect(setup(3441553).hand!.some(ref => typeof ref === "number" && cards.get(ref)!.name.includes("Uria"))).toBe(true);
});
