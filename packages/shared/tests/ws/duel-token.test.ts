import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createDuelConnectionToken,
  verifyDuelConnectionToken,
} from "../../src/ws/duel-token.js";
import type { DuelConnectionTokenClaims } from "../../src/ws/duel-token.js";

const SECRET = "ws-internal-secret";

function claims(overrides: Partial<DuelConnectionTokenClaims> = {}): DuelConnectionTokenClaims {
  return {
    slug: "room-a",
    guildId: "guild-1",
    playerId: 42,
    seat: 0,
    expiresAt: Date.now() + 60_000,
    ...overrides,
  };
}

function tamperPayload(token: string): string {
  const [payload, signature] = token.split(".");
  const raw = Buffer.from(payload, "base64url").toString("utf8");
  const parsed = JSON.parse(raw) as DuelConnectionTokenClaims;
  parsed.slug = "room-b";
  return `${Buffer.from(JSON.stringify(parsed), "utf8").toString("base64url")}.${signature}`;
}

describe("duel connection tokens", () => {
  it("round-trips strict claims", () => {
    const input = claims({ seat: null });
    const token = createDuelConnectionToken(input, SECRET);
    expect(verifyDuelConnectionToken(token, SECRET, input.expiresAt - 1)).toEqual(input);
  });

  it("rejects forged payloads that keep the original signature", () => {
    const token = createDuelConnectionToken(claims(), SECRET);
    expect(verifyDuelConnectionToken(tamperPayload(token), SECRET)).toBeNull();
  });

  it("rejects a token signed with a different secret", () => {
    const token = createDuelConnectionToken(claims(), SECRET);
    expect(verifyDuelConnectionToken(token, "other-secret")).toBeNull();
  });

  it("rejects expired tokens", () => {
    const input = claims({ expiresAt: 1_700_000_000_000 });
    const token = createDuelConnectionToken(input, SECRET);
    expect(verifyDuelConnectionToken(token, SECRET, input.expiresAt)).toBeNull();
    expect(verifyDuelConnectionToken(token, SECRET, input.expiresAt + 1)).toBeNull();
    expect(verifyDuelConnectionToken(token, SECRET, input.expiresAt - 1)).toEqual(input);
  });

  it("rejects extra or missing claim fields", () => {
    const valid = claims();
    const payload = Buffer.from(JSON.stringify({ ...valid, role: "admin" }), "utf8");
    const signature = createHmac("sha256", SECRET).update(payload).digest("base64url");
    const extra = `${payload.toString("base64url")}.${signature}`;
    expect(verifyDuelConnectionToken(extra, SECRET, valid.expiresAt - 1)).toBeNull();


    const missingSeat = Buffer.from(
      JSON.stringify({
        slug: valid.slug,
        guildId: valid.guildId,
        playerId: valid.playerId,
        expiresAt: valid.expiresAt,
      }),
      "utf8",
    );
    const missingSig = createHmac("sha256", SECRET).update(missingSeat).digest("base64url");
    expect(
      verifyDuelConnectionToken(`${missingSeat.toString("base64url")}.${missingSig}`, SECRET, valid.expiresAt - 1),
    ).toBeNull();
  });

  it("rejects non-integer identifiers and empty room fields", () => {
    expect(() => createDuelConnectionToken(claims({ playerId: 1.5 }), SECRET)).toThrow();
    expect(() => createDuelConnectionToken(claims({ seat: -1 }), SECRET)).toThrow();
    expect(() => createDuelConnectionToken(claims({ slug: "" }), SECRET)).toThrow();
    expect(() => createDuelConnectionToken(claims(), "")).toThrow();
  });

  it("rejects malformed tokens and empty secrets without throwing", () => {
    expect(verifyDuelConnectionToken("not-a-token", SECRET)).toBeNull();
    expect(verifyDuelConnectionToken("a.b.c", SECRET)).toBeNull();
    expect(verifyDuelConnectionToken(createDuelConnectionToken(claims(), SECRET), "")).toBeNull();
  });
});

it("rejects unsafe player identities and seats outside the four-seat contract", () => {
  expect(() => createDuelConnectionToken(claims({ playerId: Number.MAX_SAFE_INTEGER + 1 }), SECRET)).toThrow();
  expect(() => createDuelConnectionToken(claims({ seat: 4 }), SECRET)).toThrow();
});
