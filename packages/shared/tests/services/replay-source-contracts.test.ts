import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { migrate } from "../../src/db/index.js";
import { seatCountFor, type DuelFormat, type EngineIdentity } from "../../src/duels/index.js";
import { createDuelService } from "../../src/services/duels.js";
import { seedIdentity } from "../helpers/identity.js";

const databases: Database.Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

function setup(format: DuelFormat) {
  const db = new Database(":memory:");
  databases.push(db);
  migrate(db);
  const creator = seedIdentity(db, { guildId: "test-guild", userId: 101, playerId: 9 });
  const duels = createDuelService(db);
  const session = duels.create({
    guildId: "test-guild", organizerPlayerId: creator.playerId, name: "Source", mode: "normal", format,
  });
  duels.setDeck(session.slug, "test-guild", creator.playerId, {
    main: Array.from({ length: 40 }, (_, i) => i + 1), extra: [], side: [],
  });
  for (let seat = 1; seat < seatCountFor(format); seat += 1) {
    duels.addPracticeBot(session.slug, "test-guild", creator.playerId, {
      main: Array.from({ length: 40 }, (_, i) => seat * 100 + i), extra: [], side: [],
    }, seat);
  }
  return { db, duels, session, creator };
}

describe("internal replay source reads", () => {
  it.each(["1v1", "ffa3", "tag", "ffa4"] as const)("projects play kind for old %s rows", (format) => {
    const { duels, session, creator } = setup(format);
    expect(session.kind).toBe("play");
    expect(duels.get(session.slug, "test-guild").kind).toBe("play");
    expect(duels.room(session.slug, "test-guild", creator.playerId).session.kind).toBe("play");
    expect(duels.list("test-guild", creator.playerId)[0]?.kind).toBe("play");
    expect(duels.privateState(session.slug, "test-guild").session.kind).toBe("play");
    expect(creator.userId).not.toBe(creator.playerId);
  });

  it("returns actual ordered sequence IDs, including gaps and private no-op commands", () => {
    const { db, duels, session, creator } = setup("ffa4");
    duels.activate(session.slug, "test-guild", creator.playerId, ["1", "2", "3", "4"], "bundle-v1", null);
    const entries = [
      { storedSeq: 2, seat: 0, command: { promptId: "answer-1", revision: 3, answer: { choice: "go" } } },
      { storedSeq: 8, seat: 3, command: { promptId: "chain-mode:off", revision: 3, answer: {} } },
      { storedSeq: 11, seat: 2, command: { promptId: "eliminate:4", revision: 3, answer: {} } },
    ];
    const insert = db.prepare("insert into duel_commands(duel_id,seq,seat,command_json) values(?,?,?,?)");
    for (const entry of [...entries].reverse()) insert.run(session.id, entry.storedSeq, entry.seat, JSON.stringify(entry.command));
    expect(duels.privateState(session.slug, "test-guild").commands).toEqual(entries);
    const room = duels.room(session.slug, "test-guild", creator.playerId);
    for (const key of ["commands", "seed", "bundleVersion", "setup", "replayFork", "engineIdentity"]) {
      expect(room).not.toHaveProperty(key);
      expect(room.session).not.toHaveProperty(key);
    }
  });
});

const identity: EngineIdentity = {
  version: 1, coreFamily: "pinned", mode: "normal", wasmHash: "a".repeat(64),
  wrapperVersion: "0.1.2", wrapperHash: "b".repeat(64), protocolVersion: "duel-worker-1",
  cardDatabaseHash: "c".repeat(64), cardRemapsHash: null, cardScriptsHash: "d".repeat(64),
  domainScriptHash: null, multiOverlayHash: null, hostRuleVersion: "duel-rules-1",
};

describe("recorded engine identity", () => {
  it("rejects identity in a normal activation setup", () => {
    const { duels, session, creator } = setup("1v1");
    expect(() => duels.activate(session.slug, "test-guild", creator.playerId, ["1", "2", "3", "4"], "bundle-1", null, {
      engineIdentity: identity,
    })).toThrow(/Unknown duel setup field: engineIdentity/);
    expect(duels.get(session.slug, "test-guild").status).toBe("lobby");
  });

  it("stores server identity atomically at activation and keeps it private", () => {
    const { duels, session, creator } = setup("1v1");
    duels.activateRecorded(session.slug, "test-guild", creator.playerId, ["1", "2", "3", "4"], "bundle-1", null, {
      engine: "pinned", firstTurnDraw: false, scriptErrorMode: "tolerant",
    }, identity);
    expect(duels.privateState(session.slug, "test-guild").setup?.engineIdentity).toEqual(identity);
    expect(duels.room(session.slug, "test-guild", creator.playerId)).not.toHaveProperty("engineIdentity");
    const saved = duels.privateState(session.slug, "test-guild").setup!;
    const { engineIdentity: _identity, ...rules } = saved;
    duels.setSetup(session.slug, "test-guild", { ...rules, surrenderedSeats: [1] });
    expect(duels.privateState(session.slug, "test-guild").setup).toEqual({ ...saved, surrenderedSeats: [1] });
  });

  it.each(["replace", "clear"])("refuses to %s a recorded identity", (action) => {
    const { duels, session, creator } = setup("1v1");
    duels.activateRecorded(session.slug, "test-guild", creator.playerId, ["1", "2", "3", "4"], "bundle-1", null, {}, identity);
    const next = action === "clear" ? null : { engineIdentity: { ...identity, wasmHash: "0".repeat(64) } };
    expect(() => duels.setSetup(session.slug, "test-guild", next)).toThrow(/identity.*immutable|Unknown duel setup field: engineIdentity/i);
    expect(duels.privateState(session.slug, "test-guild").setup?.engineIdentity).toEqual(identity);
  });

  it("preserves recorded identity when a normal update omits it", () => {
    const { duels, session, creator } = setup("1v1");
    duels.activateRecorded(session.slug, "test-guild", creator.playerId, ["1", "2", "3", "4"], "bundle-1", null, {}, identity);
    duels.setSetup(session.slug, "test-guild", {});
    expect(duels.privateState(session.slug, "test-guild").setup?.engineIdentity).toEqual(identity);
  });

  it("does not permit identity before activation", () => {
    const { duels, session } = setup("1v1");
    expect(() => duels.setSetup(session.slug, "test-guild", { engineIdentity: identity })).toThrow(/Unknown duel setup field: engineIdentity/);
  });

  it("does not backfill an old active game's identity", () => {
    const { duels, session, creator } = setup("1v1");
    duels.activate(session.slug, "test-guild", creator.playerId, ["1", "2", "3", "4"], "old-bundle", null);
    expect(() => duels.setSetup(session.slug, "test-guild", { engineIdentity: identity })).toThrow(/Unknown duel setup field: engineIdentity/);
    expect(duels.privateState(session.slug, "test-guild").setup?.engineIdentity).toBeUndefined();
  });

  it("rejects malformed identity and rolls back activation", () => {
    const { duels, session, creator } = setup("1v1");
    expect(() => duels.activateRecorded(session.slug, "test-guild", creator.playerId, ["1", "2", "3", "4"], "bundle-1", null,
      {}, { ...identity, wasmHash: "wrong" })).toThrow(/invalid engine identity/i);
    expect(duels.get(session.slug, "test-guild").status).toBe("lobby");
    expect(duels.privateState(session.slug, "test-guild").seed).toBeNull();
  });
});
