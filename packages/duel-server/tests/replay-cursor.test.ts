import { describe, expect, it } from "vitest";
import { createReplayCursorCodec, replayPrefixHash, replaySourceVersion, resolveReplayCursor } from "../src/replay-cursor.js";
import { replaySource } from "./support/replay-fixtures.js";

describe("sealed replay cursors", () => {
  const codec = createReplayCursorCodec("cursor-test-secret");
  it("seals the exact prefix without readable counts and survives a host restart", () => {
    const source = replaySource();
    const claims = { sourceId: source.session.id, sourceSlug: source.session.slug, guildId: source.session.guildId,
      sourceVersion: replaySourceVersion(source), frameId: "frame-1", step: 1, prefixCount: 2,
      prefixHash: replayPrefixHash(source, 2), revision: 2 };
    const cursor = codec.seal(claims);
    expect(cursor).not.toContain("frame-1");
    expect(() => JSON.parse(Buffer.from(cursor.split(".")[1]!, "base64url").toString())).toThrow();
    expect(createReplayCursorCodec("cursor-test-secret").open(cursor)).toEqual(claims);
    expect(resolveReplayCursor(codec, cursor, source)).toEqual(claims);
  });
  it("rejects tampering, another key and malformed tokens", () => {
    const source = replaySource();
    const cursor = codec.seal({ sourceId: 1, sourceSlug: source.session.slug, guildId: source.session.guildId,
      sourceVersion: replaySourceVersion(source), frameId: "f0", step: 0, prefixCount: 0,
      prefixHash: replayPrefixHash(source, 0), revision: 1 });
    for (const token of ["", "1.abc", "x".repeat(5000), cursor.slice(0, -4) + "aaaa"]) {
      expect(() => codec.open(token)).toThrowError(expect.objectContaining({ code: "INVALID_CURSOR", status: 400 }));
    }
    expect(() => createReplayCursorCodec("other-secret").open(cursor)).toThrowError(expect.objectContaining({ code: "INVALID_CURSOR" }));
  });
  it("binds the source, rules, sequence IDs and journal; it grants no access", () => {
    const source = replaySource();
    const cursor = codec.seal({ sourceId: 1, sourceSlug: source.session.slug, guildId: source.session.guildId,
      sourceVersion: replaySourceVersion(source), frameId: "f0", step: 0, prefixCount: 0,
      prefixHash: replayPrefixHash(source, 0), revision: 1 });
    const changed = structuredClone(source); changed.commands[0]!.storedSeq++;
    expect(replaySourceVersion(changed)).not.toBe(replaySourceVersion(source));
    expect(() => resolveReplayCursor(codec, cursor, changed)).toThrowError(expect.objectContaining({ code: "SOURCE_CHANGED" }));
    changed.session.guildId = "other-guild";
    expect(() => resolveReplayCursor(codec, cursor, changed)).toThrowError(expect.objectContaining({ code: "INVALID_CURSOR" }));
    const reordered = { ...source, setup: { scriptErrorMode: "tolerant" as const, firstTurnDraw: false } };
    expect(replaySourceVersion(reordered)).toBe(replaySourceVersion(source));
  });
});
