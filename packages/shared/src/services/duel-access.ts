import Database from "better-sqlite3";
import { isOwnerUser } from "../access/owner-access.js";
import { isDuelKind, isDuelKindSetup, isReplayFork, isDuelFormat, type DuelKind, type ReplayForkSetup } from "../duels/index.js";
import type { DuelConnectionTokenClaims } from "../ws/duel-token.js";
import { isDuelInviteReference } from "../notify/announce-payload.js";
import { resolveDraftDatabasePath } from "./draft-access.js";

export interface DuelEventTarget {
  id: number;
  slug: string;
  guildId: string;
  kind: DuelKind;
  ownerUserId: number | null;
}

type AccessRow = { id: number; web_slug: string; guild_id: string; kind: unknown; setup_json: string | null;
  format: unknown; settings_json: string; organizer_player_id: number };

function loadTarget(db: Database.Database, slug: string, guildId: string): { row: AccessRow; target: DuelEventTarget } | null {
  if (typeof slug !== "string" || !slug || typeof guildId !== "string" || !guildId) return null;
  const row = db.prepare("select id,web_slug,guild_id,kind,setup_json,format,settings_json,organizer_player_id from duels where web_slug=? and guild_id=?")
    .get(slug, guildId) as AccessRow | undefined;
  if (!row || !isDuelKind(row.kind) || !isDuelFormat(row.format)) return null;
  const setup: unknown = row.setup_json === null ? undefined : JSON.parse(row.setup_json);
  if (!isDuelKindSetup(row.kind, setup, row.format)) return null;
  return { row, target: { id: row.id, slug: row.web_slug, guildId: row.guild_id, kind: row.kind,
    ownerUserId: isReplayFork(row) ? (setup as { replayFork: ReplayForkSetup }).replayFork.ownerUserId : null } };
}

/** Server-only event routing metadata. A stored reference never grants read access. */
export function findDuelEventTarget(db: Database.Database, slug: string, guildId: string): DuelEventTarget | null {
  try { return loadTarget(db, slug, guildId)?.target ?? null; } catch { return null; }
}

/** Recheck persisted identity and access on join and before each broadcast. Never trust an acting seat. */
export function canReadDuel(db: Database.Database, claims: Pick<DuelConnectionTokenClaims, "slug" | "guildId" | "playerId" | "seat">): boolean {
  try {
    if (!Number.isSafeInteger(claims.playerId) || claims.playerId <= 0
      || (claims.seat !== null && (!Number.isInteger(claims.seat) || claims.seat < 0 || claims.seat > 3))) return false;
    const stored = loadTarget(db, claims.slug, claims.guildId);
    if (!stored) return false;
    const { row, target } = stored;
    const player = db.prepare("select p.user_id from players p join users u on u.id=p.user_id where p.id=? and p.guild_id=?")
      .get(claims.playerId, claims.guildId) as { user_id: number } | undefined;
    if (!player) return false;
    const seat = db.prepare("select seat from duel_seats where duel_id=? and player_id=?")
      .get(row.id, claims.playerId) as { seat: number } | undefined;
    if (isReplayFork(target)) return claims.seat === 0 && seat?.seat === 0
      && row.organizer_player_id === claims.playerId && target.ownerUserId === player.user_id && isOwnerUser(player.user_id);
    if (claims.seat !== null && claims.seat !== seat?.seat) return false;
    const settings: unknown = JSON.parse(row.settings_json);
    if (!settings || typeof settings !== "object" || Array.isArray(settings)) return false;
    if (!("visibility" in settings) || settings.visibility === "public") return true;
    if (settings.visibility !== "private") return false;
    return row.organizer_player_id === claims.playerId || seat !== undefined
      || !!db.prepare("select 1 from duel_invite_grants where duel_id=? and player_id=?").get(row.id, claims.playerId);
  } catch { return false; }
}

/** Both invite senders and the bot sink bind the signed reference to one ordinary stored duel. */
export function assertDuelInviteTarget(db: Database.Database, reference: unknown): DuelEventTarget {
  if (!isDuelInviteReference(reference)) throw new Error("Invalid duel invite reference");
  const target = findDuelEventTarget(db, reference.slug, reference.guildId);
  if (!target || target.id !== reference.duelId || isReplayFork(target)) throw new Error("Duel invites are unavailable");
  return target;
}

/** Lazy readonly access to the database mounted by ws and bot. Missing data fails closed. */
export function createDuelAccessReader(databasePath = process.env.DATABASE_PATH ?? "./data/bot.sqlite") {
  const path = resolveDraftDatabasePath(databasePath);
  let db: Database.Database | undefined;
  function read<T>(work: (database: Database.Database) => T, fallback: T): T {
    try { db ??= new Database(path, { readonly: true, fileMustExist: true }); return work(db); } catch { return fallback; }
  }
  return {
    canReadDuel: (claims: DuelConnectionTokenClaims) => read(database => canReadDuel(database, claims), false),
    findDuelEventTarget: (slug: string, guildId: string) => read(database => findDuelEventTarget(database, slug, guildId), null),
    close() { db?.close(); db = undefined; },
  };
}
