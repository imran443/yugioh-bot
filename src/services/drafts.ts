import type Database from "better-sqlite3";

export type DraftStatus = "pending" | "active" | "cancelled" | "completed";

export type DraftConfig = {
  setNames?: string[];
  includeNames?: string[];
  excludeNames?: string[];
  packSize?: number;
  packsPerPlayer?: number;
  pickSeconds?: number;
  alternatePassDirection?: boolean;
  randomizeSeats?: boolean;
};

export type Draft = {
  id: number;
  guildId: string;
  channelId: string;
  name: string;
  status: DraftStatus;
  createdByUserId: string;
  config: DraftConfig;
  currentPackRound: number;
  currentPickStep: number;
  pickDeadlineAt: string | null;
  statusMessageId: string | null;
};

export type DraftPlayer = {
  playerId: number;
  displayName: string;
  seatIndex?: number;
};

export type DraftCard = {
  id: number;
  draftId: number;
  waveNumber: number;
  catalogCardId: number;
  pickedByPlayerId: number | null;
};

export type DraftPick = {
  id: number;
  draftId: number;
  playerId: number;
  draftCardId: number;
  waveNumber: number;
  pickStep: number;
  pickedAt: string;
};

type DraftCardRow = {
  wave_number: number;
  picked_by_player_id: number | null;
};

type CatalogRow = {
  ygoprodeck_id: number;
  name: string;
  type: string;
  frame_type: string;
  card_sets_json: string;
};

type DraftPlayerProgressRow = {
  player_id: number;
  pick_count: number;
  finished_at: string | null;
};

function mapDraft(row: any): Draft {
  return {
    id: row.id,
    guildId: row.guild_id,
    channelId: row.channel_id,
    name: row.name,
    status: row.status,
    createdByUserId: row.created_by_user_id,
    config: normalizeDraftConfig(JSON.parse(row.config_json)),
    currentPackRound: row.current_wave_number,
    currentPickStep: row.current_pick_step,
    pickDeadlineAt: row.pick_deadline_at,
    statusMessageId: row.status_message_id,
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

function mapDraftPick(row: any): DraftPick {
  return {
    id: row.id,
    draftId: row.draft_id,
    playerId: row.player_id,
    draftCardId: row.draft_card_id,
    waveNumber: row.wave_number,
    pickStep: row.pick_step,
    pickedAt: row.picked_at,
  };
}

function normalizeName(value: string) {
  return value.trim().toLowerCase();
}

const defaultDraftConfig = {
  packSize: 8,
  packsPerPlayer: 5,
  pickSeconds: 45,
  alternatePassDirection: true,
  randomizeSeats: false,
} satisfies Required<Pick<DraftConfig, "packSize" | "packsPerPlayer" | "pickSeconds" | "alternatePassDirection" | "randomizeSeats">>;

function normalizeDraftConfig(config: DraftConfig): DraftConfig {
  return {
    ...config,
    packSize: config.packSize ?? defaultDraftConfig.packSize,
    packsPerPlayer: config.packsPerPlayer ?? defaultDraftConfig.packsPerPlayer,
    pickSeconds: config.pickSeconds ?? defaultDraftConfig.pickSeconds,
    alternatePassDirection: config.alternatePassDirection ?? defaultDraftConfig.alternatePassDirection,
    randomizeSeats: config.randomizeSeats ?? defaultDraftConfig.randomizeSeats,
  };
}

const extraDeckFrameTypes = new Set(["fusion", "synchro", "xyz", "link"]);
const pickOptionLimit = 8;

function deadlineIso(now: Date, seconds: number) {
  return new Date(now.getTime() + seconds * 1000).toISOString();
}

function isExtraDeckCatalogRow(row: CatalogRow) {
  return (
    extraDeckFrameTypes.has(row.frame_type) ||
    row.type.includes("Fusion Monster") ||
    row.type.includes("Synchro Monster") ||
    row.type.includes("XYZ Monster") ||
    row.type.includes("Xyz Monster") ||
    row.type.includes("Link Monster")
  );
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
        .run(guildId, channelId, name, createdByUserId, JSON.stringify(normalizeDraftConfig(config)));

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

  const assertJoinedPlayer = (draftId: number, playerId: number) => {
    const row = db.prepare("select 1 from draft_players where draft_id = ? and player_id = ?").get(draftId, playerId);

    if (!row) {
      throw new Error("Player has not joined this draft");
    }
  };

  const playerProgress = (draftId: number, playerId: number): { pick_count: number; finished_at: string | null } =>
    db
      .prepare(
        `
          select pick_count, finished_at from draft_players
          where draft_id = ? and player_id = ?
        `,
      )
      .get(draftId, playerId) as { pick_count: number; finished_at: string | null };

  const playerSeatIndex = (draftId: number, playerId: number): number => {
    const row = db
      .prepare(
        `
          select seat_index from draft_players
          where draft_id = ? and player_id = ?
        `,
      )
      .get(draftId, playerId) as { seat_index: number | null } | undefined;

    if (!row || row.seat_index === null) {
      throw new Error("Draft seat has not been assigned yet");
    }

    return row.seat_index;
  };

  const assertActiveDraft = (draft: Draft) => {
    if (draft.status !== "active") {
      throw new Error("Draft must be active");
    }
  };

  const exportYdk = (draftId: number, playerId: number): string => {
    findById(draftId);
    assertJoinedPlayer(draftId, playerId);

    const progress = playerProgress(draftId, playerId);

    if (progress.pick_count < 40) {
      throw new Error("Deck is not complete yet");
    }

    const mainDeckCardIds = db
      .prepare(
        `
          select dc.catalog_card_id
          from draft_picks dp
          inner join draft_cards dc on dc.id = dp.draft_card_id
          where dp.draft_id = ? and dp.player_id = ?
          order by dp.id asc
          limit 40
        `,
      )
      .all(draftId, playerId)
      .map((row: any) => String(row.catalog_card_id));

    if (mainDeckCardIds.length < 40) {
      throw new Error("Deck is not complete yet");
    }

    return ["#created by Yugioh Discord Bot", "#main", ...mainDeckCardIds, "#extra", "!side"].join("\n");
  };

  const catalogCardIdsForDraft = (config: DraftConfig): number[] => {
    const setNames = new Set((config.setNames ?? []).map((name) => name.trim()));
    const includeNames = new Set((config.includeNames ?? []).map(normalizeName));
    const excludeNames = new Set((config.excludeNames ?? []).map(normalizeName));
    const hasExplicitPool = setNames.size > 0 || includeNames.size > 0;

    return db
      .prepare("select ygoprodeck_id, name, type, frame_type, card_sets_json from card_catalog")
      .all()
      .map((row: any) => row as CatalogRow)
      .filter((row) => {
        const normalizedName = normalizeName(row.name);

        if (isExtraDeckCatalogRow(row)) {
          return false;
        }

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

  const activePlayerRows = (draftId: number): DraftPlayerProgressRow[] =>
    db
      .prepare(
        `
          select player_id, pick_count, finished_at
          from draft_players
          where draft_id = ? and finished_at is null
          order by joined_at asc, rowid asc
        `,
      )
      .all(draftId)
      .map((row: any) => row as DraftPlayerProgressRow);

  const openWave = (draftId: number, waveNumber: number, playerCount: number, config: DraftConfig) => {
    const catalogCardIds = catalogCardIdsForDraft(config);

    if (catalogCardIds.length === 0) {
      throw new Error("Draft pool is empty");
    }

    const packSize = config.packSize ?? defaultDraftConfig.packSize;
    const passDirection = waveNumber % 2 === 0 && config.alternatePassDirection ? -1 : 1;
    const insertPack = db.prepare(
      `
        insert into draft_packs (
          draft_id,
          pack_round,
          origin_seat_index,
          current_holder_seat_index,
          pass_direction
        ) values (?, ?, ?, ?, ?)
      `,
    );
    const insertDraftCard = db.prepare(
      `
        insert into draft_cards (draft_id, wave_number, draft_pack_id, catalog_card_id, position)
        values (?, ?, ?, ?, ?)
      `,
    );

    for (let playerIndex = 0; playerIndex < playerCount; playerIndex += 1) {
      const packId = Number(insertPack.run(draftId, waveNumber, playerIndex, playerIndex, passDirection).lastInsertRowid);

      for (let cardIndex = 0; cardIndex < packSize; cardIndex += 1) {
        const catalogCardId = catalogCardIds[Math.floor(Math.random() * catalogCardIds.length)];
        insertDraftCard.run(draftId, waveNumber, packId, catalogCardId, cardIndex);
      }
    }
  };

  const startDraft = db.transaction((draftId: number, now = new Date()) => {
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

    const assignSeat = db.prepare(
      `
        update draft_players
        set seat_index = ?
        where draft_id = ? and player_id = ?
      `,
    );

    for (const [seatIndex, playerId] of playerIds.entries()) {
      assignSeat.run(seatIndex, draftId, playerId);
    }

    openWave(draftId, 1, playerIds.length, draft.config);

    db.prepare(
      `
        update drafts
        set status = 'active',
            started_at = ?,
            current_wave_number = 1,
            current_pick_step = 1,
            pick_deadline_at = ?
        where id = ?
      `,
    ).run(now.toISOString(), deadlineIso(now, draft.config.pickSeconds ?? defaultDraftConfig.pickSeconds), draftId);

    return findById(draftId);
  });

  const pickCard = db.transaction((draftId: number, playerId: number, draftCardId: number) => {
    const draft = findById(draftId);
    assertActiveDraft(draft);
    assertJoinedPlayer(draftId, playerId);

    const playerRow = playerProgress(draftId, playerId);

    if (playerRow.finished_at !== null || playerRow.pick_count >= 40) {
      throw new Error("Player has already finished drafting");
    }

    const existingPick = db
      .prepare(
        `
          select 1 from draft_picks
          where draft_id = ? and player_id = ? and wave_number = ? and pick_step = ?
        `,
      )
      .get(draftId, playerId, draft.currentPackRound, draft.currentPickStep);

    if (existingPick) {
      throw new Error("Player has already picked this step");
    }

    const cardRow = db
      .prepare("select wave_number, picked_by_player_id from draft_cards where id = ? and draft_id = ?")
      .get(draftCardId, draftId) as DraftCardRow | undefined;

    if (!cardRow || cardRow.wave_number !== draft.currentPackRound) {
      throw new Error("Card is not in the current wave");
    }

    if (cardRow.picked_by_player_id !== null) {
      throw new Error("Card has already been picked");
    }

    db.prepare(
      `
        update draft_cards
        set picked_by_player_id = ?, picked_at = current_timestamp
        where id = ?
      `,
    ).run(playerId, draftCardId);

    const result = db
      .prepare(
        `
          insert into draft_picks (draft_id, player_id, draft_card_id, wave_number, pick_step, picked_at)
          values (?, ?, ?, ?, ?, current_timestamp)
        `,
      )
      .run(draftId, playerId, draftCardId, draft.currentPackRound, draft.currentPickStep);

    db.prepare(
      `
        update draft_players
        set pick_count = pick_count + 1,
            finished_at = case when pick_count + 1 >= 40 then current_timestamp else finished_at end
        where draft_id = ? and player_id = ?
      `,
    ).run(draftId, playerId);

    const currentStepPickCountRow = db
      .prepare(
        `
          select count(*) as count from draft_picks
          where draft_id = ? and wave_number = ? and pick_step = ?
        `,
      )
      .get(draftId, draft.currentPackRound, draft.currentPickStep) as { count: number };

    const remainingPlayers = activePlayerRows(draftId);

    if (remainingPlayers.length === 0) {
      db.prepare("update drafts set status = 'completed', ended_at = current_timestamp where id = ?").run(draftId);
    } else {
      const pendingCurrentStepPlayerCountRow = db
        .prepare(
          `
            select count(*) as count
            from draft_players dp
            where dp.draft_id = ?
              and dp.finished_at is null
              and not exists (
                select 1 from draft_picks picks
                where picks.draft_id = dp.draft_id
                  and picks.player_id = dp.player_id
                  and picks.wave_number = ?
                  and picks.pick_step = ?
              )
          `,
        )
        .get(draftId, draft.currentPackRound, draft.currentPickStep) as { count: number };

      if (currentStepPickCountRow.count > 0 && pendingCurrentStepPlayerCountRow.count === 0) {
        const unpickedWaveCardCountRow = db
          .prepare(
            `
              select count(*) as count from draft_cards
              where draft_id = ? and wave_number = ? and picked_by_player_id is null
            `,
          )
          .get(draftId, draft.currentPackRound) as { count: number };

        if (unpickedWaveCardCountRow.count === 0) {
          openWave(draftId, draft.currentPackRound + 1, remainingPlayers.length, draft.config);
          db.prepare(
            `
              update drafts
              set current_wave_number = ?, current_pick_step = 1
              where id = ?
            `,
          ).run(draft.currentPackRound + 1, draftId);
        } else {
          db.prepare("update drafts set current_pick_step = current_pick_step + 1 where id = ?").run(draftId);
        }
      }
    }

    const pickRow = db.prepare("select * from draft_picks where id = ?").get(Number(result.lastInsertRowid));
    return mapDraftPick(pickRow);
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

      const existing = db.prepare("select 1 from draft_players where draft_id = ? and player_id = ?").get(draftId, playerId);

      if (existing) {
        throw new Error("You have already joined this draft");
      }

      db.prepare(
        `
        insert into draft_players (draft_id, player_id)
        values (?, ?)
      `,
      ).run(draftId, playerId);
    },

    players(draftId: number): DraftPlayer[] {
      return db
        .prepare(
          `
          select p.id as player_id, p.display_name, dp.seat_index
          from draft_players dp
          inner join players p on p.id = dp.player_id
          where dp.draft_id = ?
          order by dp.joined_at asc, dp.rowid asc
        `,
        )
        .all(draftId)
        .map((row: any) => ({
          playerId: row.player_id,
          displayName: row.display_name,
          ...(row.seat_index === null ? {} : { seatIndex: row.seat_index }),
        }));
    },

    start(draftId: number, now = new Date()): Draft {
      return startDraft(draftId, now);
    },

    currentPackOptions(draftId: number, playerId: number): DraftCard[] {
      const draft = findById(draftId);
      assertActiveDraft(draft);
      assertJoinedPlayer(draftId, playerId);

      const playerRow = playerProgress(draftId, playerId);

      if (playerRow.finished_at !== null || playerRow.pick_count >= 40) {
        return [];
      }

      const seatIndex = playerSeatIndex(draftId, playerId);
      const pack = db
        .prepare(
          `
            select id from draft_packs
            where draft_id = ? and pack_round = ? and current_holder_seat_index = ?
            limit 1
          `,
        )
        .get(draftId, draft.currentPackRound, seatIndex) as { id: number } | undefined;

      if (!pack) {
        return [];
      }

      return db
        .prepare(
          `
            select * from draft_cards
            where draft_pack_id = ? and picked_by_player_id is null
            order by position asc, id asc
          `,
        )
        .all(pack.id)
        .map(mapDraftCard);
    },

    currentWaveCards(draftId: number): DraftCard[] {
      const draft = findById(draftId);

      if (draft.currentPackRound === 0) {
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
        .all(draftId, draft.currentPackRound)
        .map(mapDraftCard);
    },

    pickOptions(draftId: number, playerId: number): DraftCard[] {
      const draft = findById(draftId);
      assertActiveDraft(draft);
      assertJoinedPlayer(draftId, playerId);

      const playerRow = playerProgress(draftId, playerId);

      if (playerRow.finished_at !== null || playerRow.pick_count >= 40) {
        return [];
      }

      const existingPick = db
        .prepare(
          `
            select 1 from draft_picks
            where draft_id = ? and player_id = ? and wave_number = ? and pick_step = ?
          `,
        )
        .get(draftId, playerId, draft.currentPackRound, draft.currentPickStep);

      if (existingPick) {
        return [];
      }

      return db
        .prepare(
          `
            select * from draft_cards
            where draft_id = ? and wave_number = ? and picked_by_player_id is null
            order by id asc
            limit ?
          `,
        )
        .all(draftId, draft.currentPackRound, pickOptionLimit)
        .map(mapDraftCard);
    },

    pickCard(draftId: number, playerId: number, draftCardId: number): DraftPick {
      return pickCard(draftId, playerId, draftCardId);
    },

    exportYdk(draftId: number, playerId: number): string {
      return exportYdk(draftId, playerId);
    },

    cancel(draftId: number): Draft {
      const draft = findById(draftId);

      if (draft.status === "completed" || draft.status === "cancelled") {
        throw new Error("Draft is already finished");
      }

      db.prepare("update drafts set status = 'cancelled', ended_at = current_timestamp where id = ?").run(draftId);

      return findById(draftId);
    },

    autocomplete(input: {
      guildId: string;
      query: string;
      statuses?: DraftStatus[];
      createdByUserId?: string;
    }): Draft[] {
      const conditions = ["guild_id = ?", "lower(name) like lower(?)"];
      const params: Array<string | number> = [input.guildId, `%${input.query}%`];

      if (input.statuses && input.statuses.length > 0) {
        conditions.push(`status in (${input.statuses.map(() => "?").join(", ")})`);
        params.push(...input.statuses);
      }

      if (input.createdByUserId) {
        conditions.push("created_by_user_id = ?");
        params.push(input.createdByUserId);
      }

      return db
        .prepare(
          `
            select * from drafts
            where ${conditions.join(" and ")}
            order by created_at desc, id desc
            limit 25
          `,
        )
        .all(...params)
        .map(mapDraft);
    },
  };
}

export type DraftService = ReturnType<typeof createDraftService>;
