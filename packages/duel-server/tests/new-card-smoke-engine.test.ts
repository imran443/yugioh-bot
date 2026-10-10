import { execFileSync } from "node:child_process";
import Database from "better-sqlite3";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterAll, expect } from "vitest";
import { makeSmokeCases } from "../scripts/lib/new-card-smoke-board.js";
import { compileBoard } from "../src/presets/board.js";
import { compileSmokeCase, runSmokeCase } from "../scripts/lib/new-card-smoke-runner.js";
import { createEngineGame } from "../src/engine.js";
import { smokeCasesForCard } from "../scripts/lib/new-card-smoke-pool.js";
import { summarizeCard } from "../scripts/lib/new-card-smoke-pool.js";
import { loadCardDatabase } from "../src/cards.js";
import { engineSeed } from "./fuzz/rng.js";
import { defaultAnswer } from "../src/scripted-bot.js";
import { InvariantChecker } from "./fuzz/invariants.js";
import { loadCatalog } from "./fuzz/card-pool.js";
import { itWithCores, needs } from "./support/cores.js";

const directory = process.env.DUEL_DATA_DIR!;
const roots: string[] = [];
itWithCores("warns when Ignition resolves but a mandatory FLIP effect never flips", [needs.standard(), needs.cards()], async () => {
  const root = await mkdtemp(join(tmpdir(), "new-card-flip-")); roots.push(root);
  for (const file of ["cards.cdb", "strings.conf", "ocgcore.standard.wasm"]) await cp(join(directory, file), join(root, file));
  execFileSync("cp", ["-al", join(directory, "card-scripts"), join(root, "card-scripts")]);
  const code = 99999989, db = new Database(join(root, "cards.cdb"));
  db.exec(`INSERT INTO datas SELECT ${code}, ot, alias, setcode, 33, atk, def, level, race, attribute, category FROM datas WHERE id=15025844`);
  db.exec(`INSERT INTO texts SELECT ${code}, 'Unflipped smoke card', 'Two effects.', 'Ignition','FLIP',str3,str4,str5,str6,str7,str8,str9,str10,str11,str12,str13,str14,str15,str16 FROM texts WHERE id=15025844`); db.close();
  await writeFile(join(root, "card-scripts", `c${code}.lua`), `local s,id=GetID()
function s.initial_effect(c)
local e=Effect.CreateEffect(c); e:SetDescription(aux.Stringid(id,0)); e:SetType(EFFECT_TYPE_IGNITION); e:SetRange(LOCATION_MZONE); e:SetCountLimit(1)
e:SetOperation(function(e,tp) Duel.Draw(tp,1,REASON_EFFECT) end); c:RegisterEffect(e)
local f=Effect.CreateEffect(c); f:SetDescription(aux.Stringid(id,1)); f:SetType(EFFECT_TYPE_SINGLE|EFFECT_TYPE_FLIP)
f:SetOperation(function(e,tp) Duel.Draw(tp,1,REASON_EFFECT) end); c:RegisterEffect(f)
end`);
  const card = { code, type: 33, description: "Two effects." }, test = makeSmokeCases(card).find(t => t.id === "normal/1v1/field")!;
  test.board.p0!.hand = []; test.board.p0!.spells = []; test.board.p1!.hand = []; test.board.p1!.spells = [];
  const result = await runSmokeCase(test, root, { maxSteps: 150, maxTurns: 1 });
  expect(result.failure).toBeUndefined();
  expect(summarizeCard(card, [result]).status).toBe("WARN");
  expect(result.expected).toHaveLength(2);
  expect(result.expected!.find(e => e.label === "FLIP")!.type! & 0x20).toBe(0x20);
  expect(summarizeCard(card, [result]).reason).toContain("1 of 2");
});
itWithCores("retains an exact alternate-art passcode in a smoke board", [needs.cards()], () => {
  const compiled = compileBoard({ p0: { hand: [17242023] } }, directory);
  expect(compiled.options.startupScripts?.[0]?.content).toContain("Debug.AddCard(17242023,");
});
afterAll(async () => { for (const root of roots) await rm(root, { recursive: true, force: true }); });
itWithCores("does not credit a Continuous Trap destroyed in response, then retries in another setup", [needs.standard(), needs.cards()], async () => {
  const root = await mkdtemp(join(tmpdir(), "new-card-resolution-")); roots.push(root);
  for (const file of ["cards.cdb", "strings.conf", "ocgcore.standard.wasm"]) await cp(join(directory, file), join(root, file));
  execFileSync("cp", ["-al", join(directory, "card-scripts"), join(root, "card-scripts")]);
  const code = 99999994, db = new Database(join(root, "cards.cdb"));
  db.exec(`INSERT INTO datas SELECT ${code}, ot, alias, setcode, 131076, atk, def, level, race, attribute, category FROM datas WHERE id=83968380`);
  db.exec(`INSERT INTO texts SELECT ${code}, 'Resolution smoke trap', 'Draw a card.', str1,str2,str3,str4,str5,str6,str7,str8,str9,str10,str11,str12,str13,str14,str15,str16 FROM texts WHERE id=83968380`); db.close();
  await writeFile(join(root, "card-scripts", `c${code}.lua`), `local s,id=GetID()
function s.initial_effect(c)
local e=Effect.CreateEffect(c); e:SetType(EFFECT_TYPE_ACTIVATE); e:SetCode(EVENT_FREE_CHAIN)
e:SetOperation(function(e,tp) if not e:GetHandler():IsRelateToEffect(e) then return end Duel.Draw(tp,1,REASON_EFFECT) end)
c:RegisterEffect(e)
local e2=Effect.CreateEffect(c); e2:SetType(EFFECT_TYPE_IGNITION); e2:SetRange(LOCATION_SZONE)
e2:SetCondition(function() return false end); e2:SetOperation(function(e,tp) Duel.Draw(tp,1,REASON_EFFECT) end); c:RegisterEffect(e2)
end`);
  const card = { code, type: 131076, description: "Two effects." };
  const test = makeSmokeCases(card).find(c => c.id === "normal/1v1/set")!;
  test.seed = code;
  test.board.p0!.hand = []; test.board.p0!.spells = [{ card: code, pos: "set" }];
  test.board.p1!.hand = []; test.board.p1!.spells = [{ card: "Dust Tornado", pos: "set" }];
  const interrupted = await runSmokeCase(test, root, { maxSteps: 150, maxTurns: 2 });
  expect(interrupted.failure).toBeUndefined();
  expect(interrupted.expected).toHaveLength(2);
  expect(interrupted.activated).toEqual([]);
  test.board.p1!.spells = [];
  const completed = await runSmokeCase(test, root, { maxSteps: 150, maxTurns: 2 });
  expect(completed.failure).toBeUndefined();
  expect(completed.activated).toContain(completed.expected![0]!.id);
  expect(summarizeCard(card, [completed]).reason).toContain("1 of 2");
  expect(summarizeCard(card, [completed]).status).toBe("WARN");
});
itWithCores("gives ordinary Pendulum-monster spell placements the Continuous Spell type", [needs.standard(), needs.cards()], async () => {
  const cards = loadCardDatabase(directory), card = cards.get(14418464)!;
  const test = makeSmokeCases({ ...card, type: cards.cardData(card.code)!.type }).find(test => test.location === "field")!;
  test.board.p0!.monsters![0] = null;
  test.board.p0!.spells = [null, null, { card: card.code, pos: "up" }];
  test.board.p0!.pendulum = [card.code, null];
  const compiled = compileSmokeCase(test, directory);
  compiled.options.startupScripts![0]!.content += `\nassert(Duel.GetFieldCard(0,LOCATION_SZONE,2):GetType()==(TYPE_SPELL|TYPE_CONTINUOUS),'Continuous Spell type')
  assert(Duel.GetFieldCard(0,LOCATION_PZONE,0):IsType(TYPE_PENDULUM),'Pendulum Zone type')`;
  const game = await createEngineGame({ ...compiled.options, dataDirectory: directory, seed: engineSeed(test.seed) });
  try {
    const placed = game.view(0).seats[0]!.spells.find(c => c?.code === card.code)!;
    expect(placed.code).toBe(card.code);
  } finally { game.close(); }
  const pendulum = makeSmokeCases({ ...card, type: cards.cardData(card.code)!.type }).find(test => test.location === "pendulum")!;
  expect((await runSmokeCase(pendulum, directory, { maxSteps: 240, maxTurns: 2 })).failure).toBeUndefined();
});
itWithCores("offers Endgame Problem's five-card effect before support responses", [needs.standard(), needs.cards()], async () => {
  const test = smokeCasesForCard(101402095, directory, ["1v1"]).find(test => test.location === "spell-support")!;
  const game = await createEngineGame({ ...compileSmokeCase(test, directory).options, dataDirectory: directory, seed: engineSeed(test.seed) });
  try {
    for (let step = 0; step < 30 && game.view(0).prompt?.context?.type !== "action"; step++) {
      const views = [game.view(0), game.view(1)], seat = views.findIndex(view => view.prompt);
      const prompt = views[seat]!.prompt!;
      game.answer(seat, prompt.id, defaultAnswer(prompt).answer);
    }
    const opening = game.view(0);
    expect(opening.seats[0]!.spells.filter(c => c && c.sequence < 5)).toHaveLength(5);
    expect(opening.prompt?.options.some(o => o.card?.code === test.code && /Special Summon/i.test(o.effectText ?? ""))).toBe(true);
  } finally { game.close(); }
  const result = await runSmokeCase(test, directory, { maxSteps: 240, maxTurns: 2 });
  expect(result.failure).toBeUndefined();
  expect(result.activated.some(key => /Special Summon/i.test(key))).toBe(true);
});
itWithCores("activates a real effect and verifies every replay state", [needs.standard(), needs.cards()], async () => {
  const test = makeSmokeCases({ code: 55144522, type: 2, description: "Draw 2 cards." })[0]!;
  const result = await runSmokeCase(test, directory, { maxSteps: 100, maxTurns: 3 });
  expect(result.failure).toBeUndefined();
  expect(result.activated.length).toBeGreaterThan(0);
  expect(result.replayed).toBe(true);
  expect(result.steps).toBeGreaterThan(5);
});
itWithCores("checks card conservation after Xyz materials leave their placement state", [needs.standard(), needs.cards()], async () => {
  const test = makeSmokeCases({ code: 84013237, type: 0x800021, description: "Detach 1 material." }).find(c => c.id === "normal/1v1/extra")!;
  const result = await runSmokeCase(test, directory, { maxSteps: 140, maxTurns: 2 });
  expect(result.failure).toBeUndefined();
  expect(result.replayed).toBe(true);
});
itWithCores("records Seneschal's mandatory Synchro Summon trigger from the Extra Deck", [needs.standard(), needs.cards()], async () => {
  const test = smokeCasesForCard(101402091, directory, ["1v1"]).find(c => c.id === "normal/1v1/extra")!;
  const result = await runSmokeCase(test, directory, { maxSteps: 240, maxTurns: 2 });
  expect(result.failure).toBeUndefined();
  const trigger = result.expected?.find(e => /Special Summon/i.test(e.label));
  expect(trigger).toBeDefined();
  expect(result.activated).toContain(trigger!.id);
});
itWithCores("triggers Father Grizzly with a seeded opponent monster effect and records its banish-cost resolution", [needs.standard(), needs.cards()], async () => {
  const test = smokeCasesForCard(82970905, directory, ["1v1"]).find(c => c.id === "normal/1v1/grave")!;
  test.seed = test.code;
  const result = await runSmokeCase(test, directory, { maxSteps: 240, maxTurns: 3 });
  expect(result.failure).toBeUndefined();
  const quick = result.expected!.find(e => e.type === 0x100)!;
  expect(quick).toBeDefined();
  expect(result.activated).toContain(quick.id);
});
itWithCores("fails on an operation error which initial-effect registration cannot find", [needs.standard(), needs.cards()], async () => {
  const root = await mkdtemp(join(tmpdir(), "new-card-runtime-")); roots.push(root);
  for (const file of ["cards.cdb", "strings.conf", "ocgcore.standard.wasm"]) await cp(join(directory, file), join(root, file));
  execFileSync("cp", ["-al", join(directory, "card-scripts"), join(root, "card-scripts")]);
  const code = 99999991;
  const db = new Database(join(root, "cards.cdb"));
  db.exec(`INSERT INTO datas SELECT ${code}, ot, alias, setcode, type, atk, def, level, race, attribute, category FROM datas WHERE id=55144522`);
  db.exec(`INSERT INTO texts SELECT ${code}, 'Runtime smoke error', 'Draw 2 cards.', str1,str2,str3,str4,str5,str6,str7,str8,str9,str10,str11,str12,str13,str14,str15,str16 FROM texts WHERE id=55144522`);
  db.close();
  await writeFile(join(root, "card-scripts", `c${code}.lua`), `local s,id=GetID()
function s.initial_effect(c)
local e=Effect.CreateEffect(c); e:SetType(EFFECT_TYPE_ACTIVATE); e:SetCode(EVENT_FREE_CHAIN)
e:SetOperation(function() error('runtime smoke sentinel') end); c:RegisterEffect(e)
end`);
  const test = makeSmokeCases({ code, type: 2, description: "Draw 2 cards." })[0]!;
  const result = await runSmokeCase(test, root, { maxSteps: 60, maxTurns: 2 });
  expect(result.failure).toContain("runtime smoke sentinel");
  expect(result.failure).toContain("script");
});
itWithCores("exercises the second operation branch and preserves its replay seed", [needs.standard(), needs.cards()], async () => {
  const root = await mkdtemp(join(tmpdir(), "new-card-branch-")); roots.push(root);
  for (const file of ["cards.cdb", "strings.conf", "ocgcore.standard.wasm"]) await cp(join(directory, file), join(root, file));
  execFileSync("cp", ["-al", join(directory, "card-scripts"), join(root, "card-scripts")]);
  const code = 99999993, db = new Database(join(root, "cards.cdb"));
  db.exec(`INSERT INTO datas SELECT ${code}, ot, alias, setcode, type, atk, def, level, race, attribute, category FROM datas WHERE id=55144522`);
  db.exec(`INSERT INTO texts SELECT ${code}, 'Branch smoke error', 'Choose an effect.', str1,str2,str3,str4,str5,str6,str7,str8,str9,str10,str11,str12,str13,str14,str15,str16 FROM texts WHERE id=55144522`); db.close();
  await writeFile(join(root, "card-scripts", `c${code}.lua`), `local s,id=GetID()
function s.initial_effect(c)
local e=Effect.CreateEffect(c); e:SetType(EFFECT_TYPE_ACTIVATE); e:SetCode(EVENT_FREE_CHAIN)
e:SetOperation(function(e,tp)
Duel.Hint(HINT_CARD,0,id)
if Duel.SelectOption(tp,aux.Stringid(id,0),aux.Stringid(id,1))==1 then error('second branch sentinel') end
end); c:RegisterEffect(e)
end`);
  const test = makeSmokeCases({ code, type: 2, description: "Choose an effect." })[0]!;
  const first = await runSmokeCase(test, root, { maxSteps: 100, maxTurns: 2 });
  expect(first.failure).toBeUndefined(); expect(first.replayed).toBe(true);
  const second = await runSmokeCase({ ...test, seed: code + 1 }, root, { maxSteps: 100, maxTurns: 2 });
  expect(second.failure).toContain("second branch sentinel");
  expect(second.activated).toEqual([]);
});
itWithCores("warns when an effect's declared operation branch is never offered", [needs.standard(), needs.cards()], async () => {
  const root = await mkdtemp(join(tmpdir(), "new-card-unoffered-")); roots.push(root);
  for (const file of ["cards.cdb", "strings.conf", "ocgcore.standard.wasm"]) await cp(join(directory, file), join(root, file));
  execFileSync("cp", ["-al", join(directory, "card-scripts"), join(root, "card-scripts")]);
  const code = 99999995, db = new Database(join(root, "cards.cdb"));
  db.exec(`INSERT INTO datas SELECT ${code}, ot, alias, setcode, type, atk, def, level, race, attribute, category FROM datas WHERE id=55144522`);
  db.exec(`INSERT INTO texts SELECT ${code}, 'Unoffered branch', 'Choose an effect.', 'Unreachable branch','Reachable branch','Activation',str4,str5,str6,str7,str8,str9,str10,str11,str12,str13,str14,str15,str16 FROM texts WHERE id=55144522`); db.close();
  await writeFile(join(root, "card-scripts", `c${code}.lua`), `local s,id=GetID()
function s.initial_effect(c)
local e=Effect.CreateEffect(c); e:SetDescription(aux.Stringid(id,2)); e:SetType(EFFECT_TYPE_ACTIVATE); e:SetCode(EVENT_FREE_CHAIN)
e:SetOperation(function(e,tp) Duel.SelectEffect(tp,{false,aux.Stringid(id,0)},{true,aux.Stringid(id,1)}) end); c:RegisterEffect(e)
end`);
  const card = { code, type: 2, description: "Choose an effect." }, test = makeSmokeCases(card)[0]!;
  test.board.p0!.hand = [code]; test.board.p0!.spells = []; test.board.p1!.hand = []; test.board.p1!.spells = [];
  const result = await runSmokeCase(test, root, { maxSteps: 180, maxTurns: 2 });
  expect(result.failure).toBeUndefined();
  expect(summarizeCard(card, [result]).status).toBe("WARN");
  expect(summarizeCard(card, [result]).reason).toContain("Unreachable branch");
});
itWithCores("keeps identical operation branches distinct for each registered effect", [needs.standard(), needs.cards()], async () => {
  const root = await mkdtemp(join(tmpdir(), "new-card-distinct-branches-")); roots.push(root);
  for (const file of ["cards.cdb", "strings.conf", "ocgcore.standard.wasm"]) await cp(join(directory, file), join(root, file));
  execFileSync("cp", ["-al", join(directory, "card-scripts"), join(root, "card-scripts")]);
  const code = 99999996, db = new Database(join(root, "cards.cdb"));
  db.exec(`INSERT INTO datas SELECT ${code}, ot, alias, setcode, 131074, atk, def, level, race, attribute, category FROM datas WHERE id=55144522`);
  db.exec(`INSERT INTO texts SELECT ${code}, 'Distinct branches', 'Choose an effect.', 'Draw branch','Damage branch','First effect','Second effect',str5,str6,str7,str8,str9,str10,str11,str12,str13,str14,str15,str16 FROM texts WHERE id=55144522`); db.close();
  await writeFile(join(root, "card-scripts", `c${code}.lua`), `local s,id=GetID()
function s.initial_effect(c)
for i=2,3 do
local e=Effect.CreateEffect(c); e:SetDescription(aux.Stringid(id,i)); e:SetType(EFFECT_TYPE_IGNITION)
e:SetRange(LOCATION_SZONE); e:SetCountLimit(1)
e:SetOperation(function(e,tp) Duel.SelectOption(tp,aux.Stringid(id,0),aux.Stringid(id,1)) end); c:RegisterEffect(e)
end
end`);
  const card = { code, type: 131074, description: "Choose an effect." }, test = makeSmokeCases(card)[0]!;
  test.board.p0!.hand = []; test.board.p0!.spells = [{ card: code, pos: "up" }];
  test.board.p1!.hand = []; test.board.p1!.spells = [];
  const result = await runSmokeCase(test, root, { maxSteps: 180, maxTurns: 1 });
  expect(result.failure).toBeUndefined();
  const effects = result.expected!.filter(e => !e.parent);
  expect(effects).toHaveLength(2);
  for (const effect of effects) {
    const modes = result.expected!.filter(e => e.parent === effect.id);
    expect(modes).toHaveLength(2);
    expect(modes.filter(e => result.activated.includes(e.id))).toHaveLength(1);
  }
  expect(summarizeCard(card, [result]).status).toBe("WARN");
  expect(summarizeCard(card, [result]).reason).toContain("4 of 6");
});
itWithCores("does not carry a negated target's branch into the effect's next successful activation", [needs.standard(), needs.cards()], async () => {
  const root = await mkdtemp(join(tmpdir(), "new-card-negated-branch-")); roots.push(root);
  for (const file of ["cards.cdb", "strings.conf", "ocgcore.standard.wasm"]) await cp(join(directory, file), join(root, file));
  execFileSync("cp", ["-al", join(directory, "card-scripts"), join(root, "card-scripts")]);
  const code = 99999997, db = new Database(join(root, "cards.cdb"));
  db.exec(`INSERT INTO datas SELECT ${code}, ot, alias, setcode, 131074, atk, def, level, race, attribute, category FROM datas WHERE id=55144522`);
  db.exec(`INSERT INTO texts SELECT ${code}, 'Negated branch', 'Choose an effect.', 'Negated branch','Resolved branch','Activation',str4,str5,str6,str7,str8,str9,str10,str11,str12,str13,str14,str15,str16 FROM texts WHERE id=55144522`); db.close();
  await writeFile(join(root, "card-scripts", `c${code}.lua`), `local s,id=GetID()
function s.initial_effect(c)
local tries=0
local e=Effect.CreateEffect(c); e:SetDescription(aux.Stringid(id,2)); e:SetType(EFFECT_TYPE_IGNITION); e:SetRange(LOCATION_SZONE)
e:SetCost(function(e,tp,eg,ep,ev,re,r,rp,chk) if chk==0 then return tries<2 end tries=tries+1 end)
e:SetTarget(function(e,tp,eg,ep,ev,re,r,rp,chk) if chk==0 then return true end Duel.SelectOption(tp,aux.Stringid(id,0),aux.Stringid(id,1)) end)
e:SetOperation(function() end); c:RegisterEffect(e)
local negate=Effect.GlobalEffect(); negate:SetType(EFFECT_TYPE_FIELD|EFFECT_TYPE_CONTINUOUS); negate:SetCode(EVENT_CHAINING)
negate:SetOperation(function(e,tp,eg,ep,ev,re) if re:GetHandler()==c and tries==1 then Duel.NegateActivation(ev) end end)
Duel.RegisterEffect(negate,0)
end`);
  const card = { code, type: 131074, description: "Choose an effect." }, test = makeSmokeCases(card)[0]!;
  test.board.p0!.hand = []; test.board.p0!.spells = [{ card: code, pos: "up" }]; test.board.p1!.hand = []; test.board.p1!.spells = [];
  const result = await runSmokeCase(test, root, { maxSteps: 180, maxTurns: 1 });
  expect(result.failure).toBeUndefined();
  const branches = result.expected!.filter(e => e.parent);
  expect(branches).toHaveLength(2);
  expect(result.activated).not.toContain(branches.find(e => e.label === "Negated branch")!.id);
  expect(result.activated).toContain(branches.find(e => e.label === "Resolved branch")!.id);
  expect(summarizeCard(card, [result]).status).toBe("WARN");
});
itWithCores("allows printed rule references in a known card's prompt while rejecting hidden identities", [needs.standard(), needs.cards()], async () => {
  const test = smokeCasesForCard(40235813, directory, ["1v1"]).find(t => t.id === "normal/1v1/deck")!;
  const result = await runSmokeCase(test, directory);
  expect(result.failure).toBeUndefined();
  const compiled = compileSmokeCase(test, directory), cards = loadCardDatabase(directory);
  const game = await createEngineGame({ ...compiled.options, dataDirectory: directory, seed: engineSeed(test.seed) });
  try {
    const p0 = game.view(0).prompt!; game.answer(0, p0.id, { cancel: true });
    const v = { v0: game.view(0), v1: game.view(1), vs: game.view(null) };
    const checker = () => new InvariantChecker({ mode: test.mode, decks: compiled.options.decks as never, disjoint: false,
      catalog: loadCatalog(directory), printedText: code => [cards.get(code)?.description ?? ""] });
    v.v1.prompt!.title = 'The other player secretly drew Dark Time Wizard';
    expect(checker().check(0, v).some(e => e.invariant === "privacy-text" && e.message.includes("hidden card"))).toBe(true);
    v.v1.prompt!.options.push({ id: "secret", label: "Hidden identity", card: cards.get(test.code)! });
    expect(checker().check(0, v).some(e => e.invariant === "privacy-prompt" && e.message.includes(String(test.code)))).toBe(true);
  } finally { game.close(); }
});
itWithCores("inventories all four alternate artworks without borrowing their canonical copy's effects", [needs.standard(), needs.cards()], async () => {
  for (const code of [17242023, 24203750, 50208445, 79791696]) {
    const test = smokeCasesForCard(code, directory, ["1v1"]).find(t => t.id === "normal/1v1/field")!;
    const result = await runSmokeCase(test, directory, { maxSteps: 240, maxTurns: 2 });
    expect(result.failure).toBeUndefined();
    expect(result.expected!.filter(e => !e.parent).length).toBeGreaterThan(0);
  }
});
itWithCores("deduplicates the same parent and option across selection calls", [needs.standard(), needs.cards()], async () => {
  const root = await mkdtemp(join(tmpdir(), "new-card-two-selections-")); roots.push(root);
  for (const file of ["cards.cdb", "strings.conf", "ocgcore.standard.wasm"]) await cp(join(directory, file), join(root, file));
  execFileSync("cp", ["-al", join(directory, "card-scripts"), join(root, "card-scripts")]);
  const code = 99999998, db = new Database(join(root, "cards.cdb"));
  db.exec(`INSERT INTO datas SELECT ${code}, ot, alias, setcode, 131074, atk, def, level, race, attribute, category FROM datas WHERE id=55144522`);
  db.exec(`INSERT INTO texts SELECT ${code}, 'Two selections', 'Choose an effect.', 'Draw branch','Damage branch','Activation',str4,str5,str6,str7,str8,str9,str10,str11,str12,str13,str14,str15,str16 FROM texts WHERE id=55144522`); db.close();
  await writeFile(join(root, "card-scripts", `c${code}.lua`), `local s,id=GetID()
function s.initial_effect(c)
local e=Effect.CreateEffect(c); e:SetDescription(aux.Stringid(id,2)); e:SetType(EFFECT_TYPE_IGNITION); e:SetRange(LOCATION_SZONE); e:SetCountLimit(1)
e:SetOperation(function(e,tp)
Duel.SelectOption(tp,aux.Stringid(id,0),aux.Stringid(id,1))
Duel.SelectOption(tp,aux.Stringid(id,0),aux.Stringid(id,1))
end); c:RegisterEffect(e)
end`);
  const card = { code, type: 131074, description: "Choose an effect." }, test = makeSmokeCases(card)[0]!;
  test.board.p0!.hand = []; test.board.p0!.spells = [{ card: code, pos: "up" }]; test.board.p1!.hand = []; test.board.p1!.spells = [];
  const result = await runSmokeCase(test, root, { maxSteps: 180, maxTurns: 1 });
  expect(result.failure).toBeUndefined();
  expect(result.expected!.filter(e => e.parent)).toHaveLength(2);
  expect(summarizeCard(card, [result]).status).toBe("PASS");
  expect(summarizeCard(card, [result]).reason).toContain("3 of 3");
});
