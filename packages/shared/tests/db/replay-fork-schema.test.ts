import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { migrate } from "../../src/db/schema.js";
import { createDuelService } from "../../src/services/duels.js";
import { seedIdentity } from "../helpers/identity.js";

const databases: Database.Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

function database() {
  const db = new Database(":memory:");
  databases.push(db);
  db.pragma("foreign_keys = on");
  migrate(db);
  const owner = seedIdentity(db);
  return { db, owner };
}

describe("replay fork schema", () => {
  it("defaults existing duels to play and keeps the migration idempotent", () => {
    const { db, owner } = database();
    const old = createDuelService(db).create({ guildId: "g", organizerPlayerId: owner.playerId, name: "Old", mode: "normal" });
    db.exec("drop trigger if exists duels_kind_immutable");
    const columns = db.pragma("table_info(duels)") as Array<{ name: string }>;
    if (columns.some(column => column.name === "kind")) db.exec("alter table duels drop column kind");
    migrate(db);
    migrate(db);
    expect(db.prepare("select kind from duels where id = ?").get(old.id)).toEqual({ kind: "play" });
    expect(db.prepare("select seat, player_id from duel_seats where duel_id = ?").all(old.id))
      .toEqual([{ seat: 0, player_id: owner.playerId }]);
    expect(db.pragma("foreign_key_check")).toEqual([]);
  });

  it("accepts only known kinds at insert and never changes a stored kind", () => {
    const { db, owner } = database();
    const insert = db.prepare(`insert into duels(guild_id,web_slug,name,organizer_player_id,mode,status,kind)
      values('g',?,'Fixture',?,'normal','active',?)`);
    expect(() => insert.run("bad", owner.playerId, "unknown")).toThrow(/CHECK/);
    expect(() => insert.run("null", owner.playerId, null)).toThrow(/NOT NULL/);
    insert.run("play", owner.playerId, "play");
    insert.run("fork", owner.playerId, "replay-fork");
    expect(() => db.exec("update duels set kind = 'play' where web_slug = 'fork'")).toThrow(/immutable/);
    expect(() => db.exec("update duels set kind = 'replay-fork' where web_slug = 'play'")).toThrow(/immutable/);
    db.exec("update duels set kind = kind");
  });

  it("stores one request per owner and does not link the source slug by foreign key", () => {
    const { db, owner } = database();
    const duels = createDuelService(db);
    const fork = duels.create({ guildId: "g", organizerPlayerId: owner.playerId, name: "Fixture", mode: "normal" });
    const insert = db.prepare(`insert into replay_fork_requests(owner_user_id,request_id,source_slug,source_version,cursor_digest,fork_duel_id)
      values(?,?,?,?,?,?)`);
    insert.run(owner.userId, "request-1", "deleted-source", "version-1", "a".repeat(64), fork.id);
    expect(() => insert.run(owner.userId, "request-1", "other", "version-2", "b".repeat(64), fork.id)).toThrow(/UNIQUE/);
    expect(db.pragma("foreign_key_list(replay_fork_requests)")).not.toContainEqual(expect.objectContaining({ from: "source_slug" }));
    expect(db.pragma("foreign_key_check")).toEqual([]);
    db.prepare("delete from duels where id = ?").run(fork.id);
    expect(db.prepare("select * from replay_fork_requests").all()).toEqual([]);
  });
});
