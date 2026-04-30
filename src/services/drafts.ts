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

export type DraftCard = {
  id: number;
  draftId: number;
  waveNumber: number;
  catalogCardId: number;
  pickedByPlayerId: number | null;
};

type CatalogRow = {
  ygoprodeck_id: number;
  name: string;
  card_sets_json: string;
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

function mapDraftCard(row: any): DraftCard {
  return {
    id: row.id,
    draftId: row.draft_id,
    waveNumber: row.wave_number,
    catalogCardId: row.catalog_card_id,
    pickedByPlayerId: row.picked_by_player_id,
  };
}

function normalizeName(value: string) {
  return value.trim().toLowerCase();
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

  const assertPlayerGuild = (playerId: number, guildId: string) => {
    const row = db.prepare("select 1 from players where id = ? and guild_id = ?").get(playerId, guildId);

    if (!row) {
      throw new Error("Player must belong to the same guild as the draft");
    }
  };

  const catalogCardIdsForDraft = (config: DraftConfig): number[] => {
    const setNames = new Set((config.setNames ?? []).map((name) => name.trim()));
    const includeNames = new Set((config.includeNames ?? []).map(normalizeName));
    const excludeNames = new Set((config.excludeNames ?? []).map(normalizeName));
    const hasExplicitPool = setNames.size > 0 || includeNames.size > 0;

    return db
      .prepare("select ygoprodeck_id, name, card_sets_json from card_catalog")
      .all()
      .map((row: any) => row as CatalogRow)
      .filter((row) => {
        const normalizedName = normalizeName(row.name);

        if (excludeNames.has(normalizedName)) {
          return false;
        }

        if (!hasExplicitPool) {
          return true;
        }

        if (includeNames.has(normalizedName)) {
          return true;
        }

        const cardSets = JSON.parse(row.card_sets_json) as Array<{ set_name: string }>;
        return cardSets.some((cardSet) => setNames.has(cardSet.set_name));
      })
      .map((row) => row.ygoprodeck_id);
  };

  const startDraft = db.transaction((draftId: number) => {
    const draft = findById(draftId);

    if (draft.status !== "pending") {
      throw new Error("Draft must be pending to start");
    }

    const playerIds = db
      .prepare(
        `
          select player_id from draft_players
          where draft_id = ?
          order by joined_at asc, rowid asc
        `,
      )
      .all(draftId)
      .map((row: any) => row.player_id);

    if (playerIds.length < 2) {
      throw new Error("Draft requires at least two players to start");
    }

    const catalogCardIds = catalogCardIdsForDraft(draft.config);

    if (catalogCardIds.length === 0) {
      throw new Error("Draft pool is empty");
    }

    const insertDraftCard = db.prepare(
      `
        insert into draft_cards (draft_id, wave_number, catalog_card_id)
        values (?, ?, ?)
      `,
    );

    for (const _playerId of playerIds) {
      for (let index = 0; index < 8; index += 1) {
        const catalogCardId = catalogCardIds[Math.floor(Math.random() * catalogCardIds.length)];
        insertDraftCard.run(draftId, 1, catalogCardId);
      }
    }

    db.prepare(
      `
        update drafts
        set status = 'active',
            started_at = current_timestamp,
            current_wave_number = 1,
            current_pick_step = 1
        where id = ?
      `,
    ).run(draftId);

    return findById(draftId);
  });

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

      assertPlayerGuild(creatorPlayerId, guildId);

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

      assertPlayerGuild(playerId, draft.guildId);

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

    start(draftId: number): Draft {
      return startDraft(draftId);
    },

    currentWaveCards(draftId: number): DraftCard[] {
      const draft = findById(draftId);

      if (draft.currentWaveNumber === 0) {
        return [];
      }

      return db
        .prepare(
          `
            select * from draft_cards
            where draft_id = ? and wave_number = ?
            order by id asc
          `,
        )
        .all(draftId, draft.currentWaveNumber)
        .map(mapDraftCard);
    },
  };
}
