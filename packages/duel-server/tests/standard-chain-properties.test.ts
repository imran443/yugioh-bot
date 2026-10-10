import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, expect, it, vi } from "vitest";
import type { OcgCoreSync } from "ocgcore-wasm";
import { createEngineGame } from "../src/engine.js";
import type { DuelScriptError, DuelScriptFatalError } from "../src/script-errors.js";
import { engineDataDirectory as DATA } from "./engine-data-dir.js";
import { compileBoard } from "./support/board.js";
import { describeWithCores, needs } from "./support/cores.js";
import { activate, defineScenario, expectBoard, expectResolved, type Scenario } from "./support/dsl.js";
import { Session } from "./support/session.js";

// Observe debug messages from the real WASM. All core calls and Lua scripts still run.
const observed = vi.hoisted(() => ({ snapshots: [] as string[] }));
vi.mock("ocgcore-wasm", async (original) => {
  const actual = await original<typeof import("ocgcore-wasm")>();
  return { ...actual, default: async (options: { sync: true }) => {
    const core = await actual.default(options);
    const create = core.createDuel;
    core.createDuel = ((duelOptions) => create({ ...duelOptions, errorHandler: (type, text) => {
      if (text.startsWith("STANDARD_CHAIN:")) observed.snapshots.push(text);
      duelOptions.errorHandler?.(type, text);
    } })) as OcgCoreSync["createDuel"];
    return core;
  } };
});
beforeEach(() => { observed.snapshots = []; });

const cases: { scenario: Scenario; code: number; scale: number; link: number }[] = [
  {
    code: 92746535, scale: 5, link: 0,
    scenario: defineScenario({
      id: "standard-pendulum-chain-scale",
      title: "Luster Pendulum destroys the other Scale and searches its replacement",
      source: "card-scripts/official/c92746535.lua and card-scripts/chain.lua",
      tags: ["chain", "pendulum", "scale", "search"],
      setup: { p0: { pendulum: ["Luster Pendulum, the Dracoslayer", "Vector Pendulum, the Dracoverlord"],
        deck: ["Vector Pendulum, the Dracoverlord"] } },
      steps: [
        activate({ card: "Luster Pendulum, the Dracoslayer", from: "szone" }),
        expectResolved("Luster Pendulum, the Dracoslayer"),
        expectBoard({ p0: { hand: ["Vector Pendulum, the Dracoverlord"],
          spells: ["Luster Pendulum, the Dracoslayer"], extra: ["Vector Pendulum, the Dracoverlord"], deckCount: 19 } }),
      ],
    }),
  },
  {
    code: 98978921, scale: 0, link: 1,
    scenario: defineScenario({
      id: "standard-link-chain-rating",
      title: "Link Spider summons a Normal Monster to its linked zone",
      source: "card-scripts/official/c98978921.lua and card-scripts/chain.lua",
      tags: ["chain", "link", "special-summon"],
      setup: { p0: { monsters: [null, null, null, null, null, "Link Spider"], hand: ["Mystical Elf"] } },
      steps: [
        activate("Link Spider"),
        expectResolved("Link Spider"),
        expectBoard({ p0: { hand: [], monsters: ["Link Spider", "Mystical Elf"], zones: { emz0: "Link Spider", m1: "Mystical Elf" } } }),
      ],
    }),
  },
];

describeWithCores("Standard 1v1 triggering Scale and Link properties", [needs.cards(DATA), needs.scripts(DATA), needs.standard(DATA)], () => {
  for (const { scenario, code, scale, link } of cases) {
    // A real chain probe checks all three newer flags, including CHAININFO flag 32.
    // The success marker proves that the probe ran, rather than merely finding no errors.
    const probe = `
local probe=Effect.GlobalEffect()
probe:SetType(EFFECT_TYPE_FIELD+EFFECT_TYPE_CONTINUOUS)
probe:SetCode(EVENT_CHAINING)
probe:SetOperation(function(e,tp,eg,ep,ev,re,r,rp)
  if Duel.GetChainInfo(ev,CHAININFO_TRIGGERING_CODE)~=${code} then return end
  local function info(flag)
    local ok,value=pcall(Duel.GetChainInfo,ev,flag)
    assert(ok,"CHAININFO flag "..flag..": "..tostring(value))
    return value
  end
  local left,right,rating=info(CHAININFO_TRIGGERING_LSCALE),info(CHAININFO_TRIGGERING_RSCALE),info(CHAININFO_TRIGGERING_LINK)
  assert(left==${scale} and right==${scale} and rating==${link},"Incorrect triggering Scale or Link")
  assert(Chain.GetTriggeringScale(ev)==left and Chain.GetTriggeringLink(ev)==rating,"Incorrect chain helpers")
  Debug.Message("STANDARD_CHAIN:${code}:"..left..":"..right..":"..rating)
end)
Duel.RegisterEffect(probe,0)
`;
    const run = async () => {
      const compiled = compileBoard(scenario.setup);
      const errors: (DuelScriptError | DuelScriptFatalError)[] = [];
      const game = await createEngineGame({ ...compiled.options, dataDirectory: DATA, seed: ["1", "2", "3", "4"],
        scriptErrorMode: "strict", onScriptError: error => errors.push(error), onFatalScriptError: error => errors.push(error),
        startupScripts: [...compiled.options.startupScripts!, { name: "standard-chain-probe.lua", content: probe }] });
      try {
        const manifest = JSON.parse(readFileSync(join(DATA, "manifest.json"), "utf8"));
        expect(game.coreInfo()).toMatchObject({ wasmFile: "ocgcore.standard.wasm", wasmSha: manifest.integrity.standardWasm });
        const session = new Session(scenario, game);
        session.reachMainPhase(); session.startRecording();
        try {
          scenario.steps.forEach((step, index) => session.run(step, index + 1));
        } catch (error) {
          throw new Error(`${String(error)}\n${errors.map(entry => entry.message).join("\n")}`, { cause: error });
        }
        expect(observed.snapshots).toEqual([`STANDARD_CHAIN:${code}:${scale}:${scale}:${link}`]);
        expect(errors).toEqual([]);
        expect(game.view(0).log.some(entry => entry.text.startsWith("Card script error"))).toBe(false);
      } finally { game.close(); }
    };
    it(scenario.title, run);
  }
});
