import { ChainOptions } from "./chain-options.js";
import { scriptErrorCoreFactory } from "./script-load-scope.js";
import { EngineLoopError } from "./engine-loop-error.js";
import { CARD_SCRIPT_ERROR_TEXT, CORE_PROCESS_CALL_LIMIT, createScriptErrorPolicy, type DuelScriptError, type DuelScriptFatalError } from "./script-errors.js";
import type { DuelAnswer, DuelBattleStep, DuelChainMode, DuelCardInfo, DuelDeck, DuelEngineView, DuelFormat, DuelMasterRule, DuelMode, DuelSettings, DuelScriptErrorMode, DuelZoneRef } from "@yugidraft/shared/duels";
import { DUEL_SEAT_LEFT_ERROR_CODE, defaultChainMode, partnerSeatOf, seatCountFor, seatsOfTeam, startingLpFor, teamOfSeat } from "@yugidraft/shared/duels";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import createCore, {
  OcgDuelMode,
  OcgHintType,
  OcgLocation,
  OcgMessageType,
  OcgPosition,
  OcgProcessResult,
  OcgResponseType,
  OcgType,
  cardMatchesOpcode,
  type OcgCardData,
  type OcgCoreSync,
  type OcgDuelHandle,
  type OcgMessage,
  type OcgResponse,
  type OcgOpCode,
} from "ocgcore-wasm";
import { isOptionalCardScript, loadCardDatabase, type CardDatabase } from "./cards.js";
import { EngineAnswerError, HINT_PLACE_SEAT, autoResponse, directAttackSeat, filterPromptOptions, isOpponentPick, isWaitingMessage, mapPrompt, nextLivingOpponentSeat, opponentPickSeat, placeSeatHint, recallPromptContext, resolveAnswer, type MapPromptExtras, type PendingPrompt } from "./prompts.js";
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
  isNoDuelist,
  moveReveals,
  nextBattleStep,
  linkTargetPhrase,
  nameLinkTargets,
  noteChainTargetLog,
  noteDestroyLog,
  noteDirectAttackTarget,
  noteReveal,
  noteTargetCardLog,
  observeChainTargetEvents,
  observeDuelEvent,
  observeMoveEvents,
  observeConfirmEvents,
  phaseName,
  playerLabel,
  projectView,
  resetEventBatch,
  targetEventText,
  type DomainSeatState,
  type LogEntry,
  type StoredChainLink,
  type StoredDuelEvent,
} from "./views.js";
import { createDomainCore } from "./domain-core.js";
import { readCoreCapabilities } from "./core-capabilities.js";
import { chooseSurrenderedAnswer } from "./practice-bot.js";
import { MSG_ATTACK_DUELIST, MSG_DUELIST_ELIMINATED, MSG_FIELD_DISABLED_N, MSG_SURRENDER_WINDOW_CLOSED, parseDuelistMessages, rawMessageCapture, withoutDuelistParseWarnings, type RawDuelistMessage } from "./raw-messages.js";
import { MP_UTILITY_FILE, loadMultiScriptsFor } from "./multi-scripts.js";
import { fillPlaceholders } from "./text.js";
import { firstTurnDrawFor } from "./first-turn-draw.js";
import { attackTargetQueryScript, mergeAttackTargetPick, readAttackTargetQuery, type AttackTargetQuery } from "./attack-target-pick.js";
import { destroyedAndBanishedLogText, destroyedLogText, moveLogLines, summonLogLines } from "./log-lines.js";

/** A wasm the engine loaded: the bytes, the file name and the sha256 of the bytes (core identity for reports). */
export interface LoadedWasm {
  binary: ArrayBuffer;
  file: string;
  sha: string;
}

export interface EngineCoreInfo {
  /** sha256 of the wasm this game loaded. */
  wasmSha: string;
  /** File name of that wasm (`(provided binary)` for a test hook). */
  wasmFile: string;
  /** `duelProcess` calls since the last prompt was shown. */
  callsSinceLastPrompt: number;
  /** Messages the core emitted since the last prompt was shown. */
  messagesSinceLastPrompt: number;
}

const PROVIDED_WASM = "(provided binary)";

function describeWasm(binary: ArrayBuffer, file: string): LoadedWasm {
  return { binary, file, sha: createHash("sha256").update(new Uint8Array(binary)).digest("hex") };
}

function loadWasmFile(path: string): LoadedWasm {
  const bytes = readFileSync(path);
  return describeWasm(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, basename(path));
}

/**
 * Pinned Standard duels run ygopro-core with only the shared bug fixes in
 * domain-core/src/apply-core-fixes.mjs (stock rules, no Domain patch). The npm
 * ocgcore-wasm core is older than the pinned card scripts and is used by legacy
 * Standard 1v1 duels.
 */
function readStandardWasm(dataDirectory: string): LoadedWasm {
  const path = join(dataDirectory, "ocgcore.standard.wasm");
  if (!existsSync(path)) {
    throw new Error(
      `Standard wasm is missing at ${path}. Build it with docker.io/emscripten/emsdk:4.0.9 and packages/duel-server/scripts/build-standard-core.sh (or: npx tsx packages/duel-server/scripts/build-domain-core.ts standard)`,
    );
  }
  return loadWasmFile(path);
}

/**
 * Duels with more than two seats run the multi-duelist core (`ocgcore.multi.wasm`, or
 * `ocgcore.multi-domain.wasm` for Domain) from the data directory.
 */
function readMultiWasm(dataDirectory: string, mode: DuelMode): LoadedWasm {
  const name = mode === "domain" ? "ocgcore.multi-domain.wasm" : "ocgcore.multi.wasm";
  const path = join(dataDirectory, name);
  if (!existsSync(path)) {
    const build =
      mode === "domain"
        ? "APPLY_DOMAIN=1 DOMAIN_MULTI=1 OUT_NAME=ocgcore.multi-domain.sync.wasm bash packages/duel-server/scripts/build-multi-core.sh (in docker.io/emscripten/emsdk:4.0.9)"
        : "packages/duel-server/scripts/build-multi-core.sh";
    throw new Error(
      `Multi-duelist wasm is missing at ${path}. Build it with ${build} and install it in the engine data directory (Tag and free-for-all duels need it).`,
    );
  }
  return loadWasmFile(path);
}

export interface EngineGameOptions {
  scriptErrorMode?: DuelScriptErrorMode;
  /** Private telemetry callback; omitted by standalone replay tools. */
  onScriptError?: (error: DuelScriptError) => void;
  /** Private fatal diagnostics; never included in views or counted as telemetry. */
  onFatalScriptError?: (error: DuelScriptFatalError) => void;
  mode: DuelMode;
  decks: DuelDeck[];
  seed: string[];
  dataDirectory: string;
  masterRule?: DuelMasterRule;
  settings?: DuelSettings;
  /** Seat and team layout. Default `1v1`. `decks` has one entry per seat (`seatCountFor(format)`). */
  format?: DuelFormat;
  /** Saved FIRST_TURN_DRAW flag for recovery/replay. Omit only when starting a new duel. */
  firstTurnDraw?: boolean;
  /**
   * Lua chunks run after the Decks (and Domain Deck Masters) exist and before the Duel starts.
   * Tests use them to place an exact board with `Debug.AddCard` without playing turns.
   * Production callers leave this unset.
   */
  startupScripts?: EngineStartupScript[];
  /**
   * Test hook: run Standard duels on this wasm instead of `ocgcore.standard.wasm` from the data
   * directory. The differential tests use it to compare cores. Production callers leave this unset.
   */
  standardWasmBinary?: ArrayBuffer;
  /**
   * Test hook for formats with more than two seats: run on this multi-duelist wasm (the Domain variant
   * when `mode` is "domain") instead of the file in the data directory.
   */
  multiWasmBinary?: ArrayBuffer;
  /**
   * Test hook for formats with more than two seats: read the Lua overlay (mp-utility.lua, card suffixes) from this
   * folder instead of the lookup in src/multi-scripts.ts. A 1v1 duel never reads an overlay. Production callers leave this unset.
   */
  multiScriptsDirectory?: string;
}

export interface EngineStartupScript {
  name: string;
  content: string;
}

/** One line of the triage ring buffer. Never shown to a player: only the host report reads it. */
export interface EngineDiagnostic {
  turn: number;
  phase: string;
  /** `response` (a MSG_SELECT_CHAIN prompt), `msg200`, `msg201`, `msg202`, `win`, `win-ignored`, `eliminate`, `stderr` (a core log line), `chain-options` / `attack-target-query` (display data error). */
  kind: string;
  /** The seat the entry is about, or null. */
  seat: number | null;
  detail: string;
}

/** The core may repeat MSG_WIN after the win: only the first one counts. True while no result is held. */
export function acceptsResult(current: DuelEngineView["result"]): boolean {
  return current == null;
}

/**
 * A host loss uses `eliminate:<reason>` for immediate surrender or a time-limit loss, or `eliminate-eot:<reason>`
 * for a retired turn-end surrender. Retired commands are detected and refused by eliminate().
 * Returns the code, or null for an ordinary answer. Every journal replayer uses this.
 */
export const ELIMINATE_PROMPT_PREFIX = "eliminate:";
export const ELIMINATE_EOT_PROMPT_PREFIX = "eliminate-eot:";
/** True only for a retired saved surrender that used the turn-end rule. */
export function eliminationAtTurnEnd(promptId: string): boolean {
  return promptId.startsWith(ELIMINATE_EOT_PROMPT_PREFIX);
}
export function eliminationCodeOf(promptId: string): number | null {
  const prefix = eliminationAtTurnEnd(promptId) ? ELIMINATE_EOT_PROMPT_PREFIX : ELIMINATE_PROMPT_PREFIX;
  if (!promptId.startsWith(prefix)) return null;
  const code = Number(promptId.slice(prefix.length));
  return Number.isInteger(code) && code >= 0 ? code : null;
}

/** Entries the ring buffer keeps. */
export const DIAGNOSTICS_LIMIT = 200;

export interface EngineGame {
  view(seat: number | null): DuelEngineView;
  answer(seat: number, promptId: string, answer: DuelAnswer): void;
  searchCards(query: string): DuelCardInfo[];
  /**
   * Surrender removes a duelist immediately through Debug.SurrenderDuelist, or flags the loss while the
   * current chain finishes. Leaving seats auto-pass; required choices use the deterministic fallback.
   * A living seat's current choice stays open. Debug.EliminateDuelist keeps time-limit timing unchanged.
   * `atTurnEnd` identifies retired journal commands, which are refused instead of replayed at a new time.
   * Throws when the core lacks the required function (or the duel has fewer than three seats).
   */
  eliminate(seat: number, reason: number, atTurnEnd?: boolean): void;
  /**
   * Set the chain response mode of a seat (Auto, Always, Off; see chain-mode.ts). It applies to the next response
   * window of that seat and to the one that is open now: when the new mode passes the open window, the engine
   * passes it (the same response autoResponse would have given) and the duel moves on. Returns true when it did,
   * false when only the mode changed. A false return changes nothing a viewer or the journal can observe except
   * `view(seat).chainMode`: no revision bump, no new prompt. Deterministic: a replay of the same toggles at the
   * same points gives the same duel, so every call must be journaled by the caller.
   */
  setChainMode(seat: number, mode: DuelChainMode): boolean;
  /** The last entries (oldest first) of the triage ring buffer. For the host report only, never for a view. */
  diagnostics(): EngineDiagnostic[];
  /** Core identity (wasm sha and file) and the counters since the last prompt. For reports and triage only. */
  coreInfo(): EngineCoreInfo;
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

function addDeck(lib: OcgCoreSync, handle: OcgDuelHandle, seat: number, deck: DuelDeck, importedOrder: boolean) {
  const team = seat as 0 | 1;
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

// Pendulum Zones are Spell & Trap sequences 0 and 4 under Master Rule 4/5, and 6 and 7 under Master Rule 3.
const PENDULUM_ZONE_SEQUENCES = new Set([0, 4, 6, 7]);

/**
 * A Pendulum Summon is offered as the Special Summon action of a Pendulum card in a Pendulum Zone
 * (a Pendulum Zone sequence of the Spell & Trap Zone, or the LOCATION_PZONE flag). The summons it produces are then "pendulum".
 */
export function isPendulumSummonAnswer(pending: PendingPrompt, answer: DuelAnswer): boolean {
  if (pending.message.type !== OcgMessageType.SELECT_IDLECMD || !answer.choice?.startsWith("spsummon:")) return false;
  const option = pending.prompt.options.find((entry) => entry.id === answer.choice);
  if (!option || option.location == null) return false;
  if ((option.location & OcgLocation.PZONE) !== 0) return true;
  if (option.location !== OcgLocation.SZONE || !PENDULUM_ZONE_SEQUENCES.has(option.sequence ?? -1)) return false;
  return ((option.card?.type ?? 0) & OcgType.PENDULUM) !== 0;
}

function loadScriptOrThrow(lib: OcgCoreSync, handle: OcgDuelHandle, cards: CardDatabase, name: string) {
  const content = cards.readScript(name);
  if (!content) throw new Error(`Required script missing: ${name}`);
  if (!lib.loadScript(handle, name, content)) throw new Error(`Failed to load script ${name}`);
}

export async function createEngineGame(options: EngineGameOptions): Promise<EngineGame> {
  const format: DuelFormat = options.format ?? "1v1";
  const seatCount = seatCountFor(format);
  const multi = seatCount > 2;
  if (options.decks.length !== seatCount) {
    throw new Error(multi ? `Exactly ${seatCount} decks are required for a ${format} duel` : "Exactly two decks are required");
  }
  const start = engineStartConfig(options.settings);
  const firstTurnDraw = options.firstTurnDraw ?? firstTurnDrawFor(options.mode, options.masterRule, format);
  const flags = (duelFlagsFor(options.masterRule) & ~OcgDuelMode.FIRST_TURN_DRAW)
    | (firstTurnDraw ? OcgDuelMode.FIRST_TURN_DRAW : 0n);
  const seed = parseSeed(options.seed);
  const cards = loadCardDatabase(options.dataDirectory);
  // Duels with more than two seats read the Lua overlay. 1v1 gets none, so its script text stays the original.
  const overlay = multi ? loadMultiScriptsFor(options.dataDirectory, options.multiScriptsDirectory) : undefined;
  const scriptErrors = createScriptErrorPolicy({ ...options, engine: "pinned" });
  const errors = scriptErrors.errors;
  let scriptErrorEventSent = false;
  const scopedCreateCore = scriptErrorCoreFactory(createCore, scriptErrors);
  const eventContext = createEventContext(format);
  const cardReader = (code: number) => {
    if (!code) return null;
    return cards.cardData(code);
  };
  const scriptReader = (name: string) => {
    const content = cards.readScript(name, overlay);
    if (!content && !isOptionalCardScript(name, cards.cardData)) errors.push(`Missing script ${name}`);
    return content;
  };
  let attackTargetQuery: AttackTargetQuery | null = null;
  let declaringAttack = false;
  let completingAttackPick = false;
  const errorHandler = (type: number, text: string) => {
    if (readAttackTargetQuery(text, attackTargetQuery)) return;
    if (noteDestroyLog(eventContext, text) || noteChainTargetLog(eventContext, text) || noteTargetCardLog(eventContext, text)) return;
    scriptErrors.note(type, text);
  };
  const team = {
    // Tag: one LP total per team, so the core gets the team starting LP.
    startingLP: startingLpFor(format, { startingLP: start.startingLP }),
    startingDrawCount: start.startingDrawCount,
    drawCountPerTurn: start.drawCountPerTurn,
  };

  let lib: OcgCoreSync;
  let handle: OcgDuelHandle;
  let getDomainState: (() => DomainSeatState[]) | undefined;
  // Raw message tap: the wrapper drops the multi-duelist messages (ids 200 and 201), so the engine reads them itself.
  let tap: ReturnType<typeof rawMessageCapture> | null = null;
  let multiWasm: ArrayBuffer | null = null;
  let loaded: LoadedWasm;
  if (multi) {
    const multiLoaded = options.multiWasmBinary ? describeWasm(options.multiWasmBinary, PROVIDED_WASM) : readMultiWasm(options.dataDirectory, options.mode);
    loaded = multiLoaded;
    multiWasm = multiLoaded.binary;
    tap = rawMessageCapture(multiWasm);
  } else if (options.mode === "domain") {
    const domainPath = join(options.dataDirectory, "ocgcore.domain.wasm");
    loaded = existsSync(domainPath) ? loadWasmFile(domainPath) : describeWasm(new ArrayBuffer(0), "ocgcore.domain.wasm (missing)");
  } else {
    loaded = options.standardWasmBinary ? describeWasm(options.standardWasmBinary, PROVIDED_WASM) : readStandardWasm(options.dataDirectory);
  }
  const coreCapabilities = multi ? readCoreCapabilities(options.dataDirectory,
    options.mode === "domain" ? "ocgcore.multi-domain.wasm" : "ocgcore.multi.wasm", loaded.sha) : undefined;
  // Core log lines (stderr of the wasm, e.g. YGO_N_TRAP_LOG census lines) go into the diagnostics ring.
  const earlyStderr: string[] = [];
  let stderrSink: ((text: string) => void) | null = null;
  const printErr = (text: string) => {
    if (stderrSink) stderrSink(text);
    else earlyStderr.push(text);
  };
  const tapOptions = { printErr, ...(tap ? { instantiateWasm: tap.instantiateWasm } : {}) };

  if (options.mode === "domain") {
    if (!domainCoreFactory) throw new Error("Domain core is not registered");
    const created = await domainCoreFactory({
      createStockCore: ((coreOptions: object) => scopedCreateCore({ ...coreOptions, ...tapOptions } as never)) as unknown as typeof createCore,
      dataDirectory: options.dataDirectory,
      seed,
      decks: options.decks,
      flags,
      team1: team,
      team2: team,
      cardReader,
      scriptReader,
      errorHandler,
      ...(multiWasm ? { wasmBinary: new Uint8Array(multiWasm) } : {}),
    });
    lib = created.lib;
    handle = created.handle;
    if (!created.getDomainState) throw new Error("Domain core did not provide getDomainState");
    getDomainState = created.getDomainState;
  } else {
    lib = await scopedCreateCore({
      sync: true,
      wasmBinary: multiWasm ?? loaded.binary,
      ...tapOptions,
    } as Parameters<typeof createCore>[0]) as OcgCoreSync;
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
    if (multi) {
      // Before any card exists: the core changes its duelist count and teams here (PLAN.md, ABI decision).
      const teams = Array.from({ length: seatCount }, (_, seat) => teamOfSeat(format, seat));
      if (!lib.loadScript(handle, "duel-setup-duelists.lua", `Debug.SetupDuelists(${seatCount},${teams.join(",")})`)) {
        throw new Error(`Failed to set up ${seatCount} duelists (does the core have Debug.SetupDuelists?)${errors.length > 0 ? `: ${errors.join("; ")}` : ""}`);
      }
    }
    loadScriptOrThrow(lib, handle, cards, "constant.lua");
    loadScriptOrThrow(lib, handle, cards, "utility.lua");
    if (!lib.loadScript(handle, "duel-events.lua", DESTROY_NOTE_SCRIPT)) throw new Error("Failed to register destruction reporter");
    if (options.mode === "domain") loadScriptOrThrow(lib, handle, cards, "domain.lua");
    // After utility.lua and domain.lua, before any card exists. The overlay is never loaded at 1v1.
    if (overlay && !lib.loadScript(handle, MP_UTILITY_FILE, overlay.utility)) {
      throw new Error(`Failed to load ${MP_UTILITY_FILE}${errors.length > 0 ? `: ${errors.join("; ")}` : ""}`);
    }
    if (!lib.loadScript(handle, "chain-target-notes.lua", CHAIN_TARGET_NOTE_SCRIPT)) throw new Error("Failed to register chain target reporter");
    if (options.mode === "domain") {
      // Card creation runs initial_effect; procedure libraries must be loaded first.
      for (let teamSeat = 0; teamSeat < seatCount; teamSeat += 1) {
        const code = options.decks[teamSeat]!.deckMaster;
        if (!code) throw new Error(`Seat ${teamSeat} is missing a Deck Master`);
        lib.duelNewCard(handle, {
          team: teamSeat as 0 | 1,
          duelist: 0,
          code,
          controller: teamSeat as 0 | 1,
          location: LOCATION_DECKMASTER as OcgLocation,
          sequence: 0,
          position: OcgPosition.FACEUP_ATTACK,
        });
      }
    }
    for (let seat = 0; seat < seatCount; seat += 1) addDeck(lib, handle, seat, options.decks[seat]!, !start.shuffle);
    for (const script of options.startupScripts ?? []) {
      if (!lib.loadScript(handle, script.name, script.content)) {
        throw new Error(`Failed to run startup script ${script.name}${errors.length > 0 ? `: ${errors.join("; ")}` : ""}`);
      }
    }
    // Opening shuffle is only this EVENT_STARTUP ShuffleDeck. DUEL_PSEUDO_SHUFFLE is not used:
    // field.cpp applies it to every later deck/extra shuffle. EnableGlobalFlag is a noop here;
    // Debug.ReloadFieldBegin writes flags but also clears the duel.
    if (start.shuffle) {
      if (!lib.loadScript(handle, "duel-startup.lua", `
      local e=Effect.GlobalEffect()
      e:SetType(EFFECT_TYPE_FIELD|EFFECT_TYPE_CONTINUOUS)
      e:SetCode(EVENT_STARTUP)
      e:SetOperation(function(effect)
${Array.from({ length: seatCount }, (_, seat) => `        Duel.ShuffleDeck(${seat})`).join("\n")}
        effect:Reset()
      end)
      Duel.RegisterEffect(e,0)
    `)) throw new Error("Failed to register opening deck shuffle");
    }
    if (errors.length) throw new Error(errors.join("; "));
    lib.startDuel(handle);
  } catch (error) {
    lib.destroyDuel(handle);
    throw error;
  }

  let revision = 0;
  let promptSeq = 0;
  // Chain response mode per seat. Every seat starts at the duel setting (stopAtEveryWindow: false = Auto, else Always).
  const chainModes: DuelChainMode[] = Array.from({ length: seatCount }, () => defaultChainMode(options.settings));
  let turn = 0;
  let turnSeat = 0;
  let phase = "draw";
  let battleStep: DuelBattleStep | null = null;
  // LP per team (Tag: both partners share one value; 1v1 and FFA: one per seat).
  const lp: number[] = Array.from({ length: seatCount }, () => team.startingLP);
  const lpOf = (seat: number) => lp[teamOfSeat(format, seat)] ?? 0;
  const eliminated = new Set<number>();
  const eliminationReasons = new Map<number, number>();
  const eliminationOrder: number[][] = [];
  let eliminationGroup: number[] | null = null;
  /** Seats (a whole team in Tag) after `eliminate()` whose loss the core has not reported yet. */
  const leaving = new Set<number>();
  const isLeaving = (seat: number) => leaving.has(seat) && !eliminated.has(seat);
  /** The next living opponent of a seat in turn order (the core fold's fallback opponent). Never a Tag partner. */
  const nextLivingOpponent = (seat: number): number => nextLivingOpponentSeat(format, seatCount, seat, eliminated);
  /** Zones that the core disabled, per seat (bit layout of the low half of MSG_FIELD_DISABLED). */
  const disabledZones = new Map<number, number>();
  const diagnostics: EngineDiagnostic[] = [];
  const diagnose = (kind: string, seat: number | null, detail: string) => {
    diagnostics.push({ turn, phase, kind, seat, detail });
    if (diagnostics.length > DIAGNOSTICS_LIMIT) diagnostics.splice(0, diagnostics.length - DIAGNOSTICS_LIMIT);
  };
  const logCoreLine = (text: string) => diagnose("stderr", null, text.length > 500 ? `${text.slice(0, 500)}...` : text);
  earlyStderr.splice(0).forEach(logCoreLine);
  stderrSink = logCoreLine;
  let callsSinceLastPrompt = 0;
  let messagesSinceLastPrompt = 0;
  /** Links of the chain that are still on it: the wrapper cannot read the chain when there are more than two seats. */
  let liveChainSize = 0;
  const startedChainLinks = new Set<number>();
  let pending: PendingPrompt | null = null;
  let closedResponseSeat: number | null = null;
  let result: DuelEngineView["result"] = null;
  let closed = false;
  const log: LogEntry[] = [];
  const events: StoredDuelEvent[] = [];
  const chainMemory: StoredChainLink[] = [];
  const chainOptions = new ChainOptions(cards);
  const respond = (prompt: PendingPrompt, response: OcgResponse) => {
    try {
      chainOptions.recordResponse(prompt, response);
    } catch (error) {
      diagnose("chain-options", prompt.seat, `recordResponse: ${String(error)}`);
    }
    lib.duelSetResponse(handle, response);
  };
  const reveals = createRevealMap(seatCount);
  let nextLogId = 1;
  let nextEventId = 1;
  let lastSelectHint: string | undefined;
  // HINT_LOG_CALL (0xf1) is internal N-seat metadata, not a UI hint.
  let logHintRecipientsLeft = 0;
  let loggedHintCall = false;
  /** Card named by the core's last HINT_CARD: the card whose effect the following prompts belong to. */
  let lastHintCard: number | undefined;
  /** Seat of the core's last HINT_PLACE_SEAT: the owner of the high half of the next place mask. One prompt only. */
  let lastPlaceSeat: number | undefined;
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
      ? destroyedAndBanishedLogText(cards, line!.code, line!.zone.controller, format)
      : destroyedLogText(cards, line!.code, line!.zone.controller, format);
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
    try {
      chainOptions.observe(message, chainMemory, stored);
    } catch (error) {
      diagnose("chain-options", null, `observe: ${String(error)}`);
    }
    // The summon line is written here, right after applyMessage, because the summon method is only known now.
    if (
      stored?.kind === "summon" &&
      (message.type === OcgMessageType.SUMMONING || message.type === OcgMessageType.SPSUMMONING || message.type === OcgMessageType.FLIPSUMMONING)
    ) {
      for (const line of summonLogLines(message, cards, stored.summonKind, format)) appendLog(line.text, line.audience);
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
    eliminationGroup = null;
    battleStep = nextBattleStep(battleStep, message);
    switch (message.type) {
      case OcgMessageType.RETRY:
        sawRetry = true;
        return;
      case OcgMessageType.HINT:
        if (multi && Number(message.hint_type) === 0xf1 && message.player === 0xff
          && message.hint >= 1n && message.hint <= BigInt(seatCount)) {
          logHintRecipientsLeft = Number(message.hint);
          loggedHintCall = false;
        } else if (Number(message.hint_type) === HINT_PLACE_SEAT) {
          lastPlaceSeat = placeSeatHint(message) ?? undefined;
        } else if (message.hint_type === OcgHintType.SELECTMSG) {
          // Placeholders are filled when the prompt is built, against the card the prompt names.
          lastSelectHint = cards.resolveLabel(message.hint) || cards.system(Number(message.hint));
        } else if (message.hint_type === OcgHintType.EVENT || message.hint_type === OcgHintType.MESSAGE) {
          const text = fillPlaceholders(cards.resolveLabel(message.hint) || cards.system(Number(message.hint)) || "", [hintCardName()]);
          const duplicateRecipient = logHintRecipientsLeft > 0 && loggedHintCall;
          if (logHintRecipientsLeft > 0) {
            logHintRecipientsLeft -= 1;
            loggedHintCall = true;
          }
          if (text && !duplicateRecipient) appendLog(text);
        } else if (message.hint_type === OcgHintType.CARD) {
          lastHintCard = Number(message.hint) || undefined;
        }
        return;
      case OcgMessageType.CHAIN_SOLVING:
        startedChainLinks.add(message.chain_size);
        return;
      case OcgMessageType.CHAIN_SOLVED:
      case OcgMessageType.CHAIN_END:
        if (message.type === OcgMessageType.CHAIN_SOLVED) startedChainLinks.delete(message.chain_size);
        else startedChainLinks.clear();
        lastHintCard = undefined;
        synchroSummon = undefined;
        liveChainSize = message.type === OcgMessageType.CHAIN_SOLVED ? Math.max(0, message.chain_size - 1) : 0;
        return;
      case OcgMessageType.CHAINING:
        startedChainLinks.delete(message.chain_size);
        liveChainSize = message.chain_size;
        appendLog(`${playerLabel(format, message.controller)}'s ${cards.get(message.code)?.name ?? `Card ${message.code}`} is activating`);
        return;
      case OcgMessageType.SPSUMMONED:
        synchroSummon = undefined;
        return;
      case OcgMessageType.WIN: {
        // The core repeats MSG_WIN after the win. The first result stands.
        if (!acceptsResult(result)) {
          diagnose("win-ignored", null, `player ${message.player} reason ${message.reason}`);
          return;
        }
        diagnose("win", message.player < seatCount ? message.player : null, `player ${message.player} reason ${message.reason}`);
        const winnerSeat = message.player >= 0 && message.player < seatCount ? message.player : null;
        const reason = message.reason === 0 ? "Surrender" : cards.victory(message.reason) ?? `Win reason ${message.reason}`;
        if (multi) {
          // Tag: `player` is the winning team (its lowest seat).
          const winnerTeam = winnerSeat == null ? null : teamOfSeat(format, winnerSeat);
          // A Tag duel ends with MSG_WIN only (no message 200 for the losing team): every seat of another team is out.
          if (winnerSeat !== null) {
            for (let seat = 0; seat < seatCount; seat++) {
              if (teamOfSeat(format, seat) !== winnerTeam) eliminated.add(seat);
            }
          }
          result = { winnerSeat, winnerTeam, reason };
          appendLog(winnerSeat == null ? `Draw (${reason})` : format === "tag" ? `Team ${winnerTeam! + 1} wins (${reason})` : `Player ${winnerSeat + 1} wins (${reason})`);
          return;
        }
        result = { winnerSeat, reason };
        appendLog(winnerSeat == null ? `Draw (${reason})` : `Player ${winnerSeat + 1} wins (${reason})`);
        return;
      }
      case OcgMessageType.FIELD_DISABLED:
        // Two duelists: one u32, duelist 0 in the low half and duelist 1 in the high half.
        if (!multi) {
          disabledZones.set(0, message.field_mask & 0xffff);
          disabledZones.set(1, (message.field_mask >>> 16) & 0xffff);
        }
        return;
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
        lp[teamOfSeat(format, message.player)] = Math.max(0, lpOf(message.player) - message.amount);
        appendLog(`Player ${message.player + 1} takes ${message.amount} damage`);
        return;
      case OcgMessageType.RECOVER:
        lp[teamOfSeat(format, message.player)] = lpOf(message.player) + message.amount;
        appendLog(`Player ${message.player + 1} gains ${message.amount} LP`);
        return;
      case OcgMessageType.PAY_LPCOST:
        lp[teamOfSeat(format, message.player)] = Math.max(0, lpOf(message.player) - message.amount);
        appendLog(`Player ${message.player + 1} pays ${message.amount} LP`);
        return;
      case OcgMessageType.LPUPDATE:
        lp[teamOfSeat(format, message.player)] = message.lp;
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
        appendLog(`${playerLabel(format, message.controller)} Sets a card`);
        return;
      case OcgMessageType.CHAIN_NEGATED: {
        const link = chainMemory[message.chain_size - 1];
        appendLog(link ? `${playerLabel(format, link.seat)}'s chain link was negated` : "A chain link was negated");
        return;
      }
      case OcgMessageType.CHAIN_END:
        appendLog("Chain ended");
        return;
      case OcgMessageType.ATTACK:
        declaringAttack = false;
        appendLog(`${playerLabel(format, message.card.controller)} declares ${message.target ? "an attack" : "a direct attack"}`);
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
        for (let seat = 0; seat < seatCount; seat += 1) clearRevealsAt(reveals, seat, message.location);
        return;
      case OcgMessageType.CONFIRM_CARDS:
        for (const card of message.cards) {
          noteReveal(reveals, message.player, card.controller, card.location, card.sequence, card.code);
          const partner = partnerSeatOf(format, message.player);
          if (partner != null) noteReveal(reveals, partner, card.controller, card.location, card.sequence, card.code);
          appendLog(`Confirmed ${playerLabel(format, card.controller)}'s ${cards.get(card.code)?.name ?? `Card ${card.code}`}`, confirmationAudience(card, message.player, eventContext));
        }
        return;
      case OcgMessageType.CONFIRM_DECKTOP:
      case OcgMessageType.CONFIRM_EXTRATOP:
        // Excavation is public: message.player owns the Deck, and every duelist sees the cards
        // (Conscription excavates the opponent's Deck for the activating player).
        for (const card of message.cards) {
          for (const viewer of reveals.keys()) noteReveal(reveals, viewer, card.controller, card.location, card.sequence, card.code);
        }
        appendLog(`Excavated ${message.cards.map((card) => cards.get(card.code)?.name ?? `Card ${card.code}`).join(", ")}`);
        return;
      case OcgMessageType.MOVE:
        moveReveals(reveals, message.from, message.to, message.card);
        for (const line of moveLogLines(message, cards, format)) {
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

  /** A multi-duelist message that the wrapper drops: MSG_DUELIST_ELIMINATED (200) and MSG_ATTACK_DUELIST (201). */
  const applyRaw = (raw: RawDuelistMessage) => {
    if (raw.type !== MSG_DUELIST_ELIMINATED) eliminationGroup = null;
    if (raw.type === MSG_SURRENDER_WINDOW_CLOSED) {
      if (format === "tag" && raw.duelist < seatCount) closedResponseSeat = raw.duelist;
      return;
    }
    if (raw.type === MSG_DUELIST_ELIMINATED) {
      // A seat is 0..seatCount-1. Anything else (0xFF, "no duelist") eliminates nobody.
      if (raw.duelist >= seatCount) {
        diagnose("msg200", null, `no duelist (${raw.duelist}) reason ${raw.reason}`);
        return;
      }
      // FFA: the duelist. Tag: the whole team loses its cards and turns.
      const lost = format === "tag" ? seatsOfTeam(format, teamOfSeat(format, raw.duelist)) : [raw.duelist];
      const newlyLost = lost.filter((seat) => !eliminated.has(seat));
      if (newlyLost.length) {
        if (!eliminationGroup) {
          eliminationGroup = [];
          eliminationOrder.push(eliminationGroup);
        }
        eliminationGroup.push(...newlyLost);
        for (const seat of newlyLost) {
          eliminated.add(seat);
          eliminationReasons.set(seat, raw.reason);
        }
      }
      diagnose("msg200", raw.duelist, `reason ${raw.reason}`);
      const reason = raw.reason === 0 ? "Surrender" : cards.victory(raw.reason) ?? `Win reason ${raw.reason}`;
      appendLog(format === "tag" ? `Team ${teamOfSeat(format, raw.duelist) + 1} is eliminated (${reason})` : `Player ${raw.duelist + 1} is eliminated (${reason})`);
    } else if (raw.type === MSG_ATTACK_DUELIST) {
      // The core writes 0xFF when a direct attack has no defender duelist (no seat to name).
      if (isNoDuelist(format, raw.duelist) || raw.duelist >= seatCount) {
        diagnose("msg201", null, `attacked directly, no duelist (${raw.duelist})`);
        return;
      }
      diagnose("msg201", raw.duelist, "attacked directly");
      appendLog(`Player ${raw.duelist + 1} is attacked directly`);
      // The raw tap preserves buffer order: this follows the direct MSG_ATTACK,
      // whose stock wrapper target is null and cannot identify the defender.
      const attack = events.at(-1);
      if (attack?.kind === "attack" && !attack.target) {
        const declaration = attack.text;
        noteDirectAttackTarget(attack, raw.duelist, format);
        for (let i = log.length - 1; i >= 0; i--) {
          if (log[i].text !== declaration) continue;
          log[i].text = attack.text;
          break;
        }
      }
    } else if (raw.type === MSG_FIELD_DISABLED_N) {
      for (const zone of raw.zones) {
        if (zone.duelist >= seatCount) continue;
        disabledZones.set(zone.duelist, zone.mask);
      }
      diagnose("msg202", null, raw.zones.map((zone) => `${zone.duelist}:0x${zone.mask.toString(16)}`).join(" "));
    }
  };

  const readDomainState = (): DomainSeatState[] | undefined => {
    if (options.mode !== "domain") return undefined;
    if (!getDomainState) throw new Error("Domain core did not provide getDomainState");
    return getDomainState();
  };

  const queryAttackTargets = (attacker?: DuelZoneRef): AttackTargetQuery => {
    const query: AttackTargetQuery = { targets: [], directSeats: [] };
    const attackingSeat = attacker?.controller ?? turnSeat;
    const rivals = Array.from({ length: seatCount }, (_, seat) => seat).filter(seat =>
      !eliminated.has(seat) && !isLeaving(seat) && teamOfSeat(format, seat) !== teamOfSeat(format, attackingSeat));
    // Keep the required FFA declaration query distinct from the optional battle display probe.
    const scriptName = attacker ? "attack-target-query.lua" : "ffa-attack-target-query.lua";
    attackTargetQuery = query;
    try {
      if (!scriptErrors.query(() => lib.loadScript(handle, scriptName, attackTargetQueryScript(attacker, rivals)), true)) {
        throw new Error("Failed to query attack targets");
      }
    } finally { attackTargetQuery = null; }
    return query;
  };

  const battleAttackTargets = (attacker: DuelZoneRef) => {
    const errorCount = errors.length;
    try {
      const query = queryAttackTargets(attacker);
      if (errors.length > errorCount) throw new Error("Failed to query battle attack targets");
      return {
        attackTargets: {
          monsters: query.targets.filter(target => !eliminated.has(target.controller) && !isLeaving(target.controller))
            .map(({ controller, location, sequence }) => ({ controller, location, sequence })),
          direct: query.directSeats.filter(seat => !eliminated.has(seat) && !isLeaving(seat)),
        },
        attackerChoosesTarget: query.attackerChoosesTarget,
      };
    } catch {
      // Display metadata is optional. Discard only this probe's queued errors so the
      // next answer can proceed; the FFA declaration query still fails normally.
      errors.length = errorCount;
      diagnose("attack-target-query", attacker.controller, "Failed to query battle attack targets");
      return { attackTargets: null, attackerChoosesTarget: undefined };
    }
  };

  const withBattleAttackTargets = (current: PendingPrompt): PendingPrompt => {
    if (current.message.type !== OcgMessageType.SELECT_BATTLECMD) return current;
    const attacks = current.message.attacks;
    // Surrender can remove a borrowed attacker from the surviving player's field. Query
    // only retained options; the original native attack list still contains that removed card.
    return { ...current, prompt: { ...current.prompt, options: current.prompt.options.map(option =>
      option.id.startsWith("attack:") ? { ...option, ...battleAttackTargets(attacks[option.values![0]!]!) } : option) } };
  };

  // The native selection rechecks targets after a defender leaves. Answer its original indices
  // rather than exposing a required combined choice with nothing a player can select.
  const emptyAttackTargetResponse = (current: PendingPrompt) => {
    if (!current.attackTargetPick || current.prompt.options.length > 0) return null;
    const native = mapPrompt(current.message, cards, current.id);
    return resolveAnswer(native, native.seat, native.id, chooseSurrenderedAnswer(native.prompt), cards);
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
      finally { scriptErrors.leaveProcess(); }
      // The wrapper warns once per message id 200, 201, 202 and 203 (it does not know them). The tap reads them below.
      const messages = tap ? withoutDuelistParseWarnings(() => lib.duelGetMessage(handle)) : lib.duelGetMessage(handle);
      callsSinceLastPrompt += 1;
      messagesSinceLastPrompt += messages.length;
      if (tap) {
        // Interleave the raw-only messages with the parsed ones, in buffer order.
        const extras = tap.take().flatMap((buffer) => parseDuelistMessages(buffer).extras);
        let nextExtra = 0;
        messages.forEach((message, index) => {
          while (nextExtra < extras.length && extras[nextExtra]!.after <= index) applyRaw(extras[nextExtra++]!);
          applyMessage(message);
          recordEvent(message);
        });
        while (nextExtra < extras.length) applyRaw(extras[nextExtra++]!);
      } else {
        for (const message of messages) {
          applyMessage(message);
          recordEvent(message);
        }
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
      if (waiting.type === OcgMessageType.SELECT_CHAIN) {
        diagnose("response", waiting.player, `${waiting.selects.length} choice(s)${waiting.forced ? ", forced" : ""}${waiting.spe_count === 0x7f ? ", trigger" : ""}, chain ${liveChainSize}`);
      }
      const domainState = readDomainState();
      const recallState =
        waiting.type === OcgMessageType.SELECT_YESNO && waiting.description === BigInt(DOMAIN_RECALL_DESC)
          ? domainState?.[waiting.player]
          : undefined;
      const recall = recallState ? recallPromptContext(recallState, cards) : undefined;
      // The main action prompts start a new play; a hint card from an earlier effect no longer applies.
      if (waiting.type === OcgMessageType.SELECT_IDLECMD || waiting.type === OcgMessageType.SELECT_BATTLECMD) {
        declaringAttack = false;
        lastHintCard = undefined;
        synchroSummon = undefined;
      }
      let next = mapPrompt(
        waiting,
        cards,
        `p${revision}-${promptSeq + 1}`,
        lastSelectHint,
        {
          domain: domainState,
          recall: recall ? { card: recall.card, returns: recall.returns, nextCost: recall.nextCost } : undefined,
          hintCard: lastHintCard,
          ...(multi && "player" in waiting ? { placeOpponent: nextLivingOpponent(waiting.player) } : {}),
          ...(multi && lastPlaceSeat != null ? { placeSeat: lastPlaceSeat } : {}),
          ...(multi ? { livingSeats: Array.from({ length: seatCount }, (_, seat) => seat).filter((seat) => !eliminated.has(seat) && !isLeaving(seat)) } : {}),
          ...(multi ? { eliminatedSeats: [...eliminated] } : {}),
          synchroSummon,
        },
      );
      const attackYesNo = (waiting.type === OcgMessageType.SELECT_YESNO || waiting.type === OcgMessageType.SELECT_EFFECTYN) && waiting.description === 31n;
      const directSeatPick = waiting.type === OcgMessageType.SELECT_OPTION && waiting.options.length > 0 && waiting.options.every(option => directAttackSeat(option) != null);
      if ((format === "ffa3" || format === "ffa4") && !completingAttackPick && (attackYesNo || directSeatPick)) {
        const query = queryAttackTargets();
        next = filterPromptOptions(mergeAttackTargetPick(next, query, cards, declaringAttack), {
          eliminatedSeats: [...eliminated],
          livingSeats: Array.from({ length: seatCount }, (_, seat) => seat).filter(seat => !eliminated.has(seat) && !isLeaving(seat)),
        });
      }
      lastSelectHint = undefined;
      lastPlaceSeat = undefined;
      try {
        chainOptions.recordPrompt(next);
      } catch (error) {
        diagnose("chain-options", next.seat, `recordPrompt: ${String(error)}`);
      }
      const automated = emptyAttackTargetResponse(next) ?? (next.attackTargetPick || completingAttackPick && (waiting.type === OcgMessageType.SELECT_CARD || waiting.type === OcgMessageType.SELECT_OPTION)
        ? null : autoResponse(next, { stopAtEveryWindow: options.settings?.stopAtEveryWindow, chainMode: chainModes[next.seat], phase }));
      if (automated) {
        // The player had no choice: the core offered exactly one card to target. Say so once the target message arrives.
        autoPickSeat = next.message.type === OcgMessageType.SELECT_CARD && next.message.min === 1 && next.message.max === 1 && next.prompt.options.length === 1 ? next.seat : null;
        respond(next, automated);
        continue;
      }
      next = withBattleAttackTargets(next);
      promptSeq += 1;
      next.id = `p${revision}-${promptSeq}`;
      next.prompt.id = next.id;
      pending = next;
      callsSinceLastPrompt = 0;
      messagesSinceLastPrompt = 0;
      break;
    }
  };

  /** Bound automatic answers while the current chain or cut-short turn finishes. */
  const LEAVING_ANSWER_LIMIT = 200;

  const mustCloseResponseWindow = () => pending?.seat === closedResponseSeat
    && (pending?.message.type === OcgMessageType.SELECT_EFFECTYN
      || pending?.message.type === OcgMessageType.SELECT_CHAIN && !pending.message.forced);

  /**
   * While the open prompt belongs to a seat that is leaving, answer it for that seat (the answer that changes
   * the game least) until the core reports the loss or the prompt moves to a seat that stays. Deterministic:
   * a journal replay of the same commands gives the same answers.
   */
  const answerForLeavingSeats = () => {
    for (let step = 0; pending && !result && (leaving.has(pending.seat) || mustCloseResponseWindow()); step += 1) {
      const current = pending;
      closedResponseSeat = null;
      if (step >= LEAVING_ANSWER_LIMIT) {
        throw new Error(`Seat ${current.seat} is still in the duel after ${LEAVING_ANSWER_LIMIT} automatic answers (open prompt ${current.id}, ${current.prompt.kind})`);
      }
      const permittedCards = current.prompt.kind === "announce-card" ? game.searchCards("") : undefined;
      const phasePass = format !== "tag" && eliminated.has(current.seat) && current.prompt.kind === "choice"
        ? ["to_bp", "to_m2", "to_ep"].find((id) => current.prompt.options.some((option) => option.id === id)) : undefined;
      const answer = phasePass ? { choice: phasePass } : chooseSurrenderedAnswer(current.prompt, { permittedCards });
      const response = resolveAnswer(current, current.seat, current.id, answer, cards);
      diagnose("leaving-answer", current.seat, `${current.prompt.kind} ${current.id}`);
      sawRetry = false;
      respond(current, response);
      processUntilWait();
      if (sawRetry) {
        pending = current;
        sawRetry = false;
        throw new Error(`The core refused the automatic answer of leaving seat ${current.seat} (prompt ${current.id}, ${current.prompt.kind})`);
      }
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
      if (seat != null && !(Number.isInteger(seat) && seat >= 0 && seat < seatCount)) throw new Error("Invalid seat");
      const projected = scriptErrors.query(() => projectView({
        lib,
        coreCapabilities,
        handle,
        cards,
        viewer: seat,
        revision,
        turn,
        turnSeat,
        phase,
        battleStep,
        lp: Array.from({ length: seatCount }, (_, index) => lpOf(index)),
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
        ...(multi ? { format, eliminated, leaving: new Set([...leaving].filter(isLeaving)), chain: chainMemory.slice(0, liveChainSize).filter((link) => !eliminated.has(link.seat) || startedChainLinks.has(link.index)) } : {}),
      }));
      // Disabled zones are public board facts. The field is set only for seats that have one.
      if (multi) projected.eliminationOrder = eliminationOrder.map((group) => [...group]);
      // Private: a seat sees its own chain mode, nobody else's, and a spectator sees none.
      if (seat != null) projected.chainMode = chainModes[seat];
      for (const entry of projected.seats) {
        if (multi) entry.pendingElimination = !result && !eliminated.has(entry.seat)
          && isLeaving(entry.seat);
        const mask = disabledZones.get(entry.seat);
        if (mask) entry.disabledZones = mask;
      }
      return projected;
    },
    answer(seat, promptId, answer) {
      scriptErrorEventSent = false;
      if (closed) throw new Error("Engine is closed");
      if (result) throw new EngineAnswerError("Duel is over");
      if (!pending) throw new EngineAnswerError("No prompt is waiting");
      const response = resolveAnswer(pending, seat, promptId, answer, cards);
      const previous = pending;
      const targetPick = previous.attackTargetPick
        ? previous.prompt.options.find(option => option.id === (answer.selected ? answer.selected[0] : answer.choice)) : undefined;
      const cancelAttackPick = previous.attackTargetPick && answer.cancel;
      const expandTargetPick = previous.attackTargetPick && previous.message.type !== OcgMessageType.SELECT_OPTION;
      if (previous.message.type === OcgMessageType.SELECT_BATTLECMD && answer.choice?.startsWith("attack:")) declaringAttack = true;
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
      completingAttackPick = Boolean(expandTargetPick);
      try {
        respond(previous, response);
        processUntilWait();
      } finally { completingAttackPick = false; }
      if (sawRetry) {
        pending = previous;
        synchroSummon = previousSummon;
        sawRetry = false;
        if (previous.message.type === OcgMessageType.SELECT_OPTION && isOpponentPick(previous.message.options)
          && typeof answer.choice === "string" && /^opt:(0|[1-9]\d*)$/.test(answer.choice)) {
          const desc = previous.message.options[Number(answer.choice.slice(4))];
          const pickedSeat = desc === undefined ? null : opponentPickSeat(desc);
          if (pickedSeat !== null && (eliminated.has(pickedSeat) || leaving.has(pickedSeat))) {
            throw new EngineAnswerError("That player has left. Pick again.", DUEL_SEAT_LEFT_ERROR_CODE);
          }
        }
        throw new EngineAnswerError("Invalid answer");
      }
      // One public target answer expands to the legacy core responses. Only the outer answer advances
      // revision / the host journal; native prompt ids and automatic steps replay in the same order.
      if (expandTargetPick && cancelAttackPick && pending?.message.type === OcgMessageType.SELECT_CARD) {
        respond(pending, resolveAnswer(pending, seat, pending.id, { cancel: true }, cards));
        processUntilWait();
      } else if (expandTargetPick && targetPick && pending?.message.type === OcgMessageType.SELECT_OPTION && targetPick.id.startsWith("direct:") &&
        pending.message.options.every(option => directAttackSeat(option) != null) &&
        pending.message.options.some(option => directAttackSeat(option) === targetPick.controller)) {
        const option = pending.prompt.options.find(option => option.controller === targetPick.controller);
        if (!option) throw new Error("The core did not offer the chosen direct-attack seat");
        respond(pending, resolveAnswer(pending, pending.seat, pending.id, { choice: option.id }, cards));
        processUntilWait();
      } else if (expandTargetPick && targetPick && pending?.message.type === OcgMessageType.SELECT_CARD && !targetPick.id.startsWith("direct:")) {
        const option = pending.prompt.options.find(option => option.controller === targetPick.controller &&
          option.location === targetPick.location && option.sequence === targetPick.sequence);
        if (!option) throw new Error("The core did not offer the chosen attack target");
        respond(pending, resolveAnswer(pending, pending.seat, pending.id, { selected: [option.id] }, cards));
        processUntilWait();
      }
      answerForLeavingSeats();
      revision += 1;
    },
    setChainMode(seat, mode) {
      scriptErrorEventSent = false;
      if (closed) throw new Error("Engine is closed");
      if (result) throw new EngineAnswerError("Duel is over");
      if (!Number.isInteger(seat) || seat < 0 || seat >= seatCount) throw new Error("Invalid seat");
      chainModes[seat] = mode;
      // Only a response window of this seat can be passed by a new mode. Any other prompt was never auto-passed.
      const open = pending;
      if (!open || open.seat !== seat) return false;
      if (open.message.type !== OcgMessageType.SELECT_CHAIN && open.message.type !== OcgMessageType.SELECT_EFFECTYN) return false;
      const automated = autoResponse(open, { stopAtEveryWindow: options.settings?.stopAtEveryWindow, chainMode: mode, phase });
      if (!automated) return false;
      sawRetry = false;
      respond(open, automated);
      processUntilWait();
      if (sawRetry) {
        pending = open;
        sawRetry = false;
        throw new Error(`The core refused the automatic pass of the open window of seat ${seat} (prompt ${open.id})`);
      }
      answerForLeavingSeats();
      revision += 1;
      return true;
    },
    eliminate(seat, reason, atTurnEnd = false) {
      scriptErrorEventSent = false;
      if (closed) throw new Error("Engine is closed");
      if (result) throw new EngineAnswerError("Duel is over");
      if (!multi) throw new Error("Only duels with more than two seats can eliminate a duelist");
      if (!Number.isInteger(seat) || seat < 0 || seat >= seatCount) throw new Error("Invalid seat");
      if (eliminated.has(seat) || leaving.has(seat)) throw new EngineAnswerError("Seat is already eliminated");
      if (atTurnEnd) throw new EngineAnswerError("This saved duel uses the retired turn-end surrender rule");
      if (!Number.isInteger(reason) || reason < 0 || reason > 255) throw new Error("Invalid loss reason");
      // Check before the core is touched, so a throw cannot leave the duel half changed.
      if (!pending) throw new Error("The core waits for an answer but the engine has no open prompt");
      const surrender = reason === 0;
      if (!scriptErrors.query(() => lib.loadScript(handle, "duel-probe-eliminate.lua", surrender
        ? "assert(Debug.EliminateDuelist~=nil and Debug.SurrenderDuelist~=nil)"
        : "assert(Debug.EliminateDuelist~=nil)"), true)) {
        errors.length = 0;
        throw new Error(surrender ? "This duel core has no Debug.EliminateDuelist immediate surrender support" : "This duel core has no Debug.EliminateDuelist");
      }
      // LoadScript appends messages to the last process buffer. Read only the
      // suffix it adds, so the old prompt and its events are not counted twice.
      const oldMessages = tap ? withoutDuelistParseWarnings(() => lib.duelGetMessage(handle)) : lib.duelGetMessage(handle);
      const oldBytes = tap?.take().at(-1)?.byteLength ?? 0;
      if (!scriptErrors.query(() => lib.loadScript(handle, "duel-eliminate.lua", surrender
        ? `Debug.SurrenderDuelist(${seat})`
        : `Debug.EliminateDuelist(${seat},${Math.trunc(reason)})`), true)) {
        const detail = errors.join("; ");
        errors.length = 0;
        throw new Error(`Failed to eliminate seat ${seat}${detail ? `: ${detail}` : ""}`);
      }
      diagnose("eliminate", seat, `reason ${Math.trunc(reason)}`);
      for (const gone of format === "tag" ? seatsOfTeam(format, teamOfSeat(format, seat)) : [seat]) leaving.add(gone);
      const fresh = (tap ? withoutDuelistParseWarnings(() => lib.duelGetMessage(handle)) : lib.duelGetMessage(handle)).slice(oldMessages.length);
      const extras = tap?.take().flatMap((buffer) => parseDuelistMessages(buffer.subarray(oldBytes)).extras) ?? [];
      // Each call is a new loss window, also when an empty seat produces only message 200.
      eliminationGroup = null;
      let nextExtra = 0;
      fresh.forEach((message, index) => {
        while (nextExtra < extras.length && extras[nextExtra]!.after <= index) applyRaw(extras[nextExtra++]!);
        applyMessage(message);
        recordEvent(message);
      });
      while (nextExtra < extras.length) applyRaw(extras[nextExtra++]!);
      flushDeferredDestroys();
      if (result) pending = null;
      if (pending && !eliminated.has(pending.seat)) {
        const previous = pending;
        pending = filterPromptOptions(pending, {
          livingSeats: Array.from({ length: seatCount }, (_, seat) => seat).filter((seat) => !eliminated.has(seat) && !isLeaving(seat)),
          eliminatedSeats: [...eliminated],
          removedCards: fresh.flatMap((message) => message.type === OcgMessageType.REMOVE_CARDS ? message.cards : []),
        });
        pending = withBattleAttackTargets(pending);
        // answerForLeavingSeats consumes the core's close signal before advancing. An automatic
        // answer here would leave that signal armed for the next response of the same living seat.
        if (pending.prompt.options.length !== previous.prompt.options.length && !mustCloseResponseWindow()) {
          // SelectCounter checks changed sources before reading its response. A zero response lets
          // the core refresh the offer or cancel an unpaid cost without selecting a removed card.
          const response = pending.message.type === OcgMessageType.SELECT_COUNTER
            ? { type: OcgResponseType.SELECT_COUNTER as const, counters: pending.message.cards.map(() => 0) }
            : emptyAttackTargetResponse(pending) ?? autoResponse(pending, { stopAtEveryWindow: options.settings?.stopAtEveryWindow, chainMode: chainModes[pending.seat], phase });
          if (response) {
            const current = pending;
            sawRetry = false;
            respond(current, response);
            processUntilWait();
            if (sawRetry) {
              // Surrender already changed the board. A refused automatic answer must leave
              // the command recorded and the suspended core selection available to the player.
              pending = current.message.type === OcgMessageType.SELECT_COUNTER ||
                current.message.type === OcgMessageType.SELECT_CHAIN && current.message.forced ? previous : current;
              sawRetry = false;
              diagnose("eliminate-retry", current.seat, `prompt ${current.id}`);
            }
          }
        }
      }
      // Do not run the core here. A call with no new response is no no-op: the core takes the old response buffer as the answer
      // of the open prompt (a chain window gets a pass), so the prompt of ANOTHER seat would be answered without that seat.
      // Living choices with multiple legal options stay open. The core identifies an optional response to
      // the departed turn player; that window and prompts held by leavers also receive automatic answers.
      answerForLeavingSeats();
      revision += 1;
    },
    diagnostics() {
      return diagnostics.map((entry) => ({ ...entry }));
    },
    coreInfo() {
      return { wasmSha: loaded.sha, wasmFile: loaded.file, callsSinceLastPrompt, messagesSinceLastPrompt };
    },
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
