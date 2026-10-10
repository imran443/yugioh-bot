import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { migrate } from "../../src/db/index.js";
import { createDuelService } from "../../src/services/duels.js";
import type { ReplayForkSetup } from "../../src/duels/index.js";
import {
  assertDuelForkAccess,
  assertOwnerReplaySourceAccess,
  assertReplayForkAccess,
} from "../../src/access/owner-access.js";
import { seedIdentity } from "../helpers/identity.js";

describe("server replay access guards", () => {
  let db: Database.Database;
  let sourceSlug: string;
  let otherGuildSlug: string;
  let forkSlug: string;
  const owner = { guildId: "test-guild", playerId: 61, userId: 101 };
  const dev = { ...owner, playerId: 62, userId: 102 };
  const alpha = { ...owner, playerId: 63, userId: 103 };
  const forkSetup: { replayFork: ReplayForkSetup } = {
    replayFork: {
      ownerUserId: owner.userId,
      control: "all-manual",
      origin: {
        sourceSlug: "source-fixture", sourceVersion: "version-fixture", frameId: "frame-0", step: 0,
        prefixCount: 0, prefixHash: "a".repeat(64),
        sourceSeats: [{ seat: 0, displayName: "Source A" }, { seat: 1, displayName: "Source B" }],
      },
    },
  };

  beforeEach(() => {
    db = new Database(":memory:");
    migrate(db);
    // B3 owns the production migration. Exercise its persisted-kind contract here.
    db.exec("alter table duels add column kind text not null default 'play'");
    for (const actor of [owner, dev, alpha]) seedIdentity(db, { ...actor, name: "Test actor" });
    const sourcePlayer = seedIdentity(db, { guildId: owner.guildId, playerId: 64, userId: 201, name: "Source A" });
    const otherPlayer = seedIdentity(db, { guildId: "other-guild", playerId: 65, userId: 202, name: "Other guild" });
    const duels = createDuelService(db);
    const input = { name: "Private bug-report source", mode: "normal" as const, settings: { visibility: "private" } };
    sourceSlug = duels.create({ ...input, guildId: owner.guildId, organizerPlayerId: sourcePlayer.playerId }).slug;
    otherGuildSlug = duels.create({ ...input, guildId: "other-guild", organizerPlayerId: otherPlayer.playerId }).slug;
    forkSlug = duels.create({ ...input, guildId: owner.guildId, organizerPlayerId: owner.playerId }).slug;
    db.prepare("update duels set kind = 'replay-fork', setup_json = ? where web_slug = ?")
      .run(JSON.stringify(forkSetup), forkSlug);
    vi.stubEnv("OWNER_USER_IDS", "101,102");
  });

  afterEach(() => { db.close(); vi.unstubAllEnvs(); });

  const denied = (work: () => unknown) => expect(work).toThrowError(expect.objectContaining({ status: 404, code: "ACCESS_DENIED" }));

  it.each([owner, dev])("allows a private source without a source seat or invite: $userId", actor => {
    const duels = createDuelService(db);
    expect(() => duels.room(sourceSlug, actor.guildId, actor.playerId)).toThrowError(expect.objectContaining({ status: 403 }));
    const before = db.serialize();
    expect(assertOwnerReplaySourceAccess(db, sourceSlug, actor)).toMatchObject({ slug: sourceSlug, guildId: actor.guildId, kind: "play" });
    expect(db.serialize()).toEqual(before);
  });

  it("checks owner access before source lookup", () => {
    const prepare = vi.spyOn(db, "prepare");
    denied(() => assertOwnerReplaySourceAccess(db, sourceSlug, alpha));
    expect(prepare.mock.calls.every(([sql]) => !/\bduels\b/.test(sql))).toBe(true);
  });

  it.each([undefined, "", "103", "01,abc,9007199254740992"])("denies an unset, revoked or malformed list: %s", ids => {
    vi.stubEnv("OWNER_USER_IDS", ids);
    denied(() => assertOwnerReplaySourceAccess(db, sourceSlug, owner));
  });

  it("hides other guild sources", () => {
    denied(() => assertOwnerReplaySourceAccess(db, otherGuildSlug, owner));
    denied(() => assertOwnerReplaySourceAccess(db, sourceSlug, { ...owner, guildId: "other-guild" }));
  });

  it("denies a forged actor", () => {
    denied(() => assertOwnerReplaySourceAccess(db, sourceSlug, { ...alpha, userId: owner.userId }));
    denied(() => assertOwnerReplaySourceAccess(db, sourceSlug, { ...owner, userId: dev.userId }));
  });

  it("allows only the current creator of a marked fork", () => {
    expect(assertReplayForkAccess(db, forkSlug, owner)).toMatchObject({ kind: "replay-fork", ownerUserId: owner.userId });
    expect(assertDuelForkAccess(db, forkSlug, owner)).toMatchObject({ kind: "replay-fork" });
    denied(() => assertReplayForkAccess(db, forkSlug, dev));
    denied(() => assertDuelForkAccess(db, forkSlug, alpha));
  });

  it("cannot use the privileged source read to open another creator's fork", () => {
    expect(assertOwnerReplaySourceAccess(db, forkSlug, owner)).toMatchObject({ kind: "replay-fork" });
    denied(() => assertOwnerReplaySourceAccess(db, forkSlug, dev));
  });

  it("revokes fork reads and retries at authorization time", () => {
    expect(assertReplayForkAccess(db, forkSlug, owner).kind).toBe("replay-fork");
    vi.stubEnv("OWNER_USER_IDS", "102");
    denied(() => assertReplayForkAccess(db, forkSlug, owner));
    denied(() => assertDuelForkAccess(db, forkSlug, owner));
    denied(() => assertOwnerReplaySourceAccess(db, forkSlug, owner));
  });

  it("preserves ordinary play access checks for the caller", () => {
    expect(assertDuelForkAccess(db, sourceSlug, alpha)).toMatchObject({ kind: "play" });
    denied(() => assertReplayForkAccess(db, sourceSlug, owner));
  });

  it.each([
    ["unknown", null],
    ["replay-fork", null],
    ["replay-fork", "{}"],
    ["replay-fork", "invalid-json"],
    ["replay-fork", JSON.stringify({ replayFork: { ...forkSetup.replayFork, ownerUserId: "101" } })],
    ["replay-fork", JSON.stringify({ ...forkSetup, botPolicies: { "1": "scripted" } })],
    ["play", JSON.stringify(forkSetup)],
  ])("denies inconsistent persisted kind/setup: %s, %s", (kind, setup) => {
    db.prepare("update duels set kind = ?, setup_json = ? where web_slug = ?").run(kind, setup, sourceSlug);
    denied(() => assertOwnerReplaySourceAccess(db, sourceSlug, owner));
    denied(() => assertDuelForkAccess(db, sourceSlug, owner));
  });

  it("ignores the duel name and normal private/unranked flags", () => {
    db.prepare("update duels set name = 'Replay fork', ranked = 0 where web_slug = ?").run(sourceSlug);
    expect(assertDuelForkAccess(db, sourceSlug, alpha).kind).toBe("play");
  });

  it("uses play for a pre-migration row and still rejects a stray fork mark", () => {
    db.exec("alter table duels drop column kind");
    expect(assertOwnerReplaySourceAccess(db, sourceSlug, owner).kind).toBe("play");
    denied(() => assertOwnerReplaySourceAccess(db, forkSlug, owner));
  });

  it.each(["", "x".repeat(129), "missing-source"])("hides invalid or absent sources: %s", slug => {
    denied(() => assertOwnerReplaySourceAccess(db, slug, owner));
  });

  it.each([assertOwnerReplaySourceAccess, assertReplayForkAccess, assertDuelForkAccess])("fails closed when the access database is unavailable: %s", guard => {
    const closed = new Database(":memory:");
    closed.close();
    expect(() => guard(closed, sourceSlug, owner)).toThrowError(expect.objectContaining({
      status: 503, code: "ACCESS_UNAVAILABLE", message: "Replay access is unavailable",
    }));
  });
});
