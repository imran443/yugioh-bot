import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import { migrate } from "../../src/db/schema.js";
import { createGuildSettingsService } from "@yugidraft/shared/services";
import { createAnnounceHandlers } from "../../src/announce/handlers.js";

function baseDeps() {
  const db = new Database(":memory:");
  migrate(db);
  const a = Number(db.prepare("insert into players (guild_id, discord_user_id, display_name) values ('g','a','A')").run().lastInsertRowid);
  const b = Number(db.prepare("insert into players (guild_id, discord_user_id, display_name) values ('g','b','B')").run().lastInsertRowid);
  const matchId = Number(
    db.prepare("insert into matches (guild_id, player_one_id, player_two_id, reporter_id, status, source) values ('g',?,?,?, 'pending','tournament')")
      .run(a, b, a).lastInsertRowid,
  );
  const guildSettings = createGuildSettingsService(db);
  return { db, matchId, guildSettings };
}

describe("announce match handlers", () => {
  it("onMatchReportPending posts to the announce channel and stores notify ids", async () => {
    const { db, matchId, guildSettings } = baseDeps();
    db.prepare("insert into guild_settings (guild_id, announce_channel_id) values ('g','chan-1')").run();
    const sent = { id: "msg-1" };
    const send = vi.fn(async () => sent);
    const client = { channels: { fetch: vi.fn(async () => ({ isTextBased: () => true, send })) } };
    const handlers = createAnnounceHandlers({
      client: client as any, db, guildSettings,
      drafts: {} as any, messenger: {} as any,
    });
    await handlers.onMatchReportPending({
      guildId: "g", slug: "s", matchId, tournamentMatchId: 7,
      tournamentName: "RR", roundNumber: 1,
      reporterDiscordId: "a", opponentDiscordId: "b",
      reporterName: "A", opponentName: "B", opponentLost: true,
    });
    expect(client.channels.fetch).toHaveBeenCalledWith("chan-1");
    expect(send).toHaveBeenCalled();
    const row = db.prepare("select notify_channel_id, notify_message_id from matches where id = ?").get(matchId) as any;
    expect(row.notify_channel_id).toBe("chan-1");
    expect(row.notify_message_id).toBe("msg-1");
  });

  it("onMatchReportPending no-ops when no announce channel is set", async () => {
    const { db, matchId, guildSettings } = baseDeps();
    const client = { channels: { fetch: vi.fn() } };
    const handlers = createAnnounceHandlers({
      client: client as any, db, guildSettings, drafts: {} as any, messenger: {} as any,
    });
    await handlers.onMatchReportPending({
      guildId: "g", slug: "s", matchId, tournamentMatchId: 7, tournamentName: "RR",
      roundNumber: 1, reporterDiscordId: "a", opponentDiscordId: "b",
      reporterName: "A", opponentName: "B", opponentLost: true,
    });
    expect(client.channels.fetch).not.toHaveBeenCalled();
  });

  it("onMatchResolved deletes the stored message", async () => {
    const { db, matchId, guildSettings } = baseDeps();
    db.prepare("update matches set notify_channel_id='chan-1', notify_message_id='msg-1' where id = ?").run(matchId);
    const del = vi.fn(async () => {});
    const client = { channels: { fetch: vi.fn(async () => ({ isTextBased: () => true, messages: { delete: del } })) } };
    const handlers = createAnnounceHandlers({
      client: client as any, db, guildSettings, drafts: {} as any, messenger: {} as any,
    });
    await handlers.onMatchResolved({ matchId });
    expect(del).toHaveBeenCalledWith("msg-1");
    const row = db.prepare("select notify_message_id from matches where id = ?").get(matchId) as any;
    expect(row.notify_message_id).toBeNull();
  });
});
