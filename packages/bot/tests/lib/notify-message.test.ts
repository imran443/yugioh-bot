import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import { migrate } from "../../src/db/schema.js";
import { deleteNotifyMessage } from "../../src/lib/notify-message.js";

function dbWithMatch(notify: { channel: string | null; message: string | null }) {
  const db = new Database(":memory:");
  migrate(db);
  const a = Number(db.prepare("insert into players (guild_id, discord_user_id, display_name) values ('g','a','A')").run().lastInsertRowid);
  const b = Number(db.prepare("insert into players (guild_id, discord_user_id, display_name) values ('g','b','B')").run().lastInsertRowid);
  const id = Number(
    db.prepare(
      "insert into matches (guild_id, player_one_id, player_two_id, reporter_id, status, source, notify_channel_id, notify_message_id) values ('g',?,?,?, 'approved','tournament',?,?)",
    ).run(a, b, a, notify.channel, notify.message).lastInsertRowid,
  );
  return { db, id };
}

describe("deleteNotifyMessage", () => {
  it("deletes the stored message and clears the columns", async () => {
    const { db, id } = dbWithMatch({ channel: "c1", message: "m1" });
    const del = vi.fn(async () => {});
    const client = {
      channels: { fetch: vi.fn(async () => ({ isTextBased: () => true, messages: { delete: del } })) },
    };
    await deleteNotifyMessage(client as any, db, id);
    expect(client.channels.fetch).toHaveBeenCalledWith("c1");
    expect(del).toHaveBeenCalledWith("m1");
    const row = db.prepare("select notify_channel_id, notify_message_id from matches where id = ?").get(id) as any;
    expect(row.notify_channel_id).toBeNull();
    expect(row.notify_message_id).toBeNull();
  });

  it("no-ops when there is no stored message", async () => {
    const { db, id } = dbWithMatch({ channel: null, message: null });
    const client = { channels: { fetch: vi.fn() } };
    await deleteNotifyMessage(client as any, db, id);
    expect(client.channels.fetch).not.toHaveBeenCalled();
  });

  it("clears columns even if the Discord delete throws (message already gone)", async () => {
    const { db, id } = dbWithMatch({ channel: "c1", message: "m1" });
    const client = {
      channels: { fetch: vi.fn(async () => ({ isTextBased: () => true, messages: { delete: vi.fn(async () => { throw new Error("Unknown Message"); }) } })) },
    };
    await deleteNotifyMessage(client as any, db, id);
    const row = db.prepare("select notify_message_id from matches where id = ?").get(id) as any;
    expect(row.notify_message_id).toBeNull();
  });
});
