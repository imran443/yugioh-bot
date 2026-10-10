import { scriptErrorCoreFactory } from "../script-load-scope.js"; // LEGACY-1V1: distinguish load failures from runtime errors
import { EngineLoopError } from "../engine-loop-error.js"; // LEGACY-1V1: shared core loop invariant
import { CARD_SCRIPT_ERROR_TEXT, CORE_PROCESS_CALL_LIMIT, createScriptErrorPolicy, type DuelScriptError, type DuelScriptFatalError } from "../script-errors.js"; // LEGACY-1V1: owner runtime script-error policy
// LEGACY 1V1 ENGINE. A copy of packages/duel-server/src/engine.ts from main (commit 2a5a959), the engine that ran one-against-one
// duels in production before the n-seat work. It runs when DUEL_1V1_ENGINE=legacy (the default) for tables with two seats.
// Do not "fix" or tidy this file, ./views.ts or ./prompts.ts: they must stay equal to main. Every line that differs from main is
// marked "LEGACY-1V1:". See packages/duel-server/legacy-1v1/README.md.
import { ChainOptions } from "../chain-options.js"; // LEGACY-1V1: public chosen chain options
import { DIAGNOSTICS_LIMIT, type EngineDiagnostic } from "../engine.js"; // LEGACY-1V1: private display error diagnostics
import type { DuelAnswer, DuelBattleStep, DuelChainMode, DuelCardInfo, DuelDeck, DuelEngineView, DuelMasterRule, DuelMode, DuelSettings, DuelScriptErrorMode } from "@yugidraft/shared/duels";
import { defaultChainMode } from "@yugidraft/shared/duels"; // LEGACY-1V1: chain response mode (Auto, Always, Off)
import { firstTurnDrawFor } from "../first-turn-draw.js"; // LEGACY-1V1: owner draw rule and saved replay overrides
import { legacyNormalScript } from "./script-compat.js"; // LEGACY-1V1: current Lua bundle on the unchanged npm core
import createCore, {
  OcgDuelMode,
  OcgHintType,
  OcgLocation,
  OcgMessageType,
  OcgPosition,
  OcgProcessResult,
  OcgType,
  cardMatchesOpcode,
  type OcgCardData,
  type OcgCoreSync,
  type OcgDuelHandle,
  type OcgMessage,
  type OcgResponse, // LEGACY-1V1: public chosen chain options
  type OcgOpCode,
} from "ocgcore-wasm";
import { isOptionalCardScript, loadCardDatabase, type CardDatabase } from "../cards.js";
import { EngineAnswerError, autoResponse, isWaitingMessage, mapPrompt, recallPromptContext, resolveAnswer, type MapPromptExtras, type PendingPrompt } from "./prompts.js";
import {
  DOMAIN_RECALL_DESC,
  LOCATION_DECKMASTER,
  clearRevealsAt,
  confirmationAudience,
  CHAIN_TARGET_NOTE_SCRIPT,
  createEventContext,
  createRevealMap,
  DESTROY_NOTE_SCRIPT,
  drainDeferredDestroys,
  moveReveals,
  nextBattleStep,
  linkTargetPhrase,
  nameLinkTargets,
  noteChainTargetLog,
  noteDestroyLog,
  noteReveal,
  noteTargetCardLog,
  observeChainTargetEvents,
  observeDuelEvent,
  observeMoveEvents,
  observeConfirmEvents,
  phaseName,
  projectView,
  resetEventBatch,
  targetEventText,
  type DomainSeatState,
  type LogEntry,
  type StoredChainLink,
  type StoredDuelEvent,
} from "./views.js";
import { createDomainCore } from "../domain-core.js";
import { fillPlaceholders } from "../text.js";
import { destroyedAndBanishedLogText, destroyedLogText, moveLogLines, summonLogLines } from "../log-lines.js";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// LEGACY-1V1: the wrapper parses messages and queries the way main's wrapper patch did (see patches/ocgcore-wasm+0.1.2.patch).
const legacyCreateCore = ((coreOptions: object) => createCore({ ...coreOptions, legacyMessages: true } as never)) as unknown as typeof createCore;

// LEGACY-1V1: main's Domain core and domain.lua sit next to the merged ones in the data directory.
export const LEGACY_DOMAIN_WASM_FILE = "ocgcore.domain.legacy.wasm";
export const LEGACY_DOMAIN_LUA_FILE = "domain.legacy.lua";

function legacyDomainWasm(dataDirectory: string): Uint8Array {
  const path = join(dataDirectory, LEGACY_DOMAIN_WASM_FILE);
  if (!existsSync(path)) {
    throw new Error(
      `Legacy Domain wasm is missing at ${path}. Run npm run duel:prepare (or build it with packages/duel-server/legacy-1v1/scripts/build-domain-core.sh in docker.io/emscripten/emsdk:4.0.9)`,
    );
  }
  return new Uint8Array(readFileSync(path));
}

export interface EngineGameOptions {
  scriptErrorMode?: DuelScriptErrorMode;
  /** Private telemetry callback; omitted by standalone replay tools. */
  onScriptError?: (error: DuelScriptError) => void; // LEGACY-1V1: shared owner policy
  onFatalScriptError?: (error: DuelScriptFatalError) => void; // LEGACY-1V1: host-only fatal diagnostics
  startupScripts?: Array<{ name: string; content: string }>; // LEGACY-1V1: board fixtures for recovery tests
  mode: DuelMode;
  decks: DuelDeck[];
  seed: string[];
  dataDirectory: string;
  masterRule?: DuelMasterRule;
  settings?: DuelSettings;
  firstTurnDraw?: boolean; // LEGACY-1V1: saved rule wins over the current 1v1 default
}

export interface EngineGame {
  diagnostics(): EngineDiagnostic[]; // LEGACY-1V1: private display error diagnostics
  view(seat: number | null): DuelEngineView;
  answer(seat: number, promptId: string, answer: DuelAnswer): void;
  searchCards(query: string): DuelCardInfo[];
  /** LEGACY-1V1: set a seat's chain response mode; true when it passed the open window. See ../engine.ts EngineGame.setChainMode. */
  setChainMode(seat: number, mode: DuelChainMode): boolean;
  close(): void;
}

export type DomainCoreFactory = (ctx: {
  createStockCore: typeof createCore;
  dataDirectory: string;
  seed: [bigint, bigint, bigint, bigint];
  decks: DuelDeck[];
  flags: bigint;
  team1: { startingLP: number; startingDrawCount: number; drawCountPerTurn: number };
  team2: { startingLP: number; startingDrawCount: number; drawCountPerTurn: number };
  cardReader: (code: number) => OcgCardData | null;
  scriptReader: (name: string) => string | null;
  errorHandler: (type: number, text: string) => void;
  wasmBinary?: Uint8Array;
}) => Promise<{
  lib: OcgCoreSync;
  handle: OcgDuelHandle;
  getDomainState: () => DomainSeatState[];
}>;

let domainCoreFactory: DomainCoreFactory | null = null;

export function registerDomainCoreFactory(factory: DomainCoreFactory): void {
  domainCoreFactory = factory;
}
registerDomainCoreFactory(createDomainCore);

export function parseSeed(seed: string[]): [bigint, bigint, bigint, bigint] {
  if (seed.length !== 4) throw new Error("Seed must be exactly 4 nonzero decimal uint64 strings");
  const values = seed.map((part) => {
    if (!/^[0-9]+$/.test(part)) throw new Error("Seed must be exactly 4 nonzero decimal uint64 strings");
    const value = BigInt(part);
    if (value === 0n || value > 0xffffffffffffffffn) throw new Error("Seed must be exactly 4 nonzero decimal uint64 strings");
    return value;
  });
  return values as [bigint, bigint, bigint, bigint];
}

const MASTER_RULE_FLAGS: Record<DuelMasterRule, bigint> = {
  1: OcgDuelMode.MODE_MR1,
  2: OcgDuelMode.MODE_MR2,
  3: OcgDuelMode.MODE_MR3,
  4: OcgDuelMode.MODE_MR4,
  5: OcgDuelMode.MODE_MR5,
};

function duelFlagsFor(masterRule?: DuelMasterRule): bigint {
  const rule = masterRule ?? 5;
  if (rule !== 1 && rule !== 2 && rule !== 3 && rule !== 4 && rule !== 5) {
    throw new Error(`Unknown master rule ${String(rule)}`);
  }
  return MASTER_RULE_FLAGS[rule];
}

function engineStartConfig(settings?: DuelSettings): {
  startingLP: number;
  startingDrawCount: number;
  drawCountPerTurn: number;
  shuffle: boolean;
} {
  return {
    startingLP: settings?.startingLP ?? 8000,
    startingDrawCount: settings?.startingHand ?? 5,
    drawCountPerTurn: settings?.drawPerTurn ?? 1,
    shuffle: settings?.shuffleDeck ?? true,
  };
}

function addDeck(lib: OcgCoreSync, handle: OcgDuelHandle, team: 0 | 1, deck: DuelDeck, importedOrder: boolean) {
  // sequence 0 push_back: last added card is deck top (drawn first). Reverse so imported[0] is top.
  const main = importedOrder ? [...deck.main].reverse() : deck.main;
  for (const code of main) {
    lib.duelNewCard(handle, {
      team,
      duelist: 0,
      code,
      controller: team,
      location: OcgLocation.DECK,
      sequence: 0,
      position: OcgPosition.FACEDOWN_DEFENSE,
    });
  }
  for (const code of deck.extra) {
    lib.duelNewCard(handle, {
      team,
      duelist: 0,
      code,
      controller: team,
      location: OcgLocation.EXTRA,
      sequence: 0,
      position: OcgPosition.FACEDOWN_DEFENSE,
    });
  }
}

/**
 * A Pendulum Summon is offered as the Special Summon action of a card in a Pendulum Zone
 * (Spell & Trap sequence 6-7, or the LOCATION_PZONE flag). The summons it produces are then "pendulum".
 */
export function isPendulumSummonAnswer(pending: PendingPrompt, answer: DuelAnswer): boolean {
  if (pending.message.type !== OcgMessageType.SELECT_IDLECMD || !answer.choice?.startsWith("spsummon:")) return false;
  const option = pending.prompt.options.find((entry) => entry.id === answer.choice);
  if (!option || option.location == null) return false;
  if ((option.location & OcgLocation.PZONE) !== 0) return true;
  return option.location === OcgLocation.SZONE && (option.sequence ?? 0) >= 6;
}

function loadScriptOrThrow(lib: OcgCoreSync, handle: OcgDuelHandle, cards: CardDatabase, name: string) {
  const content = cards.readScript(name);
  if (!content) throw new Error(`Required script missing: ${name}`);
  if (!lib.loadScript(handle, name, content)) throw new Error(`Failed to load script ${name}`);
}

export async function createEngineGame(options: EngineGameOptions): Promise<EngineGame> {
  if (options.decks.length !== 2) throw new Error("Exactly two decks are required");
  const start = engineStartConfig(options.settings);
  // LEGACY-1V1: Domain skips the turn-1 draw at every Master Rule; preserve saved rules on replay.
  const firstTurnDraw = options.firstTurnDraw ?? firstTurnDrawFor(options.mode, options.masterRule);
  const flags = (duelFlagsFor(options.masterRule) & ~OcgDuelMode.FIRST_TURN_DRAW)
    | (firstTurnDraw ? OcgDuelMode.FIRST_TURN_DRAW : 0n);
  const seed = parseSeed(options.seed);
  const cards = loadCardDatabase(options.dataDirectory);
  const scriptErrors = createScriptErrorPolicy({ ...options, engine: "legacy" }); // LEGACY-1V1: owner policy
  const errors = scriptErrors.errors;
  let scriptErrorEventSent = false; // LEGACY-1V1: coalesce runtime errors per answer
  const scopedCreateCore = scriptErrorCoreFactory(legacyCreateCore, scriptErrors);
  const eventContext = createEventContext();
  const cardReader = (code: number) => {
    if (!code) return null;
    return cards.cardData(code);
  };
  const scriptReader = (name: string) => {
    const content = options.mode === "normal" ? legacyNormalScript(name, cards.readScript(name)) : cards.readScript(name); // LEGACY-1V1
    if (!content && !isOptionalCardScript(name, cards.cardData)) errors.push(`Missing script ${name}`);
    return content;
  };
  const errorHandler = (type: number, text: string) => {
    if (noteDestroyLog(eventContext, text) || noteChainTargetLog(eventContext, text) || noteTargetCardLog(eventContext, text)) return;
    scriptErrors.note(type, text); // LEGACY-1V1: runtime card failures may continue
  };
  const team = {
    startingLP: start.startingLP,
    startingDrawCount: start.startingDrawCount,
    drawCountPerTurn: start.drawCountPerTurn,
  };

  let lib: OcgCoreSync;
  let handle: OcgDuelHandle;
  let getDomainState: (() => DomainSeatState[]) | undefined;

  if (options.mode === "domain") {
    if (!domainCoreFactory) throw new Error("Domain core is not registered");
    const created = await domainCoreFactory({
      createStockCore: scopedCreateCore, // LEGACY-1V1
      dataDirectory: options.dataDirectory,
      seed,
      decks: options.decks,
      flags,
      team1: team,
      team2: team,
      cardReader,
      scriptReader,
      errorHandler,
      wasmBinary: legacyDomainWasm(options.dataDirectory), // LEGACY-1V1
    });
    lib = created.lib;
    handle = created.handle;
    if (!created.getDomainState) throw new Error("Domain core did not provide getDomainState");
    getDomainState = created.getDomainState;
  } else {
    lib = await scopedCreateCore({ sync: true }); // LEGACY-1V1: the npm package core, no wasmBinary
    const created = lib.createDuel({
      flags,
      seed,
      team1: team,
      team2: team,
      cardReader,
      scriptReader,
      errorHandler,
    });
    if (!created) throw new Error("Failed to create duel");
    handle = created;
  }

  try {
    loadScriptOrThrow(lib, handle, cards, "constant.lua");
    loadScriptOrThrow(lib, handle, cards, "utility.lua");
    if (!lib.loadScript(handle, "duel-events.lua", DESTROY_NOTE_SCRIPT)) throw new Error("Failed to register destruction reporter");
    if (!lib.loadScript(handle, "chain-target-notes.lua", CHAIN_TARGET_NOTE_SCRIPT)) throw new Error("Failed to register chain target reporter");
    if (options.mode === "domain") {
      // LEGACY-1V1: main's domain.lua, kept as domain.legacy.lua (loaded under the name domain.lua).
      const legacyLua = cards.readScript(LEGACY_DOMAIN_LUA_FILE);
      if (!legacyLua) throw new Error(`Required script missing: ${LEGACY_DOMAIN_LUA_FILE}`);
      if (!lib.loadScript(handle, "domain.lua", legacyLua)) throw new Error("Failed to load script domain.lua");
      // Card creation runs initial_effect; procedure libraries must be loaded first.
      for (const teamSeat of [0, 1] as const) {
        const code = options.decks[teamSeat].deckMaster;
        if (!code) throw new Error(`Seat ${teamSeat} is missing a Deck Master`);
        lib.duelNewCard(handle, {
          team: teamSeat,
          duelist: 0,
          code,
          controller: teamSeat,
          location: LOCATION_DECKMASTER as OcgLocation,
          sequence: 0,
          position: OcgPosition.FACEUP_ATTACK,
        });
      }
    }
    addDeck(lib, handle, 0, options.decks[0], !start.shuffle);
    addDeck(lib, handle, 1, options.decks[1], !start.shuffle);
    // Opening shuffle is only this EVENT_STARTUP ShuffleDeck. DUEL_PSEUDO_SHUFFLE is not used:
    // field.cpp applies it to every later deck/extra shuffle. EnableGlobalFlag is a noop here;
    // Debug.ReloadFieldBegin writes flags but also clears the duel.
    // LEGACY-1V1: the owner regression uses a board fixture without patching any card script.
    for (const script of options.startupScripts ?? []) {
      if (!lib.loadScript(handle, script.name, script.content)) throw new Error(`Failed to run startup script ${script.name}`);
    }
    if (start.shuffle) {
      if (!lib.loadScript(handle, "duel-startup.lua", `
      local e=Effect.GlobalEffect()
      e:SetType(EFFECT_TYPE_FIELD|EFFECT_TYPE_CONTINUOUS)
      e:SetCode(EVENT_STARTUP)
      e:SetOperation(function(effect)
        Duel.ShuffleDeck(0)
        Duel.ShuffleDeck(1)
        effect:Reset()
      end)
      Duel.RegisterEffect(e,0)
    `)) throw new Error("Failed to register opening deck shuffle");
    }
    if (errors.length) throw new Error(errors.join("; ")); // LEGACY-1V1: setup remains fatal
    lib.startDuel(handle);
  } catch (error) {
    lib.destroyDuel(handle);
    throw error;
  }

  let revision = 0;
  let promptSeq = 0;
  // LEGACY-1V1: chain response mode per seat. Both seats start at the duel setting (stopAtEveryWindow: false = Auto, else Always).
  const chainModes: DuelChainMode[] = [defaultChainMode(options.settings), defaultChainMode(options.settings)];
  let turn = 0;
  let turnSeat = 0;
  let phase = "draw";
  const diagnostics: EngineDiagnostic[] = []; // LEGACY-1V1: private display error diagnostics
  const diagnose = (kind: string, seat: number | null, detail: string) => { // LEGACY-1V1: private display error diagnostics
    diagnostics.push({ turn, phase, kind, seat, detail }); // LEGACY-1V1: private display error diagnostics
    if (diagnostics.length > DIAGNOSTICS_LIMIT) diagnostics.splice(0, diagnostics.length - DIAGNOSTICS_LIMIT); // LEGACY-1V1: private display error diagnostics
  }; // LEGACY-1V1: private display error diagnostics
  let battleStep: DuelBattleStep | null = null;
  const lp: [number, number] = [start.startingLP, start.startingLP];
  let pending: PendingPrompt | null = null;
  let result: DuelEngineView["result"] = null;
  let closed = false;
  const log: LogEntry[] = [];
  const events: StoredDuelEvent[] = [];
  const chainMemory: StoredChainLink[] = [];
  const chainOptions = new ChainOptions(cards); // LEGACY-1V1: public chosen chain options
  const respond = (prompt: PendingPrompt, response: OcgResponse) => { // LEGACY-1V1: public chosen chain options
    try { // LEGACY-1V1: display data must not stop a duel
      chainOptions.recordResponse(prompt, response); // LEGACY-1V1: public chosen chain options
    } catch (error) { // LEGACY-1V1: display data must not stop a duel
      diagnose("chain-options", prompt.seat, `recordResponse: ${String(error)}`); // LEGACY-1V1: private display error diagnostics
    } // LEGACY-1V1: display data must not stop a duel
    lib.duelSetResponse(handle, response); // LEGACY-1V1: public chosen chain options
  }; // LEGACY-1V1: public chosen chain options
  const reveals = createRevealMap();
  let nextLogId = 1;
  let nextEventId = 1;
  let lastSelectHint: string | undefined;
  /** Card named by the core's last HINT_CARD: the card whose effect the following prompts belong to. */
  let lastHintCard: number | undefined;
  let synchroSummon: MapPromptExtras["synchroSummon"];
  let sawRetry = false;
  const hintCardName = () => (lastHintCard ? cards.get(lastHintCard)?.name : undefined);

  const appendLog = (text: string, audience: "all" | number = "all"): LogEntry => {
    const entry = { id: nextLogId++, text, audience };
    log.push(entry);
    if (log.length > 400) log.splice(0, log.length - 400);
    return entry;
  };
  // Lines for cards that left the field this batch (log-lines.ts LogLine.leftField). A destroy event for the same
  // zone rewrites the line; the list is cleared with the event batch, before any view is built.
  const leftFieldLines: Array<{ entry: LogEntry; zone: { controller: number; location: number; sequence: number }; code: number; destination: number }> = [];
  const markDestroyedLine = (stored: StoredDuelEvent) => {
    const zone = stored.zone;
    if (stored.kind !== "destroy" || !zone) return;
    // The latest card to leave that zone, and the same card when the event names one: a zone can be emptied by a
    // Tribute and refilled within one batch. No match keeps the location-based text.
    const code = stored.card?.code;
    let index = -1;
    for (let i = leftFieldLines.length - 1; i >= 0; i -= 1) {
      const line = leftFieldLines[i]!;
      if (line.zone.controller !== zone.controller || line.zone.location !== zone.location || line.zone.sequence !== zone.sequence) continue;
      if (code !== undefined && line.code !== code) continue;
      index = i;
      break;
    }
    if (index < 0) return;
    const [line] = leftFieldLines.splice(index, 1);
    line!.entry.text = line!.destination === OcgLocation.REMOVED
      ? destroyedAndBanishedLogText(cards, line!.code)
      : destroyedLogText(cards, line!.code);
  };

  // The seat whose single legal target the engine just chose for it (an automatic answer), until the target message arrives.
  let autoPickSeat: number | null = null;
  // Target lines whose names have not all arrived: the core can deliver a card's note in a later process call than the
  // target message, so the lines are written now and their text is completed by settleTargetNames.
  const unnamedTargets: Array<{ link: StoredChainLink; event: StoredDuelEvent; lines: Array<{ entry: LogEntry; text: (phrase: string) => string }> }> = [];
  /** The log lines of a chain link's target: the public line, and a private note when the player had no choice. */
  const logChainTarget = (event: StoredDuelEvent) => {
    const link = event.chainIndex != null ? chainMemory.find((entry) => entry.index === event.chainIndex) : undefined;
    if (!link) return;
    const source = cards.get(link.code)?.name ?? `Card ${link.code}`;
    const lines: Array<{ entry: LogEntry; text: (phrase: string) => string }> = [];
    const add = (text: (phrase: string) => string, audience: "all" | number) => {
      lines.push({ entry: appendLog(text(linkTargetPhrase(link)), audience), text });
    };
    add((phrase) => `Chain Link ${link.index}: ${source} targets ${phrase}`, "all");
    if (autoPickSeat != null) {
      add((phrase) => `Only legal target: ${phrase}`, autoPickSeat);
      autoPickSeat = null;
    }
    if (!nameLinkTargets(eventContext, link, cards)) unnamedTargets.push({ link, event, lines });
  };
  const settleTargetNames = () => {
    for (let index = unnamedTargets.length - 1; index >= 0; index -= 1) {
      const pending = unnamedTargets[index]!;
      if (!nameLinkTargets(eventContext, pending.link, cards)) continue;
      pending.event.text = targetEventText(pending.link);
      const phrase = linkTargetPhrase(pending.link);
      for (const line of pending.lines) line.entry.text = line.text(phrase);
      unnamedTargets.splice(index, 1);
    }
  };

  const recordEvent = (message: OcgMessage) => {
    // Moves first: a card's move precedes the summon/set/activate/destroy event it belongs to.
    for (const move of observeMoveEvents(message, cards, eventContext, nextEventId)) pushEvent(move);
    for (const confirm of observeConfirmEvents(message, cards, eventContext, nextEventId)) pushEvent(confirm);
    const stored = observeDuelEvent(message, cards, chainMemory, nextEventId, eventContext);
    try { // LEGACY-1V1: display data must not stop a duel
      chainOptions.observe(message, chainMemory, stored); // LEGACY-1V1: public chosen chain options
    } catch (error) { // LEGACY-1V1: display data must not stop a duel
      diagnose("chain-options", null, `observe: ${String(error)}`); // LEGACY-1V1: private display error diagnostics
    } // LEGACY-1V1: display data must not stop a duel
    // The summon line is written here, right after applyMessage, because the summon method is only known now.
    if (
      stored?.kind === "summon" &&
      (message.type === OcgMessageType.SUMMONING || message.type === OcgMessageType.SPSUMMONING || message.type === OcgMessageType.FLIPSUMMONING)
    ) {
      for (const line of summonLogLines(message, cards, stored.summonKind)) appendLog(line.text, line.audience);
    }
    if (stored) {
      pushEvent(stored);
      // Write the result at this message's position, with the assigned FX id for client-side holds.
      if (stored.kind === "toss") appendLog(stored.text).eventId = stored.id;
    }
    for (const target of observeChainTargetEvents(message, chainMemory, nextEventId, eventContext, cards)) {
      pushEvent(target);
      logChainTarget(target);
    }
  };

  const pushEvent = (stored: StoredDuelEvent) => {
    stored.id = nextEventId;
    nextEventId += 1;
    markDestroyedLine(stored);
    events.push(stored);
    if (events.length > 400) events.splice(0, events.length - 400);
  };

  const flushDeferredDestroys = () => {
    for (const stored of drainDeferredDestroys(eventContext, cards, nextEventId)) pushEvent(stored);
  };

  const applyMessage = (message: OcgMessage) => {
    battleStep = nextBattleStep(battleStep, message);
    switch (message.type) {
      case OcgMessageType.RETRY:
        sawRetry = true;
        return;
      case OcgMessageType.HINT:
        if (message.hint_type === OcgHintType.SELECTMSG) {
          // Placeholders are filled when the prompt is built, against the card the prompt names.
          lastSelectHint = cards.resolveLabel(message.hint) || cards.system(Number(message.hint));
        } else if (message.hint_type === OcgHintType.EVENT || message.hint_type === OcgHintType.MESSAGE) {
          const text = fillPlaceholders(cards.resolveLabel(message.hint) || cards.system(Number(message.hint)) || "", [hintCardName()]);
          if (text) appendLog(text);
        } else if (message.hint_type === OcgHintType.CARD) {
          lastHintCard = Number(message.hint) || undefined;
        }
        return;
      case OcgMessageType.CHAIN_SOLVED:
      case OcgMessageType.CHAIN_END:
        lastHintCard = undefined;
        synchroSummon = undefined;
        return;
      case OcgMessageType.SPSUMMONED:
        synchroSummon = undefined;
        return;
      case OcgMessageType.WIN: {
        const winnerSeat = message.player === 0 || message.player === 1 ? message.player : null;
        const reason = cards.victory(message.reason) ?? `Win reason ${message.reason}`;
        result = { winnerSeat, reason };
        appendLog(winnerSeat == null ? `Draw (${reason})` : `Player ${winnerSeat + 1} wins (${reason})`);
        return;
      }
      case OcgMessageType.NEW_TURN:
        turn += 1;
        turnSeat = message.player;
        appendLog(`Turn ${turn} — Player ${message.player + 1}`);
        return;
      case OcgMessageType.NEW_PHASE:
        phase = phaseName(message.phase);
        appendLog(phase);
        return;
      case OcgMessageType.DAMAGE:
        lp[message.player] = Math.max(0, lp[message.player] - message.amount);
        appendLog(`Player ${message.player + 1} takes ${message.amount} damage`);
        return;
      case OcgMessageType.RECOVER:
        lp[message.player] += message.amount;
        appendLog(`Player ${message.player + 1} gains ${message.amount} LP`);
        return;
      case OcgMessageType.PAY_LPCOST:
        lp[message.player] = Math.max(0, lp[message.player] - message.amount);
        appendLog(`Player ${message.player + 1} pays ${message.amount} LP`);
        return;
      case OcgMessageType.LPUPDATE:
        lp[message.player] = message.lp;
        return;
      case OcgMessageType.DRAW:
        appendLog(`Player ${message.player + 1} drew ${message.drawn.length} card(s)`);
        appendLog(
          `You drew ${message.drawn.map((card) => cards.get(card.code)?.name ?? `Card ${card.code}`).join(", ")}`,
          message.player,
        );
        return;
      case OcgMessageType.SUMMONING:
      case OcgMessageType.SPSUMMONING:
      case OcgMessageType.FLIPSUMMONING:
        // Logged by recordEvent once the summon method is known (log-lines.ts summonLogLines).
        return;
      case OcgMessageType.SET:
        appendLog(`Player ${message.controller + 1} Sets a card`);
        return;
      case OcgMessageType.CHAINING:
        appendLog(`${cards.get(message.code)?.name ?? `Card ${message.code}`} is activating`);
        return;
      case OcgMessageType.CHAIN_NEGATED:
        appendLog("A chain link was negated");
        return;
      case OcgMessageType.CHAIN_END:
        appendLog("Chain ended");
        return;
      case OcgMessageType.ATTACK:
        appendLog(message.target ? "A monster declares an attack" : "A monster declares a direct attack");
        return;
      case OcgMessageType.SHUFFLE_DECK:
        appendLog(`Player ${message.player + 1} shuffled their deck`);
        clearRevealsAt(reveals, message.player, OcgLocation.DECK);
        return;
      case OcgMessageType.SHUFFLE_HAND:
        appendLog(`Player ${message.player + 1} shuffled their hand`);
        clearRevealsAt(reveals, message.player, OcgLocation.HAND);
        return;
      case OcgMessageType.SHUFFLE_EXTRA:
        clearRevealsAt(reveals, message.player, OcgLocation.EXTRA);
        return;
      case OcgMessageType.SHUFFLE_SET_CARD:
        clearRevealsAt(reveals, 0, message.location);
        clearRevealsAt(reveals, 1, message.location);
        return;
      case OcgMessageType.CONFIRM_CARDS:
        for (const card of message.cards) {
          noteReveal(reveals, message.player, card.controller, card.location, card.sequence, card.code);
          appendLog(`Confirmed ${cards.get(card.code)?.name ?? `Card ${card.code}`}`, confirmationAudience(card, message.player, eventContext));
        }
        return;
      case OcgMessageType.CONFIRM_DECKTOP:
      case OcgMessageType.CONFIRM_EXTRATOP:
        for (const card of message.cards) {
          noteReveal(reveals, message.player, card.controller, card.location, card.sequence, card.code);
        }
        appendLog(`Excavated ${message.cards.map((card) => cards.get(card.code)?.name ?? `Card ${card.code}`).join(", ")}`, message.player);
        return;
      case OcgMessageType.MOVE:
        moveReveals(reveals, message.from, message.to, message.card);
        for (const line of moveLogLines(message, cards)) {
          const entry = appendLog(line.text, line.audience);
          // Parsed overlay locations name the host's field zone, but the material itself was not on the field.
          if (line.leftField && message.from.overlay_sequence == null) {
            leftFieldLines.push({ entry, zone: message.from, code: message.card, destination: message.to.location });
          }
        }
        return;
      case OcgMessageType.REMOVE_CARDS:
        for (const card of [...message.cards].sort((a, b) => b.sequence - a.sequence)) {
          moveReveals(reveals, card, { controller: card.controller, location: 0, sequence: 0 }, 0);
        }
        return;
      case OcgMessageType.TOSS_DICE:
        appendLog(`Dice roll: ${message.results.join(", ")}`);
        return;
      default:
        return;
    }
  };

  const readDomainState = (): DomainSeatState[] | undefined => {
    if (options.mode !== "domain") return undefined;
    if (!getDomainState) throw new Error("Domain core did not provide getDomainState");
    return getDomainState();
  };

  const processUntilWait = () => {
    if (closed) throw new Error("Engine is closed");
    // Native materials move before position/place selection, so those prompts continue the same summon.
    const continuingSummon = pending?.message.type === OcgMessageType.SELECT_POSITION || pending?.message.type === OcgMessageType.SELECT_PLACE;
    resetEventBatch(eventContext, continuingSummon);
    unnamedTargets.length = 0;
    autoPickSeat = null;
    leftFieldLines.length = 0;
    let processCalls = 0;
    while (!result) {
      if (processCalls++ >= CORE_PROCESS_CALL_LIMIT) throw new EngineLoopError();
      scriptErrors.enterProcess();
      let status: ReturnType<typeof lib.duelProcess>;
      try { status = lib.duelProcess(handle); }
      finally { scriptErrors.leaveProcess(); } // LEGACY-1V1: only runtime process errors are tolerable
      const messages = lib.duelGetMessage(handle);
      for (const message of messages) {
        applyMessage(message);
        recordEvent(message);
      }
      flushDeferredDestroys();
      settleTargetNames();
      autoPickSeat = null;
      const toleratedError = scriptErrors.drain().some(error => error.scriptErrorMode !== "strict");
      if (toleratedError && !scriptErrorEventSent) {
        scriptErrorEventSent = true;
        const event: StoredDuelEvent = { id: nextEventId, kind: "script-error", text: CARD_SCRIPT_ERROR_TEXT, publicText: CARD_SCRIPT_ERROR_TEXT, revealCardTo: "all" };
        pushEvent(event);
        appendLog(CARD_SCRIPT_ERROR_TEXT).eventId = event.id;
      }
      if (errors.length > 0) {
        const detail = errors.join("; ");
        errors.length = 0;
        throw new Error(detail);
      }
      if (result) {
        pending = null;
        break;
      }
      if (status === OcgProcessResult.END) {
        throw new Error("Engine ended without a WIN event");
      }
      if (status === OcgProcessResult.CONTINUE) continue;
      if (sawRetry) break;
      const waiting = [...messages].reverse().find(isWaitingMessage);
      if (!waiting) throw new Error("Engine is waiting without a prompt");
      const domainState = readDomainState();
      const recallState =
        waiting.type === OcgMessageType.SELECT_YESNO && waiting.description === BigInt(DOMAIN_RECALL_DESC)
          ? domainState?.[waiting.player]
          : undefined;
      const recall = recallState ? recallPromptContext(recallState, cards) : undefined;
      // The main action prompts start a new play; a hint card from an earlier effect no longer applies.
      if (waiting.type === OcgMessageType.SELECT_IDLECMD || waiting.type === OcgMessageType.SELECT_BATTLECMD) {
        lastHintCard = undefined;
        synchroSummon = undefined;
      }
      const next = mapPrompt(
        waiting,
        cards,
        `p${revision}-${promptSeq + 1}`,
        lastSelectHint,
        {
          domain: domainState,
          recall: recall ? { card: recall.card, returns: recall.returns, nextCost: recall.nextCost } : undefined,
          hintCard: lastHintCard,
          synchroSummon,
        },
      );
      lastSelectHint = undefined;
      try { // LEGACY-1V1: display data must not stop a duel
        chainOptions.recordPrompt(next); // LEGACY-1V1: public chosen chain options
      } catch (error) { // LEGACY-1V1: display data must not stop a duel
        diagnose("chain-options", next.seat, `recordPrompt: ${String(error)}`); // LEGACY-1V1: private display error diagnostics
      } // LEGACY-1V1: display data must not stop a duel
      const automated = autoResponse(next, { stopAtEveryWindow: options.settings?.stopAtEveryWindow, chainMode: chainModes[next.seat], phase }); // LEGACY-1V1: per-seat chain mode
      if (automated) {
        // The player had no choice: the core offered exactly one card to target. Say so once the target message arrives.
        autoPickSeat = next.message.type === OcgMessageType.SELECT_CARD && next.message.min === 1 && next.message.max === 1 && next.prompt.options.length === 1 ? next.seat : null;
        respond(next, automated); // LEGACY-1V1: public chosen chain options
        continue;
      }
      promptSeq += 1;
      next.id = `p${revision}-${promptSeq}`;
      next.prompt.id = next.id;
      pending = next;
      break;
    }
  };

  try {
    processUntilWait();
  } catch (error) {
    lib.destroyDuel(handle);
    throw error;
  }

  const game: EngineGame = {
    view(seat) {
      if (closed) throw new Error("Engine is closed");
      if (seat != null && seat !== 0 && seat !== 1) throw new Error("Invalid seat");
      const projected = scriptErrors.query(() => projectView({
        lib,
        handle,
        cards,
        viewer: seat,
        revision,
        turn,
        turnSeat,
        phase,
        battleStep,
        lp,
        prompt: pending?.prompt ?? null,
        promptSeat: pending?.seat ?? null,
        log,
        events,
        chain: chainMemory,
        result,
        reveals,
        handIdentities: eventContext.handIdentities,
        mode: options.mode,
        domainState: readDomainState(),
      }));
      if (seat != null) projected.chainMode = chainModes[seat]; // LEGACY-1V1: private to the seat
      return projected;
    },
    // LEGACY-1V1: chain response mode. See ../engine.ts EngineGame.setChainMode.
    setChainMode(seat, mode) {
      scriptErrorEventSent = false;
      if (closed) throw new Error("Engine is closed");
      if (result) throw new EngineAnswerError("Duel is over");
      if (seat !== 0 && seat !== 1) throw new Error("Invalid seat");
      chainModes[seat] = mode;
      const open = pending;
      if (!open || open.seat !== seat) return false;
      if (open.message.type !== OcgMessageType.SELECT_CHAIN && open.message.type !== OcgMessageType.SELECT_EFFECTYN) return false;
      const automated = autoResponse(open, { stopAtEveryWindow: options.settings?.stopAtEveryWindow, chainMode: mode, phase });
      if (!automated) return false;
      sawRetry = false;
      respond(open, automated); // LEGACY-1V1: public chosen chain options
      processUntilWait();
      if (sawRetry) {
        pending = open;
        sawRetry = false;
        throw new Error(`The core refused the automatic pass of the open window of seat ${seat} (prompt ${open.id})`);
      }
      revision += 1;
      return true;
    },
    answer(seat, promptId, answer) {
      scriptErrorEventSent = false;
      if (closed) throw new Error("Engine is closed");
      if (result) throw new EngineAnswerError("Duel is over");
      if (!pending) throw new EngineAnswerError("No prompt is waiting");
      const response = resolveAnswer(pending, seat, promptId, answer, cards);
      const previous = pending;
      const previousSummon = synchroSummon;
      if (pending.message.type === OcgMessageType.SELECT_IDLECMD && answer.choice?.startsWith("spsummon:")) {
        const option = pending.prompt.options.find((entry) => entry.id === answer.choice);
        synchroSummon = undefined;
        if (option?.card && (option.card.type & OcgType.SYNCHRO) !== 0 && option.location === OcgLocation.EXTRA) {
          // Capture the selected card, not a guessed target from the material hint or other Extra Deck cards.
          const card = game.view(seat).seats[seat].extra.find((entry) => entry.code === option.card!.code &&
            entry.sequence === option.sequence && entry.controller === option.controller);
          if (card?.code && card.level != null && card.level > 0) {
            synchroSummon = { code: card.code, level: card.level, controller: card.controller,
              location: card.location, sequence: card.sequence };
          }
        }
      }
      sawRetry = false;
      // Stays set through the summon's follow-up prompts; observeDuelEvent clears it at SPSUMMONED.
      if (isPendulumSummonAnswer(pending, answer)) eventContext.pendulumSummon = true;
      respond(previous, response); // LEGACY-1V1: public chosen chain options
      processUntilWait();
      if (sawRetry) {
        pending = previous;
        synchroSummon = previousSummon;
        sawRetry = false;
        throw new EngineAnswerError("Invalid answer");
      }
      revision += 1;
    },
    diagnostics() { // LEGACY-1V1: private display error diagnostics
      return diagnostics.map((entry) => ({ ...entry })); // LEGACY-1V1: private display error diagnostics
    }, // LEGACY-1V1: private display error diagnostics
    searchCards(query) {
      if (closed) throw new Error("Engine is closed");
      if (pending?.message.type === OcgMessageType.ANNOUNCE_CARD) {
        const opcodes = pending.message.opcodes as OcgOpCode[];
        return cards.search(query, (data) => cardMatchesOpcode(data, opcodes));
      }
      return cards.search(query);
    },
    close() {
      if (closed) return;
      closed = true;
      lib.destroyDuel(handle);
    },
  };
  return game;
}

export { EngineAnswerError, LOCATION_DECKMASTER };
