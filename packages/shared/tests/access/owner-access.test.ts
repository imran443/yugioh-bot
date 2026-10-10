import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { migrate } from "../../src/db/index.js";
import { seedIdentity } from "../helpers/identity.js";
import { isOwnerUser, ownerUserIds, resolveOwnerPlayer } from "../../src/access/owner-access.js";

afterEach(() => vi.unstubAllEnvs());

describe("application owner IDs", () => {
  it("allows the owner and approved developers", () => {
    vi.stubEnv("OWNER_USER_IDS", " 101, 102,101 ");
    expect(ownerUserIds()).toEqual(new Set([101, 102]));
    expect(isOwnerUser(101)).toBe(true);
    expect(isOwnerUser(102)).toBe(true);
    expect(isOwnerUser(103)).toBe(false);
  });

  it.each([undefined, "", " ", "0,-1,+1,01,1.0,1e3,abc,9007199254740992,Infinity"])("denies an empty or malformed list: %s", value => {
    vi.stubEnv("OWNER_USER_IDS", value);
    expect(ownerUserIds().size).toBe(0);
    expect(isOwnerUser(101)).toBe(false);
  });

  it.each([0, -1, 1.5, NaN, Infinity, 9007199254740992, "101", null, undefined])("denies a malformed user ID: %s", value => {
    vi.stubEnv("OWNER_USER_IDS", "101,9007199254740992");
    expect(isOwnerUser(value as number)).toBe(false);
  });

  it("checks revocation without a process restart", () => {
    vi.stubEnv("OWNER_USER_IDS", "101,102");
    expect(isOwnerUser(102)).toBe(true);
    vi.stubEnv("OWNER_USER_IDS", "101");
    expect(isOwnerUser(102)).toBe(false);
  });
});

describe("trusted player to user mapping", () => {
  let db: Database.Database;
  const actor = { guildId: "test-guild", playerId: 61, userId: 101 };
  beforeEach(() => {
    db = new Database(":memory:");
    migrate(db);
    seedIdentity(db, { ...actor, name: "Owner", discordUserId: "900000000000000101" });
    seedIdentity(db, { guildId: actor.guildId, playerId: 62, userId: 102, name: "Dev" });
    seedIdentity(db, { guildId: actor.guildId, playerId: 63, userId: 103, name: "Alpha" });
    vi.stubEnv("OWNER_USER_IDS", "101,102");
  });
  afterEach(() => db.close());

  it("resolves the same application user for web, host and service actors", () => {
    expect(resolveOwnerPlayer(db, actor)).toEqual(actor);
    expect(resolveOwnerPlayer(db, { guildId: actor.guildId, playerId: actor.playerId })).toEqual(actor);
    expect(resolveOwnerPlayer(db, { guildId: actor.guildId, playerId: 62 })).toEqual({ ...actor, playerId: 62, userId: 102 });
  });

  it("denies an alpha actor with a forged owner user ID", () => {
    expect(resolveOwnerPlayer(db, { ...actor, playerId: 63 })).toBeNull();
  });

  it("denies a forged user ID even for another approved developer", () => {
    expect(resolveOwnerPlayer(db, { ...actor, userId: 102 })).toBeNull();
  });

  it("does not treat a player or Discord ID as an application user ID", () => {
    vi.stubEnv("OWNER_USER_IDS", "61,900000000000000101");
    expect(resolveOwnerPlayer(db, actor)).toBeNull();
    vi.stubEnv("OWNER_USER_IDS", "101");
    expect(resolveOwnerPlayer(db, { ...actor, userId: actor.playerId })).toBeNull();
    expect(resolveOwnerPlayer(db, { ...actor, userId: "900000000000000101" as unknown as number })).toBeNull();
  });

  it("denies an actor in another guild", () => {
    expect(resolveOwnerPlayer(db, { ...actor, guildId: "other-guild" })).toBeNull();
  });

  it.each([0, -1, 1.5, 9007199254740992, 999, "61"])("denies an invalid or missing player: %s", value => {
    expect(resolveOwnerPlayer(db, { ...actor, playerId: value as number })).toBeNull();
  });

  it("denies a removed developer", () => {
    vi.stubEnv("OWNER_USER_IDS", "101");
    expect(resolveOwnerPlayer(db, { guildId: actor.guildId, playerId: 62 })).toBeNull();
  });
});
