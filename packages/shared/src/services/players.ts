import type Database from "better-sqlite3";

export type Player = {
  id: number;
  guildId: string;
  discordUserId: string;
  displayName: string;
  createdAt: string;
};

function mapPlayer(row: any): Player {
  return {
    id: row.id,
    guildId: row.guild_id,
    discordUserId: row.discord_user_id,
    displayName: row.display_name,
    createdAt: row.created_at,
  };
}

export function createPlayerService(db: Database.Database) {
  const findByGuildAndUser = db.prepare(
    "select * from players where guild_id = ? and discord_user_id = ?"
  );

  const insert = db.prepare(
    "insert into players (guild_id, discord_user_id, display_name) values (?, ?, ?)"
  );

  return {
    findByGuildAndUser(guildId: string, discordUserId: string): Player | undefined {
      const row = findByGuildAndUser.get(guildId, discordUserId) as any | undefined;
      return row ? mapPlayer(row) : undefined;
    },

    findOrCreate(guildId: string, discordUserId: string, displayName: string): Player {
      const existing = this.findByGuildAndUser(guildId, discordUserId);
      if (existing) return existing;

      const result = insert.run(guildId, discordUserId, displayName);
      return {
        id: Number(result.lastInsertRowid),
        guildId,
        discordUserId,
        displayName,
        createdAt: new Date().toISOString(),
      };
    },
  };
}

export type PlayerService = ReturnType<typeof createPlayerService>;