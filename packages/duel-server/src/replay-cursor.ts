import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import type { ReplayCursor, ReplaySource } from "@yugidraft/shared/duels";

export class ReplayCursorError extends Error {
  readonly status: number;
  constructor(readonly code: "INVALID_CURSOR" | "SOURCE_CHANGED") {
    super(code === "SOURCE_CHANGED" ? "The source changed. Refresh the replay." : "Invalid replay cursor");
    this.status = code === "SOURCE_CHANGED" ? 409 : 400;
  }
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value)
    .filter(([, entry]) => entry !== undefined).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, entry]) => [key, canonical(entry)]));
  return value;
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

/** Internal trusted source only. Includes original decks, rules, identity and ordered stored sequence IDs. */
export function replaySourceVersion(source: ReplaySource): string { return digest(source); }

/** Hash ordered accepted inputs. Database sequence IDs are not copied into the new duel. */
export function replayPrefixHash(source: ReplaySource, prefixCount: number): string {
  if (!Number.isSafeInteger(prefixCount) || prefixCount < 0 || prefixCount > source.commands.length) throw new ReplayCursorError("INVALID_CURSOR");
  return replayPrefixHashes({ ...source, commands: source.commands.slice(0, prefixCount) })[prefixCount]!;
}

/** One rolling hash pass for a replay; copying the hash state avoids rehashing every earlier input for each frame. */
export function replayPrefixHashes(source: ReplaySource): string[] {
  const hash = createHash("sha256").update("[");
  const hashes = [hash.copy().update("]").digest("hex")];
  source.commands.forEach(({ seat, command }, index) => {
    if (index > 0) hash.update(",");
    hash.update(JSON.stringify(canonical({ seat, command })));
    hashes.push(hash.copy().update("]").digest("hex"));
  });
  return hashes;
}

export function replayFrameId(sourceVersion: string, step: number): string { return `${sourceVersion}:${step}`; }

/** Encrypted server metadata; never put these fields in a replay response outside the sealed cursor. */
export interface ReplayCursorClaims {
  sourceId: number;
  sourceSlug: string;
  guildId: string;
  sourceVersion: string;
  frameId: string;
  step: number;
  prefixCount: number;
  prefixHash: string;
  revision: number;
}

export interface ReplayCursorCodec {
  seal(claims: ReplayCursorClaims): ReplayCursor;
  open(cursor: ReplayCursor): ReplayCursorClaims;
}

function validClaims(value: unknown): value is ReplayCursorClaims {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const c = value as ReplayCursorClaims;
  const integer = (n: number) => Number.isSafeInteger(n) && n >= 0;
  const text = (s: string) => typeof s === "string" && s.length > 0 && s.length <= 200;
  const hash = (s: string) => typeof s === "string" && /^[a-f0-9]{64}$/.test(s);
  return Object.keys(c).length === 9 && integer(c.sourceId) && c.sourceId > 0 && text(c.sourceSlug)
    && text(c.guildId) && hash(c.sourceVersion) && text(c.frameId) && integer(c.step)
    && integer(c.prefixCount) && hash(c.prefixHash) && integer(c.revision);
}

/** AES-GCM conceals private prefix counts. The internal service secret supports restarts on the same deployment. */
export function createReplayCursorCodec(secret: string): ReplayCursorCodec {
  if (!secret) throw new Error("Replay cursor secret is required");
  const key = createHash("sha256").update("dueling-domain/replay-cursor/v1\0").update(secret).digest();
  const aad = Buffer.from("dueling-domain/replay-cursor/v1");
  return {
    seal(claims) {
      if (!validClaims(claims)) throw new ReplayCursorError("INVALID_CURSOR");
      const nonce = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, nonce); cipher.setAAD(aad);
      const encrypted = Buffer.concat([cipher.update(JSON.stringify(claims), "utf8"), cipher.final()]);
      return "r1." + Buffer.concat([nonce, cipher.getAuthTag(), encrypted]).toString("base64url");
    },
    open(cursor) {
      try {
        if (typeof cursor !== "string" || cursor.length > 2048 || !/^r1\.[A-Za-z0-9_-]+$/.test(cursor)) throw new Error();
        const encoded = cursor.slice(3); const packed = Buffer.from(encoded, "base64url");
        if (packed.length <= 28 || packed.toString("base64url") !== encoded) throw new Error();
        const decipher = createDecipheriv("aes-256-gcm", key, packed.subarray(0, 12));
        decipher.setAAD(aad); decipher.setAuthTag(packed.subarray(12, 28));
        const claims: unknown = JSON.parse(Buffer.concat([decipher.update(packed.subarray(28)), decipher.final()]).toString("utf8"));
        if (!validClaims(claims)) throw new Error();
        return claims;
      } catch { throw new ReplayCursorError("INVALID_CURSOR"); }
    },
  };
}

/** B4 must check current actor/source access BEFORE calling this. A cursor is never an access grant. */
export function resolveReplayCursor(codec: ReplayCursorCodec, cursor: ReplayCursor, source: ReplaySource): ReplayCursorClaims {
  const claims = codec.open(cursor);
  if (claims.sourceId !== source.session.id || claims.sourceSlug !== source.session.slug || claims.guildId !== source.session.guildId) {
    throw new ReplayCursorError("INVALID_CURSOR");
  }
  if (claims.sourceVersion !== replaySourceVersion(source)) throw new ReplayCursorError("SOURCE_CHANGED");
  if (claims.prefixHash !== replayPrefixHash(source, claims.prefixCount)) throw new ReplayCursorError("INVALID_CURSOR");
  return claims;
}
