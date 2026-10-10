import Database from "better-sqlite3";
import { migrate } from "@yugidraft/shared/db";
import { createDuelService } from "@yugidraft/shared/services";
import { seedIdentity } from "./identity.js";

/** Synthetic actors and a marked fork. No engine or external service is needed. */
export function forkEventFixture(path = ":memory:") {
  const db = new Database(path);
  migrate(db);
  const guildId = "fork-events-test";
  const owner = { guildId, ...seedIdentity(db, { guildId, userId: 101, playerId: 61 }) };
  const dev = { guildId, ...seedIdentity(db, { guildId, userId: 102, playerId: 62 }) };
  const alpha = { guildId, ...seedIdentity(db, { guildId, userId: 103, playerId: 63 }) };
  const sourcePlayer = { guildId, ...seedIdentity(db, { guildId, userId: 104, playerId: 64 }) };
  const duels = createDuelService(db);
  const source = duels.create({ guildId, organizerPlayerId: sourcePlayer.playerId, name: "Source", mode: "normal" });
  const forkSlug = "fork-fixture";
  const setup = { replayFork: { ownerUserId: owner.userId, control: "all-manual", origin: {
    sourceSlug: source.slug, sourceVersion: "source-v1", frameId: "opening", step: 0, prefixCount: 0,
    prefixHash: "a".repeat(64), sourceSeats: [{ seat: 0, displayName: "Source A" }, { seat: 1, displayName: "Source B" }],
  } } };
  const forkId = Number(db.prepare(`insert into duels(guild_id,web_slug,name,organizer_player_id,mode,status,kind,setup_json,settings_json)
    values(?,?,'Fork',?,'normal','active','replay-fork',?,?)`)
    .run(guildId, forkSlug, owner.playerId, JSON.stringify(setup), JSON.stringify({ ...source.settings, visibility: "private" })).lastInsertRowid);
  db.prepare("insert into duel_seats(duel_id,seat,player_id,is_bot,ready) values(?,0,?,0,1)").run(forkId, owner.playerId);
  db.prepare("insert into duel_seats(duel_id,seat,player_id,is_bot,ready) values(?,1,null,1,1)").run(forkId);
  return { db, duels, guildId, owner, dev, alpha, sourcePlayer, source, forkId, forkSlug, setup };
}
