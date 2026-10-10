import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { migrate } from "../../src/db/index.js";
import { seatCountFor, type DuelFormat } from "../../src/duels/index.js";
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
