import { NextResponse } from "next/server";
import { ReplayAccessError } from "@yugidraft/shared/access/owner-access";
import { httpTransport } from "@yugidraft/shared/notify";
import {
  createDuelService,
  createPlayerService,
  redactDuelTournamentMetadata,
  DuelServiceError,
  SavedDeckServiceError,
  TournamentDuelError,
  type DuelService,
} from "@yugidraft/shared/services";
import { isReplayFork, seatCountFor, type CardQuery, type DuelChainMode, type DuelCommand, type DuelDeck, type DuelFirstChoice,
  type DuelMasterRule, type DuelMode, type DuelRpsMove, type DuelRoom, type ReplayForkRequest } from "@yugidraft/shared/duels";
import { requireWebAccess } from "@/lib/web-access";
import { getDb } from "@/lib/db";
import { env } from "@/lib/env";
import type { CardDataStatus } from "@yugidraft/shared/types";

export type DuelHostOp = "engine-data-status" | "capabilities" | "view" | "start" | "respond" | "deck" | "validate-deck" | "validate-deck-master" | "cards" | "card-details" | "card-artworks" | "card-query" | "card-facets" | "surrender" | "add-bot" | "archive" | "cancel" | "replay" | "owner-replay" | "replay-fork" | "fork-restart" | "fork-cancel" | "ready" | "unready" | "series-side" | "series-ready" | "series-unready" | "series-first" | "opening-pick" | "opening-choose" | "normalize-codes" | "check-deck" | "list-presets" | "start-preset" | "report" | "debug-trace" | "bug-context" | "chain-mode";

/** Read-only seat identity stays separate from creator identity. Unknown control flags fail closed. */
export function readDuelControl(request: Request, room?: DuelRoom, allowed: "view" | "action" | "cards" | "none" = "none") {
  const query = new URL(request.url).searchParams;
  const flags = ["as", "reveal", "promptId", "revision"];
  const present = flags.filter(key => query.has(key));
  const fork = room && isReplayFork(room.session);
  const permitted = allowed === "view" ? ["as", "reveal"] : allowed === "action" ? ["as"]
    : allowed === "cards" ? ["as", "promptId", "revision"] : [];
  if (present.some(key => !fork || !permitted.includes(key) || query.getAll(key).length !== 1)) {
    throw new DuelServiceError("Control overrides are only available on replay fork controls", 400);
  }
  const as = query.get("as"), reveal = query.get("reveal"), promptId = query.get("promptId"), revision = query.get("revision");
  if ((as !== null && (!/^[0-3]$/.test(as) || Number(as) >= seatCountFor(room!.session.format)))
    || (reveal !== null && reveal !== "0" && reveal !== "1")
    || (promptId !== null && (!promptId || promptId.length > 200))
    || (revision !== null && (!/^(0|[1-9]\d*)$/.test(revision) || !Number.isSafeInteger(Number(revision))))
    || (fork && allowed === "cards" && (as === null || promptId === null || revision === null))) {
    throw new DuelServiceError("Invalid replay fork control request", 400);
  }
  return { ...(as !== null ? { as: Number(as) } : {}), ...(reveal !== null ? { reveal: reveal === "1" } : {}),
    ...(promptId !== null ? { promptId } : {}), ...(revision !== null ? { revision: Number(revision) } : {}) };
}

/** Normal admission and series routes never accept a fork or a seat override. */
export function assertNormalDuelRequest(request: Request, room: DuelRoom) {
  if (room && isReplayFork(room.session)) throw new DuelServiceError("Replay forks cannot use lobby or series operations", 409);
  readDuelControl(request, room);
}

/** Dev scenario tools (presets page, Report button). Server side only. Exactly "1" turns them on. */
export function scenariosEnabled(): boolean {
  return process.env.DUEL_SCENARIOS === "1";
}

export function scenariosOffResponse(): NextResponse {
  return NextResponse.json({ error: "Not found" }, { status: 404 });
}

export type DuelActor =
  | { ok: true; guildId: string; playerId: number; userId: number; duels: DuelService }
  | { ok: false; response: NextResponse };

export async function requireDuelActor(): Promise<DuelActor> {
  const actor = await requireWebAccess();
  if (!actor.ok) return actor;
  const guildId = env.discordGuildId;
  if (!guildId) {
    return { ok: false, response: NextResponse.json({ error: "Guild is not configured" }, { status: 500 }) };
  }
  const db = getDb();
  const player = createPlayerService(db).findOrCreate(guildId, actor.userId, actor.userName);
  return { ok: true, guildId, playerId: player.id, userId: actor.userId, duels: createDuelService(db) };
}

export function duelErrorResponse(error: unknown) {
  if (error instanceof ReplayAccessError) {
    return NextResponse.json({ error: error.message, code: error.code }, {
      status: error.status, headers: { "cache-control": "private, no-store" },
    });
  }
  if (
    error instanceof DuelServiceError ||
    error instanceof TournamentDuelError ||
    error instanceof SavedDeckServiceError
  ) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }
  console.error("[api/duels]", error);
  return NextResponse.json({ error: "Failed to process duel request" }, { status: 500 });
}

/** Redact only when internal duel data leaves the web server for a viewer. */
export function redactDuelResult<T>(data: T, guildId: string, playerId: number): T {
  return redactDuelTournamentMetadata(getDb, data, guildId, playerId);
}

function hostErrorBody(text: string): { error: string; code?: string; finalBoard?: "available" | "none" } {
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object" && "error" in parsed && typeof parsed.error === "string") {
      return { error: parsed.error, ...("code" in parsed && typeof parsed.code === "string" ? { code: parsed.code } : {}),
        ...("finalBoard" in parsed && (parsed.finalBoard === "available" || parsed.finalBoard === "none") ? { finalBoard: parsed.finalBoard } : {}) };
    }
  } catch {
    // Host may return a plain-text error body.
  }
  return { error: text.trim() || "Duel engine error" };
}

export function duelHostConfigProblem(cfg: { url: string; secret: string }): string | null {
  const missing = [!cfg.url && "DUEL_INTERNAL_URL", !cfg.secret && "DUEL_INTERNAL_SECRET"].filter(Boolean);
  if (missing.length === 0) return null;
  return `The duel engine is not set up on this server: ${missing.join(" and ")} ${missing.length > 1 ? "are" : "is"} missing. Ask the server admin to add ${missing.length > 1 ? "them" : "it"} to .env and restart the web and duel services.`;
}

function unreachableMessage(detail: string) {
  return `The duel engine did not answer (${detail || "network error"}). It may be restarting. Try again in a moment.`;
}

export async function callDuelHost(input: {
  op: DuelHostOp;
  slug?: string;
  guildId: string;
  playerId: number;
  /** Trusted web session users.id. Owner operations must recheck its stored player mapping on the host. */
  userId?: number;
  as?: number;
  promptId?: string;
  revision?: number;
  cursor?: ReplayForkRequest["cursor"];
  sourceVersion?: string;
  requestId?: string;
  /** Replay contract and server card projection. Camera position stays in the browser. */
  version?: 1 | 2;
  visibility?: "mine" | "public";
  /** Owner replay and fork views: reveal hands/Extra Decks in the selected projection. */
  reveal?: boolean;
  /** view only: an eliminated FFA player watches through the public view. */
  spectate?: boolean;
  command?: DuelCommand;
  deck?: DuelDeck;
  query?: string;
  codes?: number[];
  /** normalize-codes only: retain known artwork passcodes for storage/display. */
  preserveArtwork?: boolean;
  /** add-bot only: the 0-based empty seat to fill. */
  seat?: number;
  /** start-preset only. */
  presetId?: string;
  /** start-preset only: four decimal strings (the core seed). */
  seed?: string[];
  /** report only: the tester's note. */
  note?: string;
  cardQuery?: CardQuery;
  /** Rules for `check-deck`. */
  mode?: DuelMode;
  masterRule?: DuelMasterRule;
  settings?: unknown;
  /** check-deck only: the server loads this player's durable draft pool. */
  draftId?: number | null;
  /** Rock-paper-scissors move for `opening-pick`. */
  move?: DuelRpsMove;
  /** First or second for `opening-choose` and `series-first`. */
  choice?: DuelFirstChoice;
  /** chain-mode only: the response switch position for the caller's own seat. */
  chainMode?: DuelChainMode;
}): Promise<{ ok: true; data: unknown } | { ok: false; response: NextResponse }> {
  const replayOp = input.op === "replay" || input.op === "owner-replay" || input.op === "replay-fork"
    || input.op === "fork-restart" || input.op === "fork-cancel";
  const failure = (body: ReturnType<typeof hostErrorBody>, status: number): NextResponse => NextResponse.json({
    ...body, ...(replayOp && !body.code && status >= 500 ? { code: "ENGINE_BUSY" } : {}),
  }, { status: replayOp && status >= 500 ? 503 : status,
    ...(replayOp ? { headers: { "cache-control": "private, no-store" } } : {}) });
  const cfg = { url: env.duelInternalUrl, secret: env.duelInternalSecret };
  const configProblem = duelHostConfigProblem(cfg);
  if (configProblem) {
    console.error(`[duel-host] ${configProblem}`);
    return { ok: false, response: failure({ error: configProblem }, 503) };
  }
  const transport = httpTransport({ ...cfg, ...(input.op === "engine-data-status" ? { timeoutMs: 5000 }
    : replayOp ? { timeoutMs: 30_000 } : {}) });
  const payload: Record<string, unknown> = {
    op: input.op,
    guildId: input.guildId,
    playerId: input.playerId,
  };
  if (input.userId !== undefined) payload.userId = input.userId;
  if (input.as !== undefined) payload.as = input.as;
  if (input.promptId !== undefined) payload.promptId = input.promptId;
  if (input.revision !== undefined) payload.revision = input.revision;
  if (input.cursor !== undefined) payload.cursor = input.cursor;
  if (input.sourceVersion !== undefined) payload.sourceVersion = input.sourceVersion;
  if (input.requestId !== undefined) payload.requestId = input.requestId;
  if (input.version !== undefined) payload.version = input.version;
  if (input.visibility !== undefined) payload.visibility = input.visibility;
  if (input.reveal !== undefined) payload.reveal = input.reveal;
  if (input.slug) payload.slug = input.slug;
  if (input.op === "view" && input.spectate === true) payload.spectate = true;
  if (input.command) payload.command = input.command;
  if (input.deck) payload.deck = input.deck;
  if (input.query !== undefined) payload.query = input.query;
  if (input.codes !== undefined) payload.codes = input.codes;
  if (input.preserveArtwork !== undefined) payload.preserveArtwork = input.preserveArtwork;
  if (input.draftId !== undefined) payload.draftId = input.draftId;
  if (input.seat !== undefined) payload.seat = input.seat;
  if (input.presetId !== undefined) payload.presetId = input.presetId;
  if (input.seed !== undefined) payload.seed = input.seed;
  if (input.note !== undefined) payload.note = input.note;
  if (input.cardQuery !== undefined) payload.cardQuery = input.cardQuery;
  if (input.mode !== undefined) payload.mode = input.mode;
  if (input.masterRule !== undefined) payload.masterRule = input.masterRule;
  if (input.settings !== undefined) payload.settings = input.settings;
  if (input.move !== undefined) payload.move = input.move;
  if (input.choice !== undefined) payload.choice = input.choice;
  if (input.chainMode !== undefined) payload.mode = input.chainMode;

  const result = await transport.post("/internal/duel", JSON.stringify(payload));
  if (!result.ok) {
    if (result.status < 400) {
      console.error(`[duel-host] ${input.op} failed: ${result.text || "no response"}`);
      return { ok: false, response: failure({ error: unreachableMessage(result.text) }, 503) };
    }
    if (result.status === 401) {
      // The host answers 401 only for a bad signature.
      const error = "The duel engine refused the web server: their DUEL_INTERNAL_SECRET values do not match. Ask the server admin to fix .env and restart both services.";
      console.error(`[duel-host] ${error}`);
      return { ok: false, response: failure({ error }, 503) };
    }
    return {
      ok: false,
      response: failure(hostErrorBody(result.text), result.status),
    };
  }
  if (!result.text) {
    return { ok: false, response: failure({ error: "Empty engine response" }, 502) };
  }
  let data: unknown;
  try {
    data = JSON.parse(result.text);
  } catch {
    return { ok: false, response: failure({ error: "Invalid engine response" }, 502) };
  }
  return { ok: true, data: redactDuelResult(data, input.guildId, input.playerId) };
}

/** Strict query parsing prevents private view flags from reaching the ordinary host operation. */
export function readReplayQuery(request: Request, privileged = false) {
  const query = new URL(request.url).searchParams;
  const allowed = privileged ? ["version", "visibility", "seat", "reveal"] : ["version", "visibility"];
  const invalid = () => ({ ok: false as const, response: NextResponse.json({ error: "Invalid replay request", code: "INVALID_CURSOR" },
    { status: 400, headers: { "cache-control": "private, no-store" } }) });
  if ([...query.keys()].some(key => !allowed.includes(key) || query.getAll(key).length !== 1)) return invalid();
  const version = query.get("version"); const visibility = query.get("visibility");
  const seat = query.get("seat"); const reveal = query.get("reveal");
  if ((version !== null && (privileged ? version !== "2" : version !== "1" && version !== "2"))
    || (visibility !== null && visibility !== "mine" && visibility !== "public")
    || (seat !== null && !/^[0-3]$/.test(seat)) || (reveal !== null && reveal !== "0" && reveal !== "1")) return invalid();
  return { ok: true as const, input: {
    ...(version !== null ? { version: Number(version) as 1 | 2 } : privileged ? { version: 2 as const } : {}),
    ...(visibility !== null ? { visibility: visibility as "mine" | "public" } : {}),
    ...(seat !== null ? { seat: Number(seat) } : {}), ...(reveal !== null ? { reveal: reveal === "1" } : {}),
  } };
}

export function sessionFromHost(data: unknown) {
  if (data && typeof data === "object" && "session" in data) {
    return { session: data.session };
  }
  return { session: data };
}

/** Typed operator snapshot over the same HMAC-authenticated internal channel. */
export async function callEngineDataStatus(input: { guildId: string; playerId: number }): Promise<
  { ok: true; data: CardDataStatus } | { ok: false; response: NextResponse }
> {
  const result = await callDuelHost({ ...input, op: "engine-data-status" });
  if (!result.ok) return result;
  return { ok: true, data: result.data as CardDataStatus };
}
