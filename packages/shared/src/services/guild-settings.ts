import type Database from "better-sqlite3";

export type GuildSettings = {
  guildId: string;
  announceDraftCreated: boolean;
  announceDraftStarted: boolean;
  announceDraftCompleted: boolean;
  announceTournamentCreated: boolean;
  announceTournamentCompleted: boolean;
  announceChannelId: string | null;
};

function mapSettings(row: any): GuildSettings {
  return {
    guildId: row.guild_id,
    announceDraftCreated: Boolean(row.announce_draft_created),
    announceDraftStarted: Boolean(row.announce_draft_started),
    announceDraftCompleted: Boolean(row.announce_draft_completed),
    announceTournamentCreated: Boolean(row.announce_tournament_created),
    announceTournamentCompleted: Boolean(row.announce_tournament_completed),
    announceChannelId: row.announce_channel_id ?? null,
  };
}

export function createGuildSettingsService(db: Database.Database) {
  const getSettings = db.prepare(
    "select * from guild_settings where guild_id = ?"
  );

  const upsertSettings = db.prepare(`
    insert into guild_settings (
      guild_id, announce_draft_created, announce_draft_started,
      announce_draft_completed, announce_tournament_created,
      announce_tournament_completed, announce_channel_id
    ) values (?, ?, ?, ?, ?, ?, ?)
    on conflict(guild_id) do update set
      announce_draft_created = excluded.announce_draft_created,
      announce_draft_started = excluded.announce_draft_started,
      announce_draft_completed = excluded.announce_draft_completed,
      announce_tournament_created = excluded.announce_tournament_created,
      announce_tournament_completed = excluded.announce_tournament_completed,
      announce_channel_id = excluded.announce_channel_id
  `);

  return {
    get(guildId: string): GuildSettings {
      const row = getSettings.get(guildId) as any | undefined;
      if (!row) {
        return {
          guildId,
          announceDraftCreated: true,
          announceDraftStarted: true,
          announceDraftCompleted: true,
          announceTournamentCreated: true,
          announceTournamentCompleted: true,
          announceChannelId: null,
        };
      }
      return mapSettings(row);
    },

    update(guildId: string, settings: Partial<Omit<GuildSettings, "guildId">>): GuildSettings {
      const current = this.get(guildId);
      const merged = { ...current, ...settings };
      upsertSettings.run(
        guildId,
        merged.announceDraftCreated ? 1 : 0,
        merged.announceDraftStarted ? 1 : 0,
        merged.announceDraftCompleted ? 1 : 0,
        merged.announceTournamentCreated ? 1 : 0,
        merged.announceTournamentCompleted ? 1 : 0,
        merged.announceChannelId,
      );
      return this.get(guildId);
    },
  };
}

export type GuildSettingsService = ReturnType<typeof createGuildSettingsService>;