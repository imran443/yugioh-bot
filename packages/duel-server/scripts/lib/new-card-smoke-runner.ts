import type { DuelAnswer, DuelDeck, DuelFormat } from "@yugidraft/shared/duels";
import { seatCountFor } from "@yugidraft/shared/duels";
import { createEngineGame, type EngineGame } from "../../src/engine.js";
import { compileBoard, DUELIST_IDS, type CardEntry } from "../../src/presets/board.js";
import { resolveCard } from "../../src/presets/catalog.js";
import { type SmokeCase } from "./new-card-smoke-board.js";
import { SmokeBot } from "./new-card-smoke-bot.js";
import { InvariantChecker } from "../../tests/fuzz/invariants.js";
import { loadCatalog } from "../../tests/fuzz/card-pool.js";
import { engineSeed } from "../../tests/fuzz/rng.js";
import { NChecker, nStateHash, nViewsHash, type NViews } from "../../tests/fuzz-n/invariants.js";
import { newDiagnostics } from "../../tests/fuzz-n/driver.js";
import { hiddenSmokeViolations, SmokePrivacyEvidence } from "./new-card-smoke-privacy.js";
import { loadCardDatabase } from "../../src/cards.js";
import { SmokeEffectRecorder, smokeEffectScript, type SmokeEffect } from "./new-card-smoke-effects.js";
import { fillPlaceholders } from "../../src/text.js";

export interface SmokeCaseResult {
  id: string; seed: number; steps: number; offered: string[]; activated: string[];
  replayed: boolean; failure?: string; core?: { wasmFile: string; wasmSha: string };
  expected?: SmokeEffect[];
  timeoutRetried?: boolean;
}
export interface SmokeLimits { maxSteps?: number; maxTurns?: number }
const detail = (error: unknown) => error instanceof Error ? `${error.name}: ${error.message}` : String(error);

export function compileSmokeCase(test: SmokeCase, directory: string) {
  const compiled = compileBoard({ ...test.board, monstersAsContinuousSpells: true }, directory);
  return { ...compiled, options: { ...compiled.options, beforeCardsScripts: [{ name: "smoke-effects.lua", content: smokeEffectScript(test.code, loadCardDatabase(directory).get(test.code)?.canonicalPasscode) }] } };
}

/** Debug.AddCard adds cards beside the decks. Include those cards in the invariant checker's inventory. */
function inventory(test: SmokeCase, decks: DuelDeck[], directory: string): DuelDeck[] {
  return decks.map((deck, seat) => {
    const setup = test.board[DUELIST_IDS[seat]!]!;
    const entries: CardEntry[] = [...setup.hand ?? [], ...setup.monsters ?? [], ...setup.spells ?? [],
      ...(setup.field ? [setup.field] : []), ...setup.pendulum ?? [], ...setup.grave ?? [], ...setup.banished ?? []].filter((e): e is CardEntry => e != null);
    const placed = entries.flatMap(entry => typeof entry === "object" ? [entry.card, ...entry.materials ?? []] : [entry]);
    return { ...deck, main: [...deck.main, ...placed.map(ref => resolveCard(ref, directory))] };
  });
}

function countCards(views: NViews): number {
  let total = 0;
  views.seats.forEach((view, seat) => {
    const own = view.seats[seat]!;
    total += own.deckCount + (own.deckMaster?.inZone ? 1 : 0);
    for (const card of [...own.hand, ...own.monsters, ...own.spells, ...own.graveyard, ...own.banished, ...own.extra]) {
      if (!card) continue;
      if (!(card.type! & 0x4000)) total++;
      total += (card.materials ?? []).filter(m => !(m.type! & 0x4000)).length;
    }
  });
  return total;
}

/** One short real-core duel and a full replay of its accepted answer prefix. Run this inside a watchdog process. */
export async function runSmokeCase(test: SmokeCase, directory: string, limits: SmokeLimits = {}): Promise<SmokeCaseResult> {
  const result: SmokeCaseResult = { id: test.id, seed: test.seed, steps: 0, offered: [], activated: [], replayed: false };
  const scriptErrors: string[] = [];
  const cards = loadCardDatabase(directory);
  const effects = new SmokeEffectRecorder(test.code, cards);
  const privacy = new SmokePrivacyEvidence();
  let game: EngineGame | undefined;
  let replay: EngineGame | undefined;
  const bot = new SmokeBot(test.code, (test.seed ^ test.code) >>> 0);
  try {
    const compiled = compileSmokeCase(test, directory);
    const options = { ...compiled.options, dataDirectory: directory, seed: engineSeed(test.seed), scriptErrorMode: "strict" as const,
      onDebugMessage: (text: string) => effects.debug(text),
      onCoreMessage: (message: Parameters<SmokePrivacyEvidence["observe"]>[0]) => privacy.observe(message),
      onScriptError: (e: { message: string }) => scriptErrors.push(`Lua script error: ${e.message}`),
      onFatalScriptError: (e: { message: string }) => scriptErrors.push(`Fatal Lua script error: ${e.message}`) };
    game = await createEngineGame(options);
    const info = game.coreInfo(); result.core = { wasmFile: info.wasmFile, wasmSha: info.wasmSha };
    const n = seatCountFor(test.format);
    const read = (g: EngineGame): NViews => ({ seats: Array.from({ length: n }, (_, seat) => g.view(seat)), spectator: g.view(null) });
    const expectedDecks = inventory(test, compiled.options.decks, directory);
    const expectedCount = expectedDecks.reduce((sum, d) => sum + d.main.length + d.extra.length + (d.deckMaster ? 1 : 0), 0);
    const checker = new NChecker(test.format);
    let previousDiagnostics = game.diagnostics();
    const printed = new Map<number, string[]>();
    const twoChecker = n === 2 ? new InvariantChecker({ mode: test.mode, decks: expectedDecks as [DuelDeck, DuelDeck], disjoint: false, catalog: loadCatalog(directory), printedText: code => {
      let text = printed.get(code);
      if (!text) {
        const card = cards.get(code);
        const effects = Array.from({ length: 16 }, (_, index) => fillPlaceholders(cards.resolveLabel((BigInt(code) << 20n) + BigInt(index)), [card?.name]));
        text = [card?.description ?? "", ...effects, ...effects.map(effect => `${card?.name}: ${effect}`)].filter(Boolean);
        printed.set(code, text);
      }
      return text;
    } }) : undefined;
    const check = (views: NViews, step: number) => {
      effects.observe(views.seats[0]!.events, (effect, completed, choices) => bot.resolved(effect, completed, choices));
      if (scriptErrors.length) throw new Error(scriptErrors.join("; "));
      const hidden = hiddenSmokeViolations(views, privacy);
      if (hidden.length) throw new Error(hidden[0]);
      // The core removes Xyz materials before SELECT_PLACE/SELECT_POSITION, then attaches them at SUMMONED.
      // Its query API cannot expose that transient inventory. Check counts again after the placement answer.
      const placing = views.seats.some(v => v.prompt?.kind === "places" || v.prompt?.context?.type === "position");
      const diagnostics = game!.diagnostics();
      const violations = checker.check(step, views, newDiagnostics(previousDiagnostics, diagnostics));
      previousDiagnostics = diagnostics;
      if (twoChecker) violations.push(...twoChecker.check(step, { v0: views.seats[0]!, v1: views.seats[1]!, vs: views.spectator })
        .filter(v => !(placing && v.invariant.startsWith("conservation"))).map(v => ({ ...v, step })));
      if (!placing && countCards(views) !== expectedCount) throw new Error(`card conservation: ${countCards(views)} cards, expected ${expectedCount}`);
      for (const seat of views.spectator.seats) if (!Number.isSafeInteger(seat.lp)) throw new Error(`integer LP: seat ${seat.seat} has ${seat.lp}`);
      if (violations.length) throw new Error(`${violations[0]!.invariant}: ${violations[0]!.message}`);
    };
    let views = read(game); check(views, 0);
    const hashes = [nViewsHash(views)];
    const journal: Array<{ seat: number; prompt: string; answer: DuelAnswer }> = [];
    const seen = new Map<string, number>();
    const maxSteps = limits.maxSteps ?? 120 * n;
    const maxTurns = limits.maxTurns ?? n + 1;
    for (let step = 0; step < maxSteps; step++) {
      if (views.spectator.result) break;
      const seat = views.seats.findIndex(v => v.prompt);
      if (seat < 0) throw new Error("engine stall: no prompt and no result");
      const prompt = views.seats[seat]!.prompt!;
      // Only stop outside an effect/chain; the last activation must finish resolving.
      if (views.spectator.turn > maxTurns && prompt.context?.type === "action" && !views.spectator.chain.length) break;
      const permitted = prompt.kind === "announce-card" ? game.searchCards("") : undefined;
      const answer = bot.answer(prompt, views.seats[seat], permitted);
      game.answer(seat, prompt.id, answer);
      journal.push({ seat, prompt: prompt.id, answer }); result.steps++;
      views = read(game); check(views, result.steps); hashes.push(nViewsHash(views));
      const hash = nStateHash(views), count = (seen.get(hash) ?? 0) + 1;
      seen.set(hash, count);
      if (count > 12) throw new Error(`engine loop: the same state repeated ${count} times`);
    }
    if (result.steps === maxSteps && !views.spectator.result) throw new Error(`engine stall: ${maxSteps}-answer limit reached (turn ${views.spectator.turn}, phase ${views.spectator.phase})`);
    replay = await createEngineGame({ ...options, onDebugMessage: undefined, onCoreMessage: undefined });
    if (nViewsHash(read(replay)) !== hashes[0]) throw new Error("replay determinism: opening state differs");
    for (const [step, entry] of journal.entries()) {
      const prompt = replay.view(entry.seat).prompt;
      if (!prompt || prompt.id !== entry.prompt) throw new Error(`replay determinism: prompt differs at answer ${step}`);
      replay.answer(entry.seat, prompt.id, entry.answer);
      if (nViewsHash(read(replay)) !== hashes[step + 1]) throw new Error(`replay determinism: state differs at answer ${step + 1}`);
      if (scriptErrors.length) throw new Error(scriptErrors.join("; "));
    }
    result.replayed = true;
  } catch (error) { result.failure = scriptErrors.length ? scriptErrors.join("; ") : detail(error); }
  finally {
    result.offered = [...bot.offered].sort(); result.activated = [...bot.activated].sort();
    result.expected = [...effects.expected.values()];
    try { game?.close(); } catch (error) { result.failure ??= `host close: ${detail(error)}`; }
    try { replay?.close(); } catch (error) { result.failure ??= `host replay close: ${detail(error)}`; }
  }
  return result;
}
