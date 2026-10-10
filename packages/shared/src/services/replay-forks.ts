import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import {
  assertOwnerReplaySourceAccess, assertReplayForkAccess, resolveOwnerPlayer, ReplayAccessError,
  type OwnerPlayerActor, type ResolvedOwnerActor,
} from "../access/owner-access.js";
import {
  isDuelKindSetup, isEngineIdentity, isReplayForkRequest, isReplayForkSetup, isReplaySeed, seatCountFor,
  REPLAY_SOURCE_SLUG_MAX_LENGTH,
  type DuelSession, type ForkOrigin, type ReplayForkSetup, type ReplayJournalEntry, type ReplaySource,
} from "../duels/index.js";
import { generateWebSlug } from "../util/web-slug.js";
import { createDuelService, DuelServiceError, validateSetup, type DuelPrivateState, type DuelSetup } from "./duels.js";

export class ReplayForkStorageError extends DuelServiceError {
  constructor(message: string, readonly code: "INVALID_CURSOR" | "SOURCE_CHANGED" | "REQUEST_CONFLICT" | "REPLAY_MISMATCH" | "NOT_PLAYABLE") {
    super(message, code === "INVALID_CURSOR" ? 400 : 409);
    this.name = "ReplayForkStorageError";
  }
}

/** Internal trusted input. The host checks the sealed cursor and detached engine checkpoint before storage. */
export interface ReplayForkCreateInput {
  actor: OwnerPlayerActor;
  requestId: string;
  /** SHA-256 of the exact sealed cursor. The cursor and its private contents are never returned in a session. */
  cursorDigest: string;
  /** The source snapshot used by the detached runner, not browser-supplied state. */
  source: ReplaySource;
  origin: ForkOrigin;
}

export interface ReplayForkRetryInput {
  actor: OwnerPlayerActor;
  requestId: string;
  sourceSlug: string;
  sourceVersion: string;
  cursorDigest: string;
}

export interface ReplayForkStored {
  session: DuelSession;
  /** A saved request already committed. The caller must close its extra detached worker and use the saved fork. */
  reused: boolean;
}

export interface ReplayForkService {
  /** No worker registration, automation, clocks, normal activation, grants, matches or notifications. */
  create(input: ReplayForkCreateInput): ReplayForkStored;
  /** Call before reading/running the source. Retries work after source deletion, with current creator access. */
  retry(input: ReplayForkRetryInput): ReplayForkStored | null;
  /** Creator-authorized copied input for recovery. No source row is required. */
  privateState(slug: string, actor: OwnerPlayerActor): DuelPrivateState;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, entry]) => [key, canonical(entry)]));
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

/** SHA-256 of canonical JSON for the ordered entries, including storedSeq, seat, command and saved diagnostic fields. */
export function hashReplayForkPrefix(entries: readonly ReplayJournalEntry[]): string {
  return createHash("sha256").update(JSON.stringify(canonical(entries))).digest("hex");
}

function invalid(message: string): never {
  throw new ReplayForkStorageError(message, "INVALID_CURSOR");
}

function validateRetry(input: ReplayForkRetryInput): void {
  if (!isReplayForkRequest({ requestId: input.requestId, sourceVersion: input.sourceVersion, cursor: "internal" })
    || typeof input.sourceSlug !== "string" || !input.sourceSlug || input.sourceSlug.length > REPLAY_SOURCE_SLUG_MAX_LENGTH
    || !/^[\x21-\x7e]+$/.test(input.sourceSlug)
    || typeof input.cursorDigest !== "string" || !/^[a-f0-9]{64}$/.test(input.cursorDigest)) invalid("Invalid replay fork request binding");
}

function requireOwner(db: Database.Database, actor: OwnerPlayerActor): ResolvedOwnerActor {
  const owner = resolveOwnerPlayer(db, actor);
  if (!owner) throw new ReplayAccessError();
  return owner;
}

function sourceSetup(state: DuelPrivateState): ReplaySource["setup"] {
  if (!state.setup) return undefined;
  const { engineIdentity: _identity, replayFork: _fork, ...rules } = state.setup;
  return rules;
}

function sourceMatches(current: DuelPrivateState, source: ReplaySource): boolean {
  const a = current.session, b = source.session;
  return a.id === b.id && a.slug === b.slug && a.guildId === b.guildId && a.kind === b.kind && a.status === b.status
    && a.mode === b.mode && a.format === b.format && a.masterRule === b.masterRule
    && sameJson(a.settings, b.settings) && sameJson(a.seats, b.seats)
    && sameJson(current.seed, source.seed) && current.bundleVersion === source.bundleVersion
    && sameJson(current.decks, source.decks) && sameJson(current.commands, source.commands)
    && sameJson(sourceSetup(current) ?? {}, source.setup ?? {})
    && sameJson(current.setup?.engineIdentity ?? null, source.engineIdentity);
}

function forkSetup(source: ReplaySource, replayFork: ReplayForkSetup): DuelSetup {
  // Admission/bot/scenario metadata is not engine creation input. Final host losses do not describe this earlier prefix.
  const { engineIdentity: _identity, replayFork: _fork, botPolicies: _bots, presetId: _preset, scenarioId: _scenario,
    surrenderedSeats: _losses, ...rules } = (source.setup ?? {}) as DuelSetup;
  const checked = validateSetup(rules);
  if (source.engineIdentity !== null && !isEngineIdentity(source.engineIdentity)) invalid("Invalid source engine identity");
  return { ...checked, ...(source.engineIdentity ? { engineIdentity: source.engineIdentity } : {}), replayFork };
}

function validateSource(source: ReplaySource, replayFork: ReplayForkSetup, actor: ResolvedOwnerActor): void {
  if (!isReplayForkSetup(replayFork) || !isDuelKindSetup("replay-fork", { replayFork }, source.session.format)) invalid("Invalid fork origin");
  const { origin } = replayFork, { session } = source;
  if (session.guildId !== actor.guildId || session.slug !== origin.sourceSlug) invalid("Fork source identity does not match");
  if (session.status !== "completed" && session.status !== "interrupted") {
    throw new ReplayForkStorageError("Only completed or interrupted sources can be forked", "NOT_PLAYABLE");
  }
  if (!isReplaySeed(source.seed) || typeof source.bundleVersion !== "string" || !source.bundleVersion.trim()) invalid("Invalid saved engine input");
  const count = seatCountFor(session.format);
  if (source.decks.length !== count || session.seats.length !== count || session.seats.some((seat, index) => seat.seat !== index)
    || !sameJson(origin.sourceSeats, session.seats.map(seat => ({ seat: seat.seat, displayName: seat.displayName })))) invalid("Invalid saved seat order");
  if (!Array.isArray(source.commands) || origin.prefixCount > source.commands.length) invalid("Invalid journal prefix count");
  let previous = 0;
  for (const entry of source.commands.slice(0, origin.prefixCount)) {
    if (!Number.isSafeInteger(entry.storedSeq) || entry.storedSeq <= previous
      || !Number.isInteger(entry.seat) || entry.seat < 0 || entry.seat >= count
      || !entry.command || typeof entry.command.promptId !== "string" || !entry.command.promptId
      || !Number.isSafeInteger(entry.command.revision) || entry.command.revision < 0
      || !entry.command.answer || typeof entry.command.answer !== "object" || Array.isArray(entry.command.answer)) invalid("Invalid saved journal command");
    previous = entry.storedSeq;
  }
  if (hashReplayForkPrefix(source.commands.slice(0, origin.prefixCount)) !== origin.prefixHash) {
    throw new ReplayForkStorageError("Copied journal prefix hash does not match", "REPLAY_MISMATCH");
  }
}

export function createReplayForkService(db: Database.Database): ReplayForkService {
  const duels = createDuelService(db);
  const selectRequest = db.prepare<[number, string], {
    source_slug: string; source_version: string; cursor_digest: string; fork_duel_id: number;
  }>("select source_slug, source_version, cursor_digest, fork_duel_id from replay_fork_requests where owner_user_id = ? and request_id = ?");
  const selectFork = db.prepare<[number], { web_slug: string; guild_id: string }>("select web_slug, guild_id from duels where id = ?");

  const savedRetry = (input: ReplayForkRetryInput, owner: ResolvedOwnerActor): ReplayForkStored | null => {
    const saved = selectRequest.get(owner.userId, input.requestId);
    if (!saved) return null;
    const fork = selectFork.get(saved.fork_duel_id);
    if (!fork || fork.guild_id !== owner.guildId) throw new ReplayAccessError();
    assertReplayForkAccess(db, fork.web_slug, owner);
    if (saved.source_slug !== input.sourceSlug || saved.source_version !== input.sourceVersion || saved.cursor_digest !== input.cursorDigest) {
      throw new ReplayForkStorageError("Replay fork request key was used for a different source or cursor", "REQUEST_CONFLICT");
    }
    return { session: duels.get(fork.web_slug, owner.guildId), reused: true };
  };

  const retryTx = db.transaction((input: ReplayForkRetryInput) => {
    const owner = requireOwner(db, input.actor);
    validateRetry(input);
    return savedRetry(input, owner);
  });

  const createTx = db.transaction((input: ReplayForkCreateInput): ReplayForkStored => {
    const owner = requireOwner(db, input.actor);
    const retry = { actor: owner, requestId: input.requestId, sourceSlug: input.origin.sourceSlug,
      sourceVersion: input.origin.sourceVersion, cursorDigest: input.cursorDigest };
    validateRetry(retry);
    const saved = savedRetry(retry, owner);
    if (saved) return saved;

    // Access and the snapshot are checked under the same write lock as the insert. The source is read-only.
    assertOwnerReplaySourceAccess(db, input.origin.sourceSlug, owner);
    const current = duels.privateState(input.origin.sourceSlug, owner.guildId);
    if (!sourceMatches(current, input.source)) throw new ReplayForkStorageError("The source changed after checkpoint validation", "SOURCE_CHANGED");
    const replayFork: ReplayForkSetup = { ownerUserId: owner.userId, control: "all-manual", origin: input.origin };
    validateSource(input.source, replayFork, owner);
    const setup = forkSetup(input.source, replayFork), source = input.source;
    // Retain recorded engine rules in settings. A null clock disables live timers; no opening or invite is created.
    const settings = { ...source.session.settings, visibility: "private" };
    const slug = generateWebSlug();
    const inserted = db.prepare(`insert into duels (
      guild_id,web_slug,name,organizer_player_id,mode,master_rule,status,kind,format,settings_json,
      seed_json,bundle_version,setup_json,best_of,ranked,series_id,game_number,clock_json,opening_json,invite_code,last_activity_at
    ) values (?,?,?,?,?,?,'active','replay-fork',?,?,?,?,?,1,0,null,null,null,null,null,datetime('now'))`)
      .run(owner.guildId, slug, "Replay fork", owner.playerId, source.session.mode, source.session.masterRule,
        source.session.format, JSON.stringify(settings), JSON.stringify(source.seed), source.bundleVersion, JSON.stringify(setup));
    const duelId = Number(inserted.lastInsertRowid);
    const insertSeat = db.prepare("insert into duel_seats(duel_id,seat,player_id,is_bot,ready,deck_json) values(?,?,?,?,1,?)");
    for (let seat = 0; seat < source.decks.length; seat++) {
      insertSeat.run(duelId, seat, seat === 0 ? owner.playerId : null, seat === 0 ? 0 : 1, JSON.stringify(source.decks[seat]));
    }
    // Copy the stored JSON exactly, with the original sequence IDs and dates. No prefix command is rewritten.
    db.prepare(`insert into duel_commands(duel_id,seq,seat,command_json,created_at)
      select ?,seq,seat,command_json,created_at from duel_commands where duel_id = ? order by seq limit ?`)
      .run(duelId, source.session.id, input.origin.prefixCount);
    db.prepare(`insert into replay_fork_requests(owner_user_id,request_id,source_slug,source_version,cursor_digest,fork_duel_id)
      values(?,?,?,?,?,?)`).run(owner.userId, input.requestId, input.origin.sourceSlug, input.origin.sourceVersion, input.cursorDigest, duelId);
    return { session: duels.get(slug, owner.guildId), reused: false };
  });

  return {
    create: input => createTx.immediate(input),
    retry: input => retryTx.immediate(input),
    privateState(slug, actor) {
      assertReplayForkAccess(db, slug, actor);
      const state = duels.privateState(slug, actor.guildId);
      const origin = state.setup!.replayFork!.origin;
      if (state.commands.length < origin.prefixCount || hashReplayForkPrefix(state.commands.slice(0, origin.prefixCount)) !== origin.prefixHash) {
        throw new ReplayForkStorageError("Stored replay fork prefix is corrupt", "REPLAY_MISMATCH");
      }
      return state;
    },
  };
}
