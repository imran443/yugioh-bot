import type { DuelAnswer, DuelCard, DuelEngineView, DuelEvent, DuelPrompt, DuelPromptOption, DuelSeatView } from "@yugidraft/shared/duels";
import { createEngineGame, type EngineGame } from "../../src/engine.js";
import { seatCountFor, teamOfSeat, type DuelFormat } from "@yugidraft/shared/duels";
import { candidates as matchCandidates, matchesSel as matchSel, pickOne as matchPick, type PromptSel } from "../../src/prompt-match.js";
import { compileBoard, seatOf, type DuelistId, DUELIST_IDS } from "./board.js";
import { cardLabel, resolveCard, type CardRef } from "./card-catalog.js";
import { loadCardDatabase } from "../../src/cards.js";
import type {
  ActionKind, BoardExpect, CardSel, DuelistExpect, EventMatch, ListExpect, OptionRef, OptionsExpect, PromptExpect, Scenario, Step, Zone, ZoneExpect,
} from "./dsl.js";
import { readFileSync } from "node:fs";
import createCore, { type OcgCardData } from "ocgcore-wasm";
import { engineDataDirectory } from "../engine-data-dir.js";
import { currentDomainMultiWasm, currentNseatWasm } from "./cores.js";
import { EngineAnswerError } from "../../src/prompts.js";


/** Failure of a scenario step, with the state of the duel at that moment. */
export class ScenarioError extends Error {
  constructor(scenario: string, stepNo: number, step: string, message: string) {
    super(`[${scenario}] step ${stepNo} ${step}\n${message}`);
    this.name = "ScenarioError";
  }
}

const ACTION_PREFIX: Record<ActionKind, string[]> = {
  activate: ["activate:", "card:"],
  normalSummon: ["summon:"],
  tributeSummon: ["summon:"],
  set: ["mset:", "sset:"],
  specialSummon: ["spsummon:"],
  changePosition: ["pos:"],
  attack: ["attack:"],
};

const ZONES: Record<Zone, { location: number; sequence: number }> = {
  m0: { location: 4, sequence: 0 }, m1: { location: 4, sequence: 1 }, m2: { location: 4, sequence: 2 },
  m3: { location: 4, sequence: 3 }, m4: { location: 4, sequence: 4 }, emz0: { location: 4, sequence: 5 },
  emz1: { location: 4, sequence: 6 },
  s0: { location: 8, sequence: 0 }, s1: { location: 8, sequence: 1 }, s2: { location: 8, sequence: 2 },
  s3: { location: 8, sequence: 3 }, s4: { location: 8, sequence: 4 }, f: { location: 8, sequence: 5 },
  // Master Rule 5: the Pendulum Zones are the outer Spell/Trap Zones (sequence 0 and 4).
  pz0: { location: 8, sequence: 0 }, pz1: { location: 8, sequence: 4 },
};

function stepName(step: Step): string {
  const { op, ...rest } = step as Step & Record<string, unknown>;
  const args = Object.entries(rest)
    .filter(([key, value]) => value !== undefined && key !== "by")
    .map(([, value]) => (typeof value === "string" || typeof value === "number" ? JSON.stringify(value) : JSON.stringify(value)));
  return `${op}(${args.join(", ")})`;
}

function codeOf(ref: CardRef): number {
  return resolveCard(ref);
}

function selCard(sel: CardSel): CardRef {
  return typeof sel === "object" ? sel.card : sel;
}

function describeSel(sel: CardSel): string {
  return typeof sel === "object" ? JSON.stringify(sel) : JSON.stringify(sel);
}

export function describePrompt(view: DuelEngineView, prompt: DuelPrompt): string {
  const lines = [
    `Open prompt for p${prompt.seat} [${prompt.kind}${prompt.context ? `/${prompt.context.type}` : ""}] "${prompt.title}"` +
      ` (turn ${view.turn}, p${view.turnSeat}, ${view.phase}${view.battleStep ? `/${view.battleStep}` : ""})`,
  ];
  if (prompt.min != null || prompt.max != null) lines.push(`  pick ${prompt.min ?? 1}..${prompt.max ?? prompt.min ?? 1}`);
  lines.push("Legal options:");
  for (const option of prompt.options) lines.push(`  ${option.id.padEnd(12)} ${option.label}${option.selected ? " (selected)" : ""}`);
  if (prompt.cancelable) lines.push("  (cancel allowed)");
  if (prompt.finishable) lines.push("  (finish allowed)");
  return lines.join("\n");
}

/** Multi-duelist core for N-seat scenarios: NSEAT_WASM, else the current multi core (tests/support/cores.ts). */
export function nseatWasmPath(): string {
  return currentNseatWasm();
}

export function nseatWasmBinary(): ArrayBuffer | undefined {
  try {
    const bytes = readFileSync(nseatWasmPath());
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  } catch {
    return undefined;
  }
}

/** Multi-duelist Domain core for N-seat scenarios with `mode: "domain"`: DOMAIN_MULTI_WASM, else the current Domain multi core. */
export function domainNseatWasmBinary(): ArrayBuffer | undefined {
  try {
    const bytes = readFileSync(currentDomainMultiWasm());
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  } catch {
    return undefined;
  }
}

/** True when the N-seat core has Debug.SetupDuelists. Live N-seat tests pass it to needs.setupDuelists / needs.liveNseat (tests/support/cores.ts). */
export async function probeSetupDuelists(): Promise<boolean> {
  try {
    const wasmBinary = nseatWasmBinary();
    if (!wasmBinary) return false;
    const lib = await createCore({ sync: true, wasmBinary });
    const team = { startingLP: 8000, startingDrawCount: 5, drawCountPerTurn: 1 };
    const handle = lib.createDuel({
      flags: 0n,
      seed: [1n, 2n, 3n, 4n],
      team1: team,
      team2: team,
      cardReader: () => null as OcgCardData | null,
      scriptReader: () => null,
      errorHandler: () => undefined,
    });
    if (!handle) return false;
    const ok = lib.loadScript(handle, "probe.lua", "Debug.SetupDuelists(3,0,1,2)");
    lib.destroyDuel(handle);
    return ok;
  } catch {
    return false;
  }
}

export interface ScenarioRun {
  game: EngineGame;
  close(): void;
}

/** Runs one scenario. Throws ScenarioError on the first step that fails. */
export async function runScenario(scenario: Scenario): Promise<void> {
  const compiled = compileBoard(scenario.setup);
  const game = await createEngineGame({
    ...compiled.options,
    seed: scenario.seed ?? ["1", "2", "3", "4"],
    dataDirectory: engineDataDirectory,
    ...((scenario.setup.format ?? "1v1") !== "1v1" ? { multiWasmBinary: scenario.setup.mode === "domain" ? domainNseatWasmBinary() : nseatWasmBinary() } : {}),
  });
  try {
    const session = new Session(scenario, game);
    session.reachMainPhase();
    session.startRecording();
    scenario.steps.forEach((step, index) => session.run(step, index + 1));
  } finally {
    game.close();
  }
}

/** A Lua script error of the core: the message names a chunk (`[string "c123.lua"]`) or a script file line (`c123.lua:46:`). */
export function isLuaScriptError(message: string): boolean {
  return message.includes('[string "c') || message.includes(".lua:");
}

export class Session {
  private readonly format: DuelFormat;
  private readonly seatCount: number;
  private readonly seats: number[];
  /** Seats that answered a chain-response prompt, in order (see expectResponseOrder). */
  private readonly responses: number[] = [];
  private responseCursor = 0;
  private recording = false;

  constructor(private readonly scenario: Scenario, private readonly game: EngineGame) {
    this.format = scenario.setup.format ?? "1v1";
    this.seatCount = seatCountFor(this.format);
    this.seats = Array.from({ length: this.seatCount }, (_, seat) => seat);
  }

  /** Start to record chain-response prompts (after the routine Draw Phase windows are declined). */
  startRecording(): void {
    this.recording = true;
  }

  private toSel(sel: CardSel): PromptSel {
    if (typeof sel !== "object") return { code: codeOf(sel) };
    return { code: codeOf(sel.card), owner: sel.owner ? seatOf(sel.owner) : undefined, from: sel.from as PromptSel["from"], seq: sel.seq, nth: sel.nth, effect: sel.effect };
  }

  /**
   * The core opens an optional chain window in the Draw Phase when a player holds a card that could
   * be activated (a Quick-Play Spell in hand, for example). Scenarios start in Main Phase 1, so
   * those windows are declined here.
   */
  reachMainPhase(): void {
    for (let guard = 0; guard < 12; guard++) {
      const open = this.openPrompt();
      if (!open || open.view.phase === "main1") return;
      const { prompt } = open;
      if (prompt.context?.type !== "chain" || prompt.context.forced || !prompt.cancelable) return;
      this.game.answer(open.seat, prompt.id, { cancel: true });
    }
  }

  private fail(stepNo: number, step: Step, message: string, withPrompt = true): never {
    let text = message;
    if (withPrompt) {
      const open = this.openPrompt();
      text += `\n${open ? describePrompt(open.view, open.prompt) : "No prompt is open. " + this.summary()}`;
    }
    throw new ScenarioError(this.scenario.id, stepNo, stepName(step), text);
  }

  private summary(): string {
    const view = this.game.view(0);
    const result = view.result ? ` Duel over: winner ${view.result.winnerSeat == null ? "none" : `p${view.result.winnerSeat}`} (${view.result.reason}).` : "";
    return `Turn ${view.turn}, p${view.turnSeat}, ${view.phase}.${result}`;
  }

  private openPrompt(): { seat: number; view: DuelEngineView; prompt: DuelPrompt } | null {
    for (const seat of this.seats) {
      const view = this.game.view(seat);
      if (view.prompt) return { seat, view, prompt: view.prompt };
    }
    return null;
  }

  private seatState(id: DuelistId): DuelSeatView {
    const seat = seatOf(id);
    return this.game.view(seat).seats[seat];
  }

  /** The open prompt, checked against the optional expected duelist. */
  private need(stepNo: number, step: Step, by: DuelistId | undefined): { seat: number; view: DuelEngineView; prompt: DuelPrompt } {
    const open = this.openPrompt();
    if (!open) this.fail(stepNo, step, `Expected an open prompt, but the duel waits for nothing. ${this.summary()}`, false);
    if (by && open.seat !== seatOf(by)) {
      this.fail(stepNo, step, `Expected the prompt to be for ${by}, but it is for p${open.seat}.`);
    }
    return open;
  }

  private matchesSel(option: DuelPromptOption, sel: CardSel): boolean {
    return matchSel(option, this.toSel(sel));
  }

  /** Options of the open prompt that match a selector and one of the id prefixes. */
  private candidates(prompt: DuelPrompt, prefixes: string[], sel: CardSel, extra?: (option: DuelPromptOption) => boolean) {
    return matchCandidates(prompt, prefixes, this.toSel(sel), extra);
  }

  private pickOne(stepNo: number, step: Step, options: DuelPromptOption[], sel: CardSel, what: string): DuelPromptOption {
    const result = matchPick(options, this.toSel(sel), what, describeSel(sel));
    if ("error" in result) this.fail(stepNo, step, result.error);
    return result.option;
  }

  private send(stepNo: number, step: Step, open: { seat: number; prompt: DuelPrompt }, answer: DuelAnswer): void {
    try {
      this.game.answer(open.seat, open.prompt.id, answer);
      if (this.recording && open.prompt.context?.type === "chain") this.responses.push(open.seat);
    } catch (error) {
      this.fail(stepNo, step, `The engine rejected the answer ${JSON.stringify(answer)}: ${(error as Error).message}`);
    }
  }

  /**
   * Some prompts are routine: the zone for a Spell/Trap or a summoned monster, and the Position of
   * a summoned monster. Unless the next step answers or inspects them, the first legal option is
   * taken (first zone, face-up Attack Position), so scenarios stay short. A scenario that tests
   * the choice itself uses zone(), position() or expectPrompt().
   */
  private settle(next: Step, stepNo: number): void {
    // A surrender keeps the routine prompt open too: giving up while a zone prompt is open is a case of its own.
    // expectPickOptions, expectLabel and expectRetry inspect the open prompt as it is, also a routine zone or position prompt.
    if (["zone", "position", "raw", "auto", "choose", "surrender", "expectPickOptions", "expectLabel", "expectRetry"].includes(next.op)) return;
    if (next.op === "expectPrompt") {
      const want = next.prompt;
      // Inspecting the routine prompt itself keeps it open; any other inspection settles it first.
      if (want.kind === "places" || want.context === "position" || /zone|position/i.test(want.title ?? "")) return;
    }
    for (let guard = 0; guard < 8; guard++) {
      const open = this.openPrompt();
      if (!open) return;
      const { prompt } = open;
      if (prompt.kind === "places" && /^Select a zone for /.test(prompt.title)) {
        this.send(stepNo - 1, next, open, { selected: [prompt.options[0].id] });
      } else if (prompt.kind === "choice" && prompt.context?.type === "position" && /^Select a position for /.test(prompt.title)) {
        this.send(stepNo - 1, next, open, { choice: prompt.options[0].id });
      } else {
        return;
      }
    }
  }

  run(step: Step, stepNo: number): void {
    this.settle(step, stepNo);
    switch (step.op) {
      case "expectPrivateCards": {
        const problems: string[] = [];
        for (const viewer of [...this.seats, null]) {
          const view = this.game.view(viewer);
          for (const ref of step.cards) {
            const state = view.seats[seatOf(ref.owner)];
            const list = ref.from === "hand" ? state.hand : ref.from === "mzone" ? state.monsters : state.spells;
            const card = list[ref.seq];
            const label = `${viewer === null ? "spectator" : `p${viewer}`} sees ${ref.owner}.${ref.from}[${ref.seq}]`;
            if (!card) { problems.push(`${label}: missing card`); continue; }
            const visible = viewer !== null && ref.visibleTo.some((id) => seatOf(id) === viewer);
            if (visible) {
              if (card.code !== codeOf(ref.card) || !card.name) problems.push(`${label}: expected ${cardLabel(codeOf(ref.card))}, got ${cardLabel(card.code)}`);
            } else {
              // handId is an opaque DOM key. Only a sleeve id (src/hand-identities.ts) says nothing about the card.
              const leaked = Object.keys(card).filter((key) => {
                if (["controller", "location", "sequence", "position"].includes(key)) return false;
                if (key === "handId") return !/^sleeve-\d+$/.test(String((card as { handId?: unknown }).handId));
                return true;
              });
              if (leaked.length) problems.push(`${label}: private fields leaked: ${leaked.join(", ")}`);
            }
          }
        }
        if (problems.length) this.fail(stepNo, step, problems.join("\n"), false);
        return;
      }
      case "activate":
      case "normalSummon":
      case "specialSummon":
      case "changePosition":
        return this.action(step, stepNo, step.op, step.sel, step.by);
      case "set":
        return this.action(step, stepNo, "set", step.sel, step.by);
      case "attack":
        return this.attack(step, stepNo);
      case "phase":
        return this.phase(step, stepNo);
      case "pass": {
        const open = this.need(stepNo, step, step.by);
        if (open.prompt.context?.type !== "chain") this.fail(stepNo, step, "pass() needs a chain prompt.");
        if (open.prompt.context.forced) this.fail(stepNo, step, "This chain prompt is forced. A player cannot pass.");
        return this.send(stepNo, step, open, { cancel: true });
      }
      case "choose": {
        const open = this.need(stepNo, step, step.by);
        const needle = step.match.toLowerCase();
        const hits = open.prompt.options.filter((o) => o.id === step.match || o.label.toLowerCase().includes(needle));
        const exact = hits.filter((o) => o.id === step.match);
        const pick = exact[0] ?? (hits.length === 1 ? hits[0] : undefined);
        if (!pick) this.fail(stepNo, step, hits.length === 0 ? `No option matches "${step.match}".` : `"${step.match}" matches ${hits.length} options.`);
        return this.send(stepNo, step, open, { choice: pick.id });
      }
      case "select": {
        const open = this.need(stepNo, step, step.by);
        if (open.prompt.kind === "places") this.fail(stepNo, step, "This prompt selects zones. Use zone().");
        if (open.prompt.kind === "toggle") return this.selectToggle(step, stepNo, step.sels, open);
        const used = new Set<string>();
        const picks: string[] = [];
        for (const sel of step.sels) {
          const hit = open.prompt.options.filter((o) => !used.has(o.id) && this.matchesSel(o, sel));
          const pick = this.pickOne(stepNo, step, hit, sel, "selection");
          used.add(pick.id);
          picks.push(pick.id);
        }
        return this.send(stepNo, step, open, { selected: picks });
      }
      case "auto": {
        const open = this.need(stepNo, step, step.by);
        const count = Math.max(open.prompt.min ?? 1, 1);
        return this.send(stepNo, step, open, { selected: open.prompt.options.slice(0, count).map((o) => o.id) });
      }
      case "selectCardAt": {
        const open = this.need(stepNo, step, step.by);
        if (open.prompt.kind !== "cards") this.fail(stepNo, step, "This prompt does not select cards.");
        const want = ZONES[step.zone];
        const picks = open.prompt.options.filter(
          (o) => o.controller === seatOf(step.owner) && o.location === want.location && o.sequence === want.sequence,
        );
        if (picks.length !== 1) this.fail(stepNo, step, `Card at ${step.owner}.${step.zone} needs exactly one legal option; got ${picks.length}.`);
        return this.send(stepNo, step, open, { selected: [picks[0].id] });
      }
      case "zone": {
        const open = this.need(stepNo, step, step.by);
        if (open.prompt.kind !== "places") this.fail(stepNo, step, "This prompt does not select zones.");
        const want = ZONES[step.zone];
        const pick = open.prompt.options.find(
          (o) => o.controller === seatOf(step.owner) && o.location === want.location && o.sequence === want.sequence,
        );
        if (!pick) this.fail(stepNo, step, `Zone ${step.owner}.${step.zone} is not a legal choice.`);
        return this.send(stepNo, step, open, { selected: [pick.id] });
      }
      case "position": {
        const open = this.need(stepNo, step, step.by);
        const words = { atk: ["attack"], def: ["defense", "defence"], set: ["set", "down"] }[step.pos];
        const hits = open.prompt.options.filter((o) => words.some((w) => `${o.id} ${o.label}`.toLowerCase().includes(w)));
        const pick = hits.length === 1 ? hits[0] : undefined;
        if (!pick) this.fail(stepNo, step, `Position "${step.pos}" matched ${hits.length} options.`);
        return this.send(stepNo, step, open, open.prompt.kind === "choice" ? { choice: pick.id } : { selected: [pick.id] });
      }
      case "yes":
      case "no": {
        const open = this.need(stepNo, step, step.by);
        if (!open.prompt.options.some((o) => o.id === step.op)) this.fail(stepNo, step, `This prompt has no "${step.op}" option.`);
        return this.send(stepNo, step, open, { choice: step.op });
      }
      case "finish": {
        const open = this.need(stepNo, step, step.by);
        return this.send(stepNo, step, open, { finish: true });
      }
      case "number": {
        const open = this.need(stepNo, step, step.by);
        return this.send(stepNo, step, open, { value: step.value });
      }
      case "announce": {
        const open = this.need(stepNo, step, step.by);
        return this.send(stepNo, step, open, { cardCode: codeOf(step.card) });
      }
      case "raw": {
        const open = this.need(stepNo, step, step.by);
        return this.send(stepNo, step, open, step.answer);
      }
      case "surrender": {
        try {
          this.game.eliminate(seatOf(step.seat), step.reason ?? 0);
        } catch (error) {
          this.fail(stepNo, step, `The engine refused the surrender: ${(error as Error).message}`, false);
        }
        return;
      }
      case "expectBoard":
        return this.expectBoard(step, stepNo);
      case "expectEvents":
        return this.expectEvents(step, stepNo);
      case "expectNoEvent": {
        const hit = this.events().find((event) => this.eventMatches(event, step.event));
        if (hit) this.fail(stepNo, step, `Unexpected event: #${hit.id} ${hit.kind} "${hit.text}".`, false);
        return;
      }
      case "expectLog": {
        const log = this.game.view(0).log;
        let cursor = 0;
        for (const [index, line] of step.lines.entries()) {
          const at = log.findIndex((entry, i) => i >= cursor && entry.text.includes(line));
          if (at < 0) this.fail(stepNo, step, `Log line ${index + 1} of ${step.lines.length} not found in order: "${line}".\nLog:\n${log.slice(-15).map((e) => `  #${e.id} ${e.text}`).join("\n")}`, false);
          cursor = at + 1;
        }
        return;
      }
      case "expectLogSeen": {
        const log = this.game.view(step.viewer === "spectator" ? null : seatOf(step.viewer)).log;
        for (const text of step.has ?? []) {
          if (!log.some((entry) => entry.text.includes(text))) this.fail(stepNo, step, `${step.viewer} log has no line with "${text}".\nLog:\n${log.slice(-15).map((e) => `  #${e.id} ${e.text}`).join("\n")}`, false);
        }
        for (const text of step.lacks ?? []) {
          const hit = log.find((entry) => entry.text.includes(text));
          if (hit) this.fail(stepNo, step, `${step.viewer} log has an unexpected line: #${hit.id} "${hit.text}".`, false);
        }
        return;
      }
      case "expectNoLog": {
        const hit = this.game.view(0).log.find((entry) => entry.text.includes(step.text));
        if (hit) this.fail(stepNo, step, `Unexpected log line: #${hit.id} "${hit.text}".`, false);
        return;
      }
      case "expectResolved": {
        const got = this.events().filter((e) => e.kind === "chain-resolving").map((e) => e.card?.code);
        const want = step.order.map(codeOf);
        if (JSON.stringify(got) !== JSON.stringify(want)) {
          this.fail(stepNo, step, `Chain resolved in a different order.\n  expected: ${want.map((c) => cardLabel(c)).join(" -> ")}\n  actual:   ${got.map((c) => cardLabel(c)).join(" -> ") || "(nothing resolved)"}`, false);
        }
        return;
      }
      case "expectChain": {
        const view = this.game.view(0);
        const got = view.chain.map((link) => link.code);
        const want = step.links.map(codeOf);
        if (JSON.stringify(got) !== JSON.stringify(want)) {
          this.fail(stepNo, step, `Chain stack differs.\n  expected: ${want.map((c) => cardLabel(c)).join(" / ") || "(empty)"}\n  actual:   ${got.map((c) => cardLabel(c)).join(" / ") || "(empty)"}`);
        }
        return;
      }
      case "expectPrompt":
        return this.expectPrompt(step, stepNo, step.prompt);
      case "expectNoPrompt": {
        const open = this.openPrompt();
        if (open) this.fail(stepNo, step, "Expected no open prompt.");
        return;
      }
      case "expectSeatNotOffered": {
        const prompt = this.game.view(seatOf(step.by)).prompt;
        const hits = prompt ? this.candidates(prompt, ACTION_PREFIX[step.action as ActionKind] ?? [""], step.sel) : [];
        if (hits.length > 0) this.fail(stepNo, step, `Expected ${step.by} not to be offered ${step.action} ${describeSel(step.sel)}, but it is.`);
        return;
      }
      case "expectOffered":
      case "expectNotOffered": {
        const open = this.need(stepNo, step, step.by);
        const hits = this.candidates(open.prompt, ACTION_PREFIX[step.action as ActionKind] ?? [""], step.sel);
        if (step.op === "expectOffered" && hits.length === 0) {
          this.fail(stepNo, step, `Expected ${step.action} ${describeSel(step.sel)} to be offered, but it is not.`);
        }
        if (step.op === "expectNotOffered" && hits.length > 0) {
          this.fail(stepNo, step, `Expected ${step.action} ${describeSel(step.sel)} NOT to be offered, but it is: ${hits.map((o) => `${o.id} "${o.label}"`).join("; ")}.`);
        }
        return;
      }
      case "expectResult":
        return this.expectResult(step, stepNo);
      case "expectEliminated":
        return this.expectEliminated(step, stepNo);
      case "expectLp":
        return this.expectLp(step, stepNo);
      case "expectResponseOrder":
        return this.expectResponseOrder(step, stepNo);
      case "expectTurn": {
        const view = this.game.view(0);
        const seat = seatOf(step.seat);
        if (view.turnSeat !== seat) this.fail(stepNo, step, `It is the turn of p${view.turnSeat} (turn ${view.turn}), expected ${step.seat}.`, false);
        if (step.turn != null && view.turn !== step.turn) this.fail(stepNo, step, `It is turn ${view.turn} (p${view.turnSeat}), expected turn ${step.turn}.`, false);
        return;
      }
      case "expectPickSeats": {
        const open = this.need(stepNo, step, step.by);
        const got = [...new Set(open.prompt.options.map((o) => o.controller).filter((c): c is number => c != null))].sort((a, b) => a - b);
        const want = [...new Set(step.seats.map(seatOf))].sort((a, b) => a - b);
        if (JSON.stringify(got) !== JSON.stringify(want)) {
          this.fail(stepNo, step, `The prompt offers seats ${got.map((s) => `p${s}`).join(", ") || "(none)"}, expected exactly ${want.map((s) => `p${s}`).join(", ")}.`);
        }
        return;
      }
      case "expectPickOptions":
        return this.expectPickOptions(step, stepNo);
      case "expectLabel":
        return this.expectLabel(step, stepNo);
      case "expectRetry":
        return this.expectRetry(step, stepNo);
      case "pickOpponent": {
        const open = this.need(stepNo, step, step.by);
        const want = seatOf(step.seat);
        const picks = open.prompt.options.filter((o) => o.controller === want && (open.prompt.context?.type === "opponent" || /directly/i.test(o.label)));
        if (picks.length !== 1) {
          this.fail(stepNo, step, picks.length === 0 ? `This prompt does not offer to attack ${step.seat}.` : `${picks.length} options attack ${step.seat}.`);
        }
        return this.send(stepNo, step, open, { choice: picks[0].id });
      }
    }
  }

  private optionMatches(option: DuelPromptOption, ref: OptionRef): boolean {
    if (ref.seat != null && option.controller !== seatOf(ref.seat)) return false;
    if (ref.card != null && option.card?.code !== codeOf(ref.card)) return false;
    if (ref.label != null && !option.label.toLowerCase().includes(ref.label.toLowerCase())) return false;
    if (ref.id != null && option.id !== ref.id) return false;
    return true;
  }

  /**
   * Gives every ref its own option (a bipartite matching, so equal refs and overlapping refs cannot fool it).
   * Returns the option index of each ref, or -1 when the ref has no option left.
   */
  private assignOptions(refs: OptionRef[], options: DuelPromptOption[]): number[] {
    const owner = options.map(() => -1);
    const augment = (ref: number, seen: boolean[]): boolean => {
      for (let at = 0; at < options.length; at++) {
        if (seen[at] || !this.optionMatches(options[at], refs[ref])) continue;
        seen[at] = true;
        if (owner[at] < 0 || augment(owner[at], seen)) {
          owner[at] = ref;
          return true;
        }
      }
      return false;
    };
    refs.forEach((_, ref) => augment(ref, options.map(() => false)));
    return refs.map((_, ref) => owner.indexOf(ref));
  }

  private describeOptions(options: DuelPromptOption[]): string {
    return options.map((o) => `  ${o.id.padEnd(12)} "${o.label}"${o.controller != null ? ` [p${o.controller}]` : ""}`).join("\n") || "  (no options)";
  }

  private expectPickOptions(step: Extract<Step, { op: "expectPickOptions" }>, stepNo: number): void {
    const open = this.need(stepNo, step, step.by);
    const options = open.prompt.options;
    const want: OptionsExpect = step.options;
    const problems: string[] = [];
    const exact = Array.isArray(want);
    const refs = exact ? want : want.include ?? [];
    const placed = this.assignOptions(refs, options);
    refs.forEach((ref, index) => {
      if (placed[index] < 0) problems.push(`no option left for ${JSON.stringify(ref)}`);
    });
    if (exact) {
      const used = new Set(placed);
      options.forEach((option, index) => {
        if (!used.has(index)) problems.push(`unexpected option ${option.id} "${option.label}"${option.controller != null ? ` [p${option.controller}]` : ""}`);
      });
    } else {
      for (const ref of want.exclude ?? []) {
        const hit = options.find((option) => this.optionMatches(option, ref));
        if (hit) problems.push(`${JSON.stringify(ref)} must not be offered, but ${hit.id} "${hit.label}" is`);
      }
      if (want.count != null && options.length !== want.count) problems.push(`expected ${want.count} option(s), got ${options.length}`);
    }
    if (problems.length > 0) this.fail(stepNo, step, `Options differ:\n  ${problems.join("\n  ")}\nOffered:\n${this.describeOptions(options)}`, false);
  }

  private expectLabel(step: Extract<Step, { op: "expectLabel" }>, stepNo: number): void {
    const open = this.need(stepNo, step, step.by);
    const hits = open.prompt.options.filter((option) => this.optionMatches(option, step.option));
    if (hits.length !== 1) {
      this.fail(stepNo, step, `${hits.length === 0 ? "No option matches" : `${hits.length} options match`} ${JSON.stringify(step.option)}.\nOffered:\n${this.describeOptions(open.prompt.options)}`, false);
    }
    if (!hits[0].label.toLowerCase().includes(step.text.toLowerCase())) {
      this.fail(stepNo, step, `The label of option ${hits[0].id} is "${hits[0].label}", expected it to contain "${step.text}".`, false);
    }
  }

  /** Every seat view in one string: a change in the duel state or in the open prompt changes it. */
  private fingerprint(): string {
    return JSON.stringify(this.seats.map((seat) => this.game.view(seat)));
  }

  private expectRetry(step: Extract<Step, { op: "expectRetry" }>, stepNo: number): void {
    const open = this.need(stepNo, step, step.by);
    const sender = step.as ? seatOf(step.as) : open.seat;
    const before = this.fingerprint();
    let refused: Error | null = null;
    try {
      this.game.answer(sender, open.prompt.id, step.answer);
    } catch (error) {
      refused = error as Error;
    }
    if (!refused) this.fail(stepNo, step, `The engine took the answer ${JSON.stringify(step.answer)} from p${sender}. It must refuse it.`);
    if (!(refused instanceof EngineAnswerError)) {
      this.fail(stepNo, step, `The answer failed with ${refused.name}: ${refused.message}. A refused answer is an EngineAnswerError.`, false);
    }
    if (step.error && !refused.message.includes(step.error)) {
      this.fail(stepNo, step, `The error is "${refused.message}", expected it to contain "${step.error}".`);
    }
    if (step.code !== undefined && refused.code !== step.code) {
      this.fail(stepNo, step, `The error code is "${refused.code}", expected "${step.code}".`);
    }
    // A Lua script error is a bug in a card script, not a refused answer: it passes only when the step names that error.
    if (isLuaScriptError(refused.message) && !(step.error && isLuaScriptError(step.error))) {
      this.fail(stepNo, step, `The refusal is a Lua script error ("${refused.message}"), not a refused answer. Fix the script, or name the script error in the step.`);
    }
    if (this.fingerprint() !== before) {
      this.fail(stepNo, step, `The engine refused the answer ("${refused.message}") but the state of the duel changed.`);
    }
    const after = this.openPrompt();
    if (!after || after.seat !== open.seat || after.prompt.id !== open.prompt.id) {
      this.fail(stepNo, step, `The engine refused the answer ("${refused.message}") but the open prompt is not the same one any more.`);
    }
  }

  private expectResult(step: Extract<Step, { op: "expectResult" }>, stepNo: number): void {
    const view = this.game.view(0);
    const result = view.result;
    if (!result) this.fail(stepNo, step, "The duel is not over.", false);
    const teamOf = (seat: number) => teamOfSeat(this.format, seat);
    const winnerTeam = result.winnerTeam !== undefined ? result.winnerTeam : result.winnerSeat == null ? null : teamOf(result.winnerSeat);
    if (step.winner !== undefined) {
      const winner = result.winnerSeat == null ? null : (`p${result.winnerSeat}` as DuelistId);
      // In Tag the view names the lowest seat of the winning team. Any seat of that team matches.
      const sameTeam = step.winner != null && winnerTeam != null && this.format === "tag" && teamOf(seatOf(step.winner)) === winnerTeam;
      if (winner !== step.winner && !sameTeam) this.fail(stepNo, step, `Winner is ${winner}, expected ${step.winner}.`, false);
    }
    if (step.team !== undefined && winnerTeam !== step.team) {
      this.fail(stepNo, step, `Winning team is ${winnerTeam}, expected ${step.team}.`, false);
    }
    if (step.reason && !result.reason.toLowerCase().includes(step.reason.toLowerCase())) {
      this.fail(stepNo, step, `Result reason is "${result.reason}", expected it to contain "${step.reason}".`, false);
    }
  }

  /** The listed seats are eliminated and every other seat is still in the duel. */
  private expectEliminated(step: Extract<Step, { op: "expectEliminated" }>, stepNo: number): void {
    const want = new Set(step.seats.map(seatOf));
    const view = this.game.view(0);
    const problems: string[] = [];
    for (const seat of this.seats) {
      const gone = view.seats[seat]?.eliminated === true;
      if (want.has(seat) && !gone) problems.push(`p${seat} is not eliminated`);
      if (!want.has(seat) && gone) problems.push(`p${seat} is eliminated`);
    }
    for (const seat of want) if (seat >= this.seatCount) problems.push(`p${seat} is not a seat of format "${this.format}"`);
    if (problems.length > 0) this.fail(stepNo, step, `Elimination differs: ${problems.join("; ")}.`, false);
  }

  private expectLp(step: Extract<Step, { op: "expectLp" }>, stepNo: number): void {
    const view = this.game.view(0);
    if ("seat" in step.who) {
      const seat = seatOf(step.who.seat);
      const lp = view.seats[seat]?.lp;
      if (lp !== step.value) this.fail(stepNo, step, `${step.who.seat}.lp: expected ${step.value}, got ${lp}.`, false);
      return;
    }
    const team = step.who.team;
    const members = this.seats.filter((seat) => teamOfSeat(this.format, seat) === team);
    if (members.length === 0) this.fail(stepNo, step, `Format "${this.format}" has no team ${team}.`, false);
    const wrong = members.filter((seat) => view.seats[seat]?.lp !== step.value);
    if (wrong.length > 0) {
      this.fail(stepNo, step, `Team ${team} LP: expected ${step.value}, got ${members.map((seat) => `p${seat}=${view.seats[seat]?.lp}`).join(", ")}.`, false);
    }
  }

  /**
   * The seats that got a chain-response prompt since the last expectResponseOrder (or the start), in order.
   * A chain prompt that is open now counts as the last one.
   */
  private expectResponseOrder(step: Extract<Step, { op: "expectResponseOrder" }>, stepNo: number): void {
    const got = this.responses.slice(this.responseCursor);
    const open = this.openPrompt();
    if (open?.prompt.context?.type === "chain") got.push(open.seat);
    this.responseCursor = this.responses.length;
    const want = step.seats.map(seatOf);
    if (JSON.stringify(got) !== JSON.stringify(want)) {
      this.fail(stepNo, step, `Chain-response order differs.\n  expected: ${want.map((s) => `p${s}`).join(" -> ") || "(none)"}\n  actual:   ${got.map((s) => `p${s}`).join(" -> ") || "(none)"}`, false);
    }
  }

  /** Materials are picked one at a time (select/unselect prompts). Finish when the prompt still waits. */
  private selectToggle(step: Step, stepNo: number, sels: CardSel[], first: { seat: number; prompt: DuelPrompt }): void {
    let open: { seat: number; prompt: DuelPrompt } | null = first;
    const used = new Set<string>();
    for (const sel of sels) {
      if (!open || open.prompt.kind !== "toggle") {
        this.fail(stepNo, step, `The prompt closed before ${describeSel(sel)} could be selected.`, true);
      }
      const hits = open.prompt.options.filter((o) => o.id.startsWith("select:") && !used.has(`${o.card?.code}:${o.controller}:${o.location}:${o.sequence}`) && this.matchesSel(o, sel));
      const pick = this.pickOne(stepNo, step, hits, sel, "selection");
      used.add(`${pick.card?.code}:${pick.controller}:${pick.location}:${pick.sequence}`);
      this.send(stepNo, step, open, { choice: pick.id });
      open = this.openPrompt();
    }
    if (open && open.prompt.kind === "toggle" && open.prompt.finishable) this.send(stepNo, step, open, { finish: true });
  }

  private action(step: Step, stepNo: number, kind: ActionKind | "set", sel: CardSel, by: DuelistId | undefined): void {
    const open = this.need(stepNo, step, by);
    const prefixes = kind === "set" ? ["mset:", "sset:"] : ACTION_PREFIX[kind];
    const hits = this.candidates(open.prompt, prefixes, sel);
    const pick = this.pickOne(stepNo, step, hits, sel, kind);
    this.send(stepNo, step, open, { choice: pick.id });
  }

  private phase(step: Extract<Step, { op: "phase" }>, stepNo: number): void {
    const open = this.need(stepNo, step, step.by);
    const ids = open.prompt.options.map((o) => o.id);
    const want =
      step.to === "battle" ? "to_bp" : step.to === "main2" ? "to_m2" : "to_ep";
    if (!ids.includes(want)) this.fail(stepNo, step, `Phase change "${step.to}" (${want}) is not offered.`);
    this.send(stepNo, step, open, { choice: want });
  }

  private attack(step: Extract<Step, { op: "attack" }>, stepNo: number): void {
    let open = this.need(stepNo, step, step.by);
    if (open.prompt.options.some((o) => o.id === "to_bp") && !open.prompt.options.some((o) => o.id.startsWith("attack:"))) {
      this.send(stepNo, step, open, { choice: "to_bp" });
      open = this.need(stepNo, step, step.by);
    }
    const hits = this.candidates(open.prompt, ["attack:"], step.attacker);
    const pick = this.pickOne(stepNo, step, hits, step.attacker, "attack with");
    const direct = /directly/i.test(pick.label);
    if (step.target === "direct" && !direct) {
      this.fail(stepNo, step, `Expected a direct attack, but "${pick.label}" is not direct (the opponent has attack targets).`);
    }
    // An attacker that has monster targets AND a direct attack (N-seat: another opponent has no monster) is labelled "directly".
    // The core then asks "Attack directly?": a target attack answers no. Without that question the attack is purely direct.
    this.send(stepNo, step, open, { choice: pick.id });
    if (step.target === "direct") return;
    let next = this.openPrompt();
    if (next?.prompt.kind === "choice" && /attack target/i.test(next.prompt.title)) {
      // The combined pick conceals face-down identities. Scenarios name their fixture cards;
      // use the controller's private board only to match that name to the offered public zone.
      const targets = next.prompt.options.filter(option => option.location === 4).map(option => {
        if (option.card || option.controller == null || option.sequence == null) return option;
        const code = this.game.view(option.controller).seats[option.controller]?.monsters[option.sequence]?.code;
        return code ? { ...option, card: loadCardDatabase(engineDataDirectory).get(code) ?? undefined } : option;
      }).filter(option => this.matchesSel(option, step.target as CardSel));
      const target = this.pickOne(stepNo, step, targets, step.target as CardSel, "attack target");
      this.send(stepNo, step, next, { choice: target.id });
      return;
    }
    if (direct) {
      const question = next && next.prompt.kind === "choice" && /attack directly/i.test(next.prompt.title) ? next : null;
      if (!question) this.fail(stepNo, step, `Expected an attack on ${describeSel(step.target)}, but the attack is direct.`);
      this.send(stepNo, step, question, { choice: "no" });
      next = this.openPrompt();
    }
    if (next && next.prompt.kind === "cards" && /attack target/i.test(next.prompt.title)) {
      const targets = next.prompt.options.filter((o) => this.matchesSel(o, step.target as CardSel));
      const target = this.pickOne(stepNo, step, targets, step.target as CardSel, "attack target");
      this.send(stepNo, step, next, { selected: [target.id] });
    } else {
      // One legal target: the engine picks it. Check it is the expected one.
      const events = this.events().filter((e) => e.kind === "attack");
      const last = events[events.length - 1];
      const want = codeOf(selCard(step.target as CardSel));
      const view = this.game.view(0);
      const at = last?.target;
      const hit = at && view.seats[at.controller]?.monsters[at.sequence];
      if (hit && hit.code != null && hit.code !== want) {
        this.fail(stepNo, step, `The only legal attack target was ${cardLabel(hit.code)}, not ${cardLabel(want)}.`, false);
      }
    }
  }

  // Expectations ------------------------------------------------------------------------------
  /** Events of both views, merged by id. The view that shows the card wins. */
  private events(): DuelEvent[] {
    const merged = new Map<number, DuelEvent>();
    for (const seat of this.seats) {
      for (const event of this.game.view(seat).events) {
        const old = merged.get(event.id);
        if (!old || (!old.card && event.card)) merged.set(event.id, event);
      }
    }
    return [...merged.values()].sort((a, b) => a.id - b.id);
  }

  private eventMatches(event: DuelEvent, match: EventMatch): boolean {
    if (event.kind !== match.kind) return false;
    if (match.card != null && event.card?.code !== codeOf(match.card)) return false;
    if (match.by && event.seat !== seatOf(match.by)) return false;
    const extra = event as DuelEvent & { summonKind?: string };
    if (match.summonKind && extra.summonKind !== match.summonKind) return false;
    if (match.cause && event.cause !== match.cause) return false;
    if (match.amount != null && event.amount !== match.amount) return false;
    if (match.text && !event.text.includes(match.text)) return false;
    return true;
  }

  private expectEvents(step: Extract<Step, { op: "expectEvents" }>, stepNo: number): void {
    const events = this.events();
    let cursor = 0;
    for (const [index, match] of step.events.entries()) {
      const at = events.findIndex((event, i) => i >= cursor && this.eventMatches(event, match));
      if (at < 0) {
        const recent = events.slice(-25).map((e) => `  #${e.id} ${e.kind}${e.card ? ` ${e.card.name}` : ""}${e.seat != null ? ` p${e.seat}` : ""} "${e.text}"`);
        this.fail(
          stepNo, step,
          `Event ${index + 1} of ${step.events.length} did not happen in order: ${JSON.stringify(match)}.\nLast events:\n${recent.join("\n")}`,
          false,
        );
      }
      cursor = at + 1;
    }
  }

  private expectPrompt(step: Step, stepNo: number, want: PromptExpect): void {
    const open = this.need(stepNo, step, want.by);
    if (want.kind && open.prompt.kind !== want.kind) this.fail(stepNo, step, `Prompt kind is "${open.prompt.kind}", expected "${want.kind}".`);
    if (want.title && !open.prompt.title.includes(want.title)) this.fail(stepNo, step, `Prompt title does not contain "${want.title}".`);
    if (want.context && open.prompt.context?.type !== want.context) {
      this.fail(stepNo, step, `Prompt context is "${open.prompt.context?.type ?? "none"}", expected "${want.context}".`);
    }
    const ids = open.prompt.options.map((option) => option.id);
    for (const id of want.offers ?? []) if (!ids.includes(id)) this.fail(stepNo, step, `Option id "${id}" is not offered.`);
    for (const id of want.notOffers ?? []) if (ids.includes(id)) this.fail(stepNo, step, `Option id "${id}" is offered but must not be.`);
  }

  private expectBoard(step: Extract<Step, { op: "expectBoard" }>, stepNo: number): void {
    const problems: string[] = [];
    const board: BoardExpect = step.board;
    for (const id of DUELIST_IDS) {
      const want = board[id];
      if (!want) continue;
      if (seatOf(id) >= this.seatCount) {
        problems.push(`${id}: format "${this.format}" has no such seat`);
        continue;
      }
      this.checkDuelist(id, want, problems);
    }
    if (problems.length > 0) this.fail(stepNo, step, `Board differs:\n  ${problems.join("\n  ")}`, false);
  }

  private checkDuelist(id: DuelistId, want: DuelistExpect, problems: string[]): void {
    const state = this.seatState(id);
    if (want.lp != null && state.lp !== want.lp) problems.push(`${id}.lp: expected ${want.lp}, got ${state.lp}`);
    if (want.deckCount != null && state.deckCount !== want.deckCount) problems.push(`${id}.deckCount: expected ${want.deckCount}, got ${state.deckCount}`);
    const lists: Array<[string, ListExpect | undefined, DuelCard[]]> = [
      ["hand", want.hand, state.hand],
      ["grave", want.grave, state.graveyard],
      ["banished", want.banished, state.banished],
      ["extra", want.extra, state.extra],
      ["monsters", want.monsters, state.monsters.filter((c): c is DuelCard => c != null)],
      ["spells", want.spells, state.spells.filter((c): c is DuelCard => c != null)],
    ];
    for (const [name, expect, actual] of lists) {
      if (expect !== undefined) this.checkList(`${id}.${name}`, expect, actual, problems);
    }
    for (const [zoneName, expect] of Object.entries(want.zones ?? {}) as Array<[Zone, ZoneExpect]>) {
      const at = ZONES[zoneName];
      const card = at.location === 4 ? state.monsters[at.sequence] : state.spells[at.sequence];
      this.checkZone(`${id}.${zoneName}`, expect, card ?? null, problems);
    }
    if (want.deckMaster) {
      const dm = state.deckMaster;
      if (!dm) problems.push(`${id}.deckMaster: this duel has no Deck Master`);
      else {
        for (const key of ["inZone", "returns", "nextCost"] as const) {
          const expected = want.deckMaster[key];
          if (expected !== undefined && dm[key] !== expected) problems.push(`${id}.deckMaster.${key}: expected ${expected}, got ${dm[key]}`);
        }
      }
    }
  }

  private checkList(label: string, expect: ListExpect, actual: DuelCard[], problems: string[]): void {
    const codes = actual.map((card) => card.code);
    const show = (list: Array<number | undefined>) => `[${list.map((c) => cardLabel(c)).join(", ")}]`;
    if (Array.isArray(expect)) {
      const want = expect.map(codeOf).sort((a, b) => a - b);
      const got = codes.map((c) => c ?? -1).sort((a, b) => a - b);
      if (JSON.stringify(want) !== JSON.stringify(got)) problems.push(`${label}: expected exactly ${show(want)}, got ${show(codes)}`);
      return;
    }
    const pool = [...codes];
    for (const ref of expect.include ?? []) {
      const at = pool.indexOf(codeOf(ref));
      if (at < 0) problems.push(`${label}: expected to include ${cardLabel(codeOf(ref))}, got ${show(codes)}`);
      else pool.splice(at, 1);
    }
    for (const ref of expect.exclude ?? []) {
      if (codes.includes(codeOf(ref))) problems.push(`${label}: expected to exclude ${cardLabel(codeOf(ref))}, got ${show(codes)}`);
    }
    if (expect.count != null && codes.length !== expect.count) problems.push(`${label}: expected ${expect.count} card(s), got ${codes.length} ${show(codes)}`);
  }

  private checkZone(label: string, expect: ZoneExpect, card: DuelCard | null, problems: string[]): void {
    if (expect === null) {
      if (card) problems.push(`${label}: expected empty, got ${cardLabel(card.code)}`);
      return;
    }
    const ref = typeof expect === "object" ? expect.card : expect;
    const want = codeOf(ref);
    if (!card) {
      problems.push(`${label}: expected ${cardLabel(want)}, zone is empty`);
      return;
    }
    if (card.code !== want) problems.push(`${label}: expected ${cardLabel(want)}, got ${cardLabel(card.code)}`);
    if (typeof expect === "object") {
      if (expect.attack != null && card.attack !== expect.attack) {
        problems.push(`${label}: expected ATK ${expect.attack}, got ${card.attack}`);
      }
      if (expect.defense != null && card.defense !== expect.defense) {
        problems.push(`${label}: expected DEF ${expect.defense}, got ${card.defense}`);
      }
      if (expect.negated != null && (card.negated ?? false) !== expect.negated) {
        problems.push(`${label}: expected negated ${expect.negated}, got ${card.negated ?? false}`);
      }
      const faceDown = (card.position & (0x02 | 0x08)) !== 0;
      if (expect.pos === "atk" && card.position !== 0x01) problems.push(`${label}: expected face-up attack, position is ${card.position}`);
      if (expect.pos === "def" && card.position !== 0x04) problems.push(`${label}: expected face-up defense, position is ${card.position}`);
      if ((expect.pos === "set" || expect.pos === "facedown") && !faceDown) problems.push(`${label}: expected face-down, card is face-up`);
      if ((expect.pos === "up" || expect.pos === "faceup") && faceDown) problems.push(`${label}: expected face-up, card is face-down`);
      if (expect.materials != null && (card.materials?.length ?? 0) !== expect.materials) {
        problems.push(`${label}: expected ${expect.materials} material(s), got ${card.materials?.length ?? 0}`);
      }
      if (expect.counters != null) {
        const got = Object.fromEntries((card.counters ?? []).map((counter) => [counter.type, counter.count]));
        const want = Object.fromEntries(Object.entries(expect.counters).map(([type, count]) => [Number(type), count]));
        if (JSON.stringify(got) !== JSON.stringify(want)) problems.push(`${label}: expected counters ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
      }
    }
  }
}
