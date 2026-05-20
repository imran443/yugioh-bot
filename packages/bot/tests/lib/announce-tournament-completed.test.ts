import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import { migrate } from "../../src/db/schema.js";
import { createGuildSettingsService } from "@yugidraft/shared/services";
import { announceTournamentCompleted } from "../../src/lib/announce-tournament-completed.js";

function makeDb() {
  const db = new Database(":memory:");
  migrate(db);
  return db;
}

function insertTournament(db: Database.Database, overrides: { webSlug?: string | null } = {}) {
  const webSlug = "webSlug" in overrides ? overrides.webSlug : "test-slug-abc";
  return Number(
    db
      .prepare(
        "insert into tournaments (guild_id, name, format, status, created_by_user_id, web_slug) values (?, ?, ?, ?, ?, ?)",
      )
      .run("guild-1", "My Tournament", "round_robin", "completed", "user-1", webSlug).lastInsertRowid,
  );
}

function makeTextChannel() {
  const send = vi.fn().mockResolvedValue({ id: "msg-1" });
  return { channel: { isTextBased: () => true, send }, send };
}

describe("announceTournamentCompleted", () => {
  it("sends the tournament completed announcement when web_slug present and channel exists", async () => {
    const db = makeDb();
    const tournamentId = insertTournament(db);
    db.prepare("insert into guild_settings (guild_id, announce_channel_id) values ('guild-1', 'ch1')").run();
    const guildSettings = createGuildSettingsService(db);
    const { channel, send } = makeTextChannel();
    const client = { channels: { fetch: vi.fn().mockResolvedValue(channel) } };

    await announceTournamentCompleted(client as any, db, guildSettings, tournamentId);

    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith(
      "🏆 **My Tournament** has completed! Final standings: http://localhost:3000/tournament/test-slug-abc",
    );
  });

  it("no-ops when the tournament row has web_slug = null", async () => {
    const db = makeDb();
    const tournamentId = insertTournament(db, { webSlug: null });
    db.prepare("insert into guild_settings (guild_id, announce_channel_id) values ('guild-1', 'ch1')").run();
    const guildSettings = createGuildSettingsService(db);
    const fetch = vi.fn();
    const client = { channels: { fetch } };

    await announceTournamentCompleted(client as any, db, guildSettings, tournamentId);

    expect(fetch).not.toHaveBeenCalled();
  });

  it("no-ops when guildSettings.get returns announceChannelId = null", async () => {
    const db = makeDb();
    const tournamentId = insertTournament(db);
    // No guild_settings row → announceChannelId defaults to null
    const guildSettings = createGuildSettingsService(db);
    const fetch = vi.fn();
    const client = { channels: { fetch } };

    await announceTournamentCompleted(client as any, db, guildSettings, tournamentId);

    expect(fetch).not.toHaveBeenCalled();
  });

  it("no-ops when channels.fetch returns null", async () => {
    const db = makeDb();
    const tournamentId = insertTournament(db);
    db.prepare("insert into guild_settings (guild_id, announce_channel_id) values ('guild-1', 'ch1')").run();
    const guildSettings = createGuildSettingsService(db);
    const client = { channels: { fetch: vi.fn().mockResolvedValue(null) } };

    await announceTournamentCompleted(client as any, db, guildSettings, tournamentId);
    // No error thrown — just a no-op
  });

  it("no-ops when channel is not text-based", async () => {
    const db = makeDb();
    const tournamentId = insertTournament(db);
    db.prepare("insert into guild_settings (guild_id, announce_channel_id) values ('guild-1', 'ch1')").run();
    const guildSettings = createGuildSettingsService(db);
    const send = vi.fn();
    const client = {
      channels: {
        fetch: vi.fn().mockResolvedValue({ isTextBased: () => false, send }),
      },
    };

    await announceTournamentCompleted(client as any, db, guildSettings, tournamentId);

    expect(send).not.toHaveBeenCalled();
  });
});
