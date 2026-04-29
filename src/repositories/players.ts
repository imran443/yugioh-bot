import type Database from "better-sqlite3";

export type Player = {
  id: number;
  guildId: string;
  discordUserId: string;
  displayName: string;
};

function mapPlayer(row: any): Player {
  return {
    id: row.id,
    guildId: row.guild_id,
    discordUserId: row.discord_user_id,
    displayName: row.display_name,
  };
}

export function createPlayerRepository(db: Database.Database) {
  return {
    upsert(guildId: string, discordUserId: string, displayName: string): Player {
      db.prepare(
        `
        insert into players (guild_id, discord_user_id, display_name)
        values (?, ?, ?)
        on conflict (guild_id, discord_user_id)
        do update set display_name = excluded.display_name
      `,
      ).run(guildId, discordUserId, displayName);

      return mapPlayer(
        db
          .prepare(
            `
          select * from players where guild_id = ? and discord_user_id = ?
        `,
          )
          .get(guildId, discordUserId),
      );
    },

    findByDiscordId(guildId: string, discordUserId: string): Player | undefined {
      const row = db
        .prepare(
          `
        select * from players where guild_id = ? and discord_user_id = ?
      `,
        )
        .get(guildId, discordUserId);

      return row ? mapPlayer(row) : undefined;
    },
  };
}

export type PlayerRepository = ReturnType<typeof createPlayerRepository>;
