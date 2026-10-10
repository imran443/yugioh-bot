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
import type { CardQuery, DuelChainMode, DuelCommand, DuelDeck, DuelFirstChoice, DuelMasterRule, DuelMode, DuelRpsMove } from "@yugidraft/shared/duels";
import { requireWebAccess } from "@/lib/web-access";
import { getDb } from "@/lib/db";
import { env } from "@/lib/env";
import type { CardDataStatus } from "@yugidraft/shared/types";

export type DuelHostOp = "engine-data-status" | "capabilities" | "view" | "start" | "respond" | "deck" | "validate-deck" | "validate-deck-master" | "cards" | "card-details" | "card-artworks" | "card-query" | "card-facets" | "surrender" | "add-bot" | "archive" | "cancel" | "replay" | "ready" | "unready" | "series-side" | "series-ready" | "series-unready" | "series-first" | "opening-pick" | "opening-choose" | "normalize-codes" | "check-deck" | "list-presets" | "start-preset" | "report" | "debug-trace" | "bug-context" | "chain-mode";

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

function hostErrorBody(text: string): { error: string; code?: string } {
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object" && "error" in parsed && typeof parsed.error === "string") {
      return { error: parsed.error, ...("code" in parsed && typeof parsed.code === "string" ? { code: parsed.code } : {}) };
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
  const cfg = { url: env.duelInternalUrl, secret: env.duelInternalSecret };
  const configProblem = duelHostConfigProblem(cfg);
  if (configProblem) {
    console.error(`[duel-host] ${configProblem}`);
    return { ok: false, response: NextResponse.json({ error: configProblem }, { status: 503 }) };
  }
  const transport = httpTransport({ ...cfg, ...(input.op === "engine-data-status" ? { timeoutMs: 5000 } : {}) });
  const payload: Record<string, unknown> = {
    op: input.op,
    guildId: input.guildId,
    playerId: input.playerId,
  };
  if (input.userId !== undefined) payload.userId = input.userId;
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
      return { ok: false, response: NextResponse.json({ error: unreachableMessage(result.text) }, { status: 503 }) };
    }
    if (result.status === 401) {
      // The host answers 401 only for a bad signature.
      const error = "The duel engine refused the web server: their DUEL_INTERNAL_SECRET values do not match. Ask the server admin to fix .env and restart both services.";
      console.error(`[duel-host] ${error}`);
      return { ok: false, response: NextResponse.json({ error }, { status: 503 }) };
    }
    return {
      ok: false,
      response: NextResponse.json(hostErrorBody(result.text), { status: result.status }),
    };
  }
  if (!result.text) {
    return { ok: false, response: NextResponse.json({ error: "Empty engine response" }, { status: 502 }) };
  }
  let data: unknown;
  try {
    data = JSON.parse(result.text);
  } catch {
    return { ok: false, response: NextResponse.json({ error: "Invalid engine response" }, { status: 502 }) };
  }
  return { ok: true, data: redactDuelResult(data, input.guildId, input.playerId) };
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
