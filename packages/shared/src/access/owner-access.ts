import type Database from "better-sqlite3";
import { DEFAULT_DUEL_KIND, isDuelKind, isDuelKindSetup, isReplayFork, type DuelKind } from "../duels/duel-kind.js";
import { REPLAY_SOURCE_SLUG_MAX_LENGTH, type ReplayForkSetup } from "../duels/replay-fork.js";

/** Application users.id values. Read at authorization time; an empty list grants no access. */
export function ownerUserIds(): Set<number> {
  const ids = new Set<number>();
  for (const part of (process.env.OWNER_USER_IDS ?? "").split(",")) {
    const value = part.trim();
    if (!/^[1-9]\d*$/.test(value)) continue;
    const id = Number(value);
    if (Number.isSafeInteger(id)) ids.add(id);
  }
  return ids;
}

export function isOwnerUser(userId: number): boolean {
  return Number.isSafeInteger(userId) && userId > 0 && ownerUserIds().has(userId);
}

export interface OwnerPlayerActor {
  guildId: string;
  playerId: number;
  /** An assertion from the web session, never an authority. The database mapping must match. */
  userId?: number;
}

export interface ResolvedOwnerActor extends OwnerPlayerActor {
  userId: number;
}

/**
 * For trusted server actors only. The host must verify the internal signature first.
 * Host/service callers can supply a trusted player ID without a user ID. The stored
 * mapping and current allowlist determine access; request flags grant no authority.
 */
export function resolveOwnerPlayer(db: Database.Database, actor: OwnerPlayerActor): ResolvedOwnerActor | null {
  if (typeof actor.guildId !== "string" || !actor.guildId
    || !Number.isSafeInteger(actor.playerId) || actor.playerId <= 0
    || (actor.userId !== undefined && (!Number.isSafeInteger(actor.userId) || actor.userId <= 0))) return null;
  const row = readAccess(() => db.prepare<[number, string], { user_id: number }>(`
    select p.user_id from players p join users u on u.id = p.user_id
    where p.id = ? and p.guild_id = ?
  `).get(actor.playerId, actor.guildId));
  if (!row || (actor.userId !== undefined && row.user_id !== actor.userId) || !isOwnerUser(row.user_id)) return null;
  return { guildId: actor.guildId, playerId: actor.playerId, userId: row.user_id };
}

export class ReplayAccessError extends Error {
  readonly code: "ACCESS_DENIED" | "ACCESS_UNAVAILABLE";

  constructor(readonly status: 404 | 503 = 404) {
    super(status === 503 ? "Replay access is unavailable" : "Not found");
    this.name = "ReplayAccessError";
    this.code = status === 503 ? "ACCESS_UNAVAILABLE" : "ACCESS_DENIED";
  }
}

function readAccess<T>(read: () => T): T {
  try {
    return read();
  } catch {
    throw new ReplayAccessError(503);
  }
}

/** Server-only access metadata. This reference is not an access grant; recheck on each request and retry. */
export interface ReplayDuelAccess {
  id: number;
  slug: string;
  guildId: string;
  kind: DuelKind;
  ownerUserId: number | null;
}

function requireOwnerPlayer(db: Database.Database, actor: OwnerPlayerActor): ResolvedOwnerActor {
  const owner = resolveOwnerPlayer(db, actor);
  if (!owner) throw new ReplayAccessError();
  return owner;
}

function storedDuelAccess(db: Database.Database, slug: string, guildId: string): ReplayDuelAccess {
  if (typeof slug !== "string" || !slug || slug.length > REPLAY_SOURCE_SLUG_MAX_LENGTH
    || typeof guildId !== "string" || !guildId) throw new ReplayAccessError();
  const row = readAccess(() => db.prepare<[string, string], {
    id: number; web_slug: string; guild_id: string; kind?: unknown; setup_json: string | null;
  }>("select * from duels where web_slug = ? and guild_id = ?").get(slug, guildId));
  if (!row) throw new ReplayAccessError();
  // P0 predates B3's kind column. Only a row with no column uses the old play default.
  const kind = Object.hasOwn(row, "kind") ? row.kind : DEFAULT_DUEL_KIND;
  let setup: unknown;
  try {
    setup = row.setup_json === null ? undefined : JSON.parse(row.setup_json);
  } catch {
    throw new ReplayAccessError();
  }
  if (!isDuelKind(kind) || !isDuelKindSetup(kind, setup)) throw new ReplayAccessError();
  return {
    id: row.id, slug: row.web_slug, guildId: row.guild_id, kind,
    ownerUserId: isReplayFork({ kind }) ? (setup as { replayFork: ReplayForkSetup }).replayFork.ownerUserId : null,
  };
}

function assertCreator(source: ReplayDuelAccess, owner: ResolvedOwnerActor): void {
  if (isReplayFork(source) && source.ownerUserId !== owner.userId) throw new ReplayAccessError();
}

/**
 * Narrow diagnostic access to a play source in the trusted actor's guild, even without
 * a source seat or invite. A fork source still requires its creator. No writes or I/O.
 * Call before loading decks, journals, private snapshots, caches or retry results.
 */
export function assertOwnerReplaySourceAccess(db: Database.Database, slug: string, actor: OwnerPlayerActor): ReplayDuelAccess {
  const owner = requireOwnerPlayer(db, actor);
  const source = storedDuelAccess(db, slug, owner.guildId);
  assertCreator(source, owner);
  return source;
}

/** Dedicated fork paths reject play sources as well as unauthorized creators. */
export function assertReplayForkAccess(db: Database.Database, slug: string, actor: OwnerPlayerActor): ReplayDuelAccess {
  const source = assertOwnerReplaySourceAccess(db, slug, actor);
  if (!isReplayFork(source)) throw new ReplayAccessError();
  return source;
}

/**
 * Guard existing duel routes before data, actions or tokens. For play duels this adds
 * no access right: the caller must keep its normal room/action checks. For forks it
 * checks the current allowlist and stored creator, independent of seats and grants.
 */
export function assertDuelForkAccess(db: Database.Database, slug: string, actor: OwnerPlayerActor): ReplayDuelAccess {
  const source = storedDuelAccess(db, slug, actor.guildId);
  if (isReplayFork(source)) assertCreator(source, requireOwnerPlayer(db, actor));
  return source;
}
