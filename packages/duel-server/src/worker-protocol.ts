import type { DuelScriptError, DuelScriptFatalError } from "./script-errors.js";
import type { EngineCoreInfo, EngineDiagnostic, EngineStartupScript } from "./engine.js";
import type { PromptTraceEntry } from "./prompt-trace.js";
import type { DuelAnswer, DuelCardInfo, DuelChainMode, DuelDeck, DuelEngineChoice, DuelEngineView, DuelErrorCode, DuelFormat, DuelMasterRule, DuelMode, DuelSettings, DuelScriptErrorMode, EngineIdentity } from "@yugidraft/shared/duels";

/** Bump when worker transport, command decoding or prompt semantics change. */
export const ENGINE_PROTOCOL_VERSION = "duel-worker-1";

export interface DuelWorkerCreateOptions {
  engineIdentity?: EngineIdentity;
  multiScriptsDirectory?: string;
  firstTurnDraw?: boolean;
  scriptErrorMode?: DuelScriptErrorMode;
  mode: DuelMode;
  decks: DuelDeck[];
  seed: string[];
  dataDirectory: string;
  masterRule?: DuelMasterRule;
  settings?: DuelSettings;
  /** Seat and team layout; `decks` holds one deck per seat. Default `1v1`. */
  format?: DuelFormat;
  /** Lua chunks that run before the duel starts (hand scenarios). */
  startupScripts?: EngineStartupScript[];
  /**
   * The engine for a 1v1 table: `legacy` (main's engine, the default of the host) or `pinned` (the merged engine).
   * Absent means `pinned`, so existing callers (tests, scripts) keep the merged engine. Tables with more than
   * two seats ignore it and always use the multi-duelist core.
   */
  engine?: DuelEngineChoice;
}

export type DuelWorkerRequest =
  | { id: number; op: "create"; options: DuelWorkerCreateOptions }
  | { id: number; op: "view"; seat: number | null }
  | { id: number; op: "answer"; seat: number; promptId: string; answer: DuelAnswer }
  | { id: number; op: "search"; query: string }
  | { id: number; op: "eliminate"; seat: number; reason: number; atTurnEnd?: boolean }
  | { id: number; op: "chain-mode"; seat: number; mode: DuelChainMode }
  | { id: number; op: "diagnostics" }
  | { id: number; op: "close" };

export type DuelWorkerResponse =
  | { id: number; ok: true; value?: DuelEngineView | DuelCardInfo[] | EngineDiagnostic[] | boolean; info?: EngineCoreInfo; promptTrace?: PromptTraceEntry; scriptErrors?: DuelScriptError[]; fatalScriptErrors?: DuelScriptFatalError[] }
  | { id: number; ok: false; error: string; answerError?: true; engineLoop?: true; code?: DuelErrorCode | "ENGINE_UNAVAILABLE_FOR_SOURCE"; scriptErrors?: DuelScriptError[]; fatalScriptErrors?: DuelScriptFatalError[] };
