import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { migrate } from "../../src/db/schema.js";
import { createNotifyCleanupService } from "../../src/services/notify-cleanup.js";

let playerCounter = 0;
function matchRow(db: Database.Database, status: string, ageMinutes: number) {
  const aId = `a${playerCounter++}`;
  const bId = `b${playerCounter++}`;
  const a = Number(db.prepare("insert into players (guild_id, discord_user_id, display_name) values ('g',?,?)").run(aId, `A${aId}`).lastInsertRowid);
  const b = Number(db.prepare("insert into players (guild_id, discord_user_id, display_name) values ('g',?,?)").run(bId, `B${bId}`).lastInsertRowid);
  const id = Number(
    db.prepare(
      "insert into matches (guild_id, player_one_id, player_two_id, reporter_id, status, source, created_at, notify_channel_id, notify_message_id) values ('g',?,?,?,?, 'tournament', datetime('now', ?), 'c','m')",
    ).run(a, b, a, status, `-${ageMinutes} minutes`).lastInsertRowid,
  );
  return id;
}

describe("notify cleanup sweep", () => {
  it("clears notify ids for resolved matches and for stale pending ones", async () => {
    const db = new Database(":memory:");
    migrate(db);
    const resolved = matchRow(db, "approved", 1);
    const stalePending = matchRow(db, "pending", 9999);
    const freshPending = matchRow(db, "pending", 1);
    const calls: number[] = [];
    const svc = createNotifyCleanupService({
      db,
      ttlMinutes: 720,
      deleteNotifyMessage: async (id: number) => { calls.push(id); },
    });

    await svc.tick();

    expect(calls.sort()).toEqual([resolved, stalePending].sort());
    expect(calls).not.toContain(freshPending);
  });
});
