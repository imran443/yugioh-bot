import type Database from "better-sqlite3";

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
  const row = db.prepare<[number, string], { user_id: number }>(`
    select p.user_id from players p join users u on u.id = p.user_id
    where p.id = ? and p.guild_id = ?
  `).get(actor.playerId, actor.guildId);
  if (!row || (actor.userId !== undefined && row.user_id !== actor.userId) || !isOwnerUser(row.user_id)) return null;
  return { guildId: actor.guildId, playerId: actor.playerId, userId: row.user_id };
}
