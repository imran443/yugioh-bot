import type Database from "better-sqlite3";

export type DraftStatus = "pending" | "active" | "cancelled" | "completed";

export type DraftConfig = {
  setNames?: string[];
  includeNames?: string[];
  excludeNames?: string[];
};

export type Draft = {
  id: number;
  guildId: string;
  channelId: string;
  name: string;
  status: DraftStatus;
  createdByUserId: string;
  config: DraftConfig;
  currentWaveNumber: number;
  currentPickStep: number;
};

export type DraftPlayer = {
  playerId: number;
  displayName: string;
};

function mapDraft(row: any): Draft {
  return {
    id: row.id,
    guildId: row.guild_id,
    channelId: row.channel_id,
    name: row.name,
    status: row.status,
    createdByUserId: row.created_by_user_id,
    config: JSON.parse(row.config_json),
    currentWaveNumber: row.current_wave_number,
    currentPickStep: row.current_pick_step,
  };
}

export function createDraftService(db: Database.Database) {
  const findById = (draftId: number): Draft => {
    const row = db.prepare("select * from drafts where id = ?").get(draftId);

    if (!row) {
      throw new Error("Draft not found");
    }

    return mapDraft(row);
  };

  const createDraft = db.transaction(
    (
      guildId: string,
      channelId: string,
      name: string,
      config: DraftConfig,
      createdByUserId: string,
      creatorPlayerId: number,
    ) => {
      const result = db
        .prepare(
          `
          insert into drafts (guild_id, channel_id, name, status, created_by_user_id, config_json)
          values (?, ?, ?, 'pending', ?, ?)
        `,
        )
        .run(guildId, channelId, name, createdByUserId, JSON.stringify(config));

      const draftId = Number(result.lastInsertRowid);

      db.prepare(
        `
        insert into draft_players (draft_id, player_id)
        values (?, ?)
      `,
      ).run(draftId, creatorPlayerId);

      return draftId;
    },
  );

  return {
    create(
      guildId: string,
      channelId: string,
      name: string,
      config: DraftConfig,
      createdByUserId: string,
      creatorPlayerId: number,
    ): Draft {
      const existingCurrent = db
        .prepare(
          `
          select id from drafts
          where guild_id = ?
            and name = ?
            and status in ('pending', 'active')
          limit 1
        `,
        )
        .get(guildId, name);

      if (existingCurrent) {
        throw new Error("An active or pending draft already uses that name");
      }

      return findById(createDraft(guildId, channelId, name, config, createdByUserId, creatorPlayerId));
    },

    findById,

    findByName(guildId: string, name: string): Draft | undefined {
      const row = db
        .prepare(
          `
          select * from drafts
          where guild_id = ? and name = ?
          order by
            case status when 'active' then 0 when 'pending' then 1 else 2 end,
            id desc
          limit 1
        `,
        )
        .get(guildId, name);

      return row ? mapDraft(row) : undefined;
    },

    listByStatus(guildId: string, statuses: DraftStatus[]): Draft[] {
      if (statuses.length === 0) {
        return [];
      }

      return db
        .prepare(
          `
          select * from drafts
          where guild_id = ?
            and status in (${statuses.map(() => "?").join(", ")})
          order by created_at asc, id asc
        `,
        )
        .all(guildId, ...statuses)
        .map(mapDraft);
    },

    join(draftId: number, playerId: number): void {
      const draft = findById(draftId);

      if (draft.status !== "pending") {
        throw new Error("Draft is no longer accepting players");
      }

      db.prepare(
        `
        insert or ignore into draft_players (draft_id, player_id)
        values (?, ?)
      `,
      ).run(draftId, playerId);
    },

    players(draftId: number): DraftPlayer[] {
      return db
        .prepare(
          `
          select p.id as player_id, p.display_name
          from draft_players dp
          inner join players p on p.id = dp.player_id
          where dp.draft_id = ?
          order by dp.joined_at asc, dp.rowid asc
        `,
        )
        .all(draftId)
        .map((row: any) => ({ playerId: row.player_id, displayName: row.display_name }));
    },
  };
}
