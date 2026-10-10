import { createHmac, timingSafeEqual } from "node:crypto";

export const DUEL_CONNECTION_TTL_MS = 5 * 60 * 1000;

export type DuelConnectionTokenClaims = {
  slug: string;
  guildId: string;
  playerId: number;
  /** Stored connection identity. A fork always uses creator seat 0, never its acting seat. */
  seat: number | null;
  expiresAt: number;
};

export type DuelConnectionResponse = {
  token: string;
  guildId: string;
  expiresAt: number;
};

export type DuelJoinAck =
  | { ok: true; onlineSeats: number[]; spectatorCount: number }
  | { ok: false; error: string };

export type DuelChangedPayload = {
  slug: string;
};

export type DuelPresencePayload = {
  slug: string;
  /** Seats with at least one connected, visible duel tab; observers do not count. */
  onlineSeats: number[];
  spectatorCount: number;
};

export type DuelSubscriptionExpiredPayload = {
  slug: string;
};

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

function isDuelConnectionTokenClaims(v: unknown): v is DuelConnectionTokenClaims {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  if (Object.keys(o).length !== 5) return false;
  if (!("slug" in o) || !("guildId" in o) || !("playerId" in o) || !("seat" in o) || !("expiresAt" in o)) {
    return false;
  }
  if (!isNonEmptyString(o.slug) || !isNonEmptyString(o.guildId)) return false;
  if (typeof o.playerId !== "number" || !Number.isSafeInteger(o.playerId) || o.playerId <= 0) return false;
  if (o.seat !== null) {
    if (typeof o.seat !== "number" || !Number.isInteger(o.seat) || o.seat < 0 || o.seat > 3) return false;
  }
  if (typeof o.expiresAt !== "number" || !Number.isInteger(o.expiresAt) || !Number.isFinite(o.expiresAt)) {
    return false;
  }
  return true;
}

function canonicalPayload(claims: DuelConnectionTokenClaims): Buffer {
  return Buffer.from(
    JSON.stringify({
      slug: claims.slug,
      guildId: claims.guildId,
      playerId: claims.playerId,
      seat: claims.seat,
      expiresAt: claims.expiresAt,
    }),
    "utf8",
  );
}

function hmacDigest(secret: string, payload: Buffer): Buffer {
  return createHmac("sha256", secret).update(payload).digest();
}

function signaturesMatch(received: Buffer, expected: Buffer): boolean {
  if (received.length !== expected.length) return false;
  return timingSafeEqual(received, expected);
}

export function createDuelConnectionToken(claims: DuelConnectionTokenClaims, secret: string): string {
  if (!secret) throw new Error("Missing duel connection secret");
  if (!isDuelConnectionTokenClaims(claims)) throw new Error("Invalid duel connection claims");
  const payload = canonicalPayload(claims);
  return `${payload.toString("base64url")}.${hmacDigest(secret, payload).toString("base64url")}`;
}

export function verifyDuelConnectionToken(
  token: string,
  secret: string,
  now: number = Date.now(),
): DuelConnectionTokenClaims | null {
  if (!secret || typeof token !== "string") return null;
  const separator = token.indexOf(".");
  if (separator <= 0 || token.indexOf(".", separator + 1) !== -1) return null;
  const payloadPart = token.slice(0, separator);
  const signaturePart = token.slice(separator + 1);
  if (!payloadPart || !signaturePart) return null;

  const payload = Buffer.from(payloadPart, "base64url");
  const received = Buffer.from(signaturePart, "base64url");
  if (payload.length === 0 || received.length === 0) return null;
  if (!signaturesMatch(received, hmacDigest(secret, payload))) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(payload.toString("utf8"));
  } catch {
    return null;
  }
  if (!isDuelConnectionTokenClaims(parsed)) return null;
  if (parsed.expiresAt <= now) return null;
  return {
    slug: parsed.slug,
    guildId: parsed.guildId,
    playerId: parsed.playerId,
    seat: parsed.seat,
    expiresAt: parsed.expiresAt,
  };
}
