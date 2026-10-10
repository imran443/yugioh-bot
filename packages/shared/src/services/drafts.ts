import { randomBytes, randomInt } from "node:crypto";
import type Database from "better-sqlite3";
import type { Draft, DraftCard, DraftConfig, DraftPick, DraftPlayer, DraftVisibility } from "../types/index.js";
import { generateWebSlug } from "../util/web-slug.js";
import { cubePoolSizes } from "./cubes.js";
import { MAX_COPIES_PER_PLAYER } from "./constants.js";
import { buildDraftDeck, createDraftDeckService } from "./draft-decks.js";
import { isExtraDeckFrame } from "./card-catalog.js";
import { canonicalCardCode } from "../duels/pool.js";
import { loadArtworkIdentityCatalog } from "./card-artworks.js";
import { analyzeCube, buildDealWithRemainder, prepareBoosterPool, seededShuffle, type ShuffleSeed } from "./deal.js";
import { assertLobbySeatTarget, clearDraftLobbyStart, invalidateDraftLobby, DraftLobbyServiceError } from "./draft-lobby-mutations.js";
import { findDraftReadAccess } from "./draft-access.js";
import { CurrentNameTakenError } from "./current-name.js";
import { boosterMainRounds, buildCappedBoosterDeal, mainDraftPicksPerPlayer, effectiveDraftNumbers } from "./draft-size.js";

export type DraftStatus = "pending" | "active" | "cancelled" | "completed";
export class DraftTerminalError extends Error {
  readonly status = 409;
  constructor(message: string, readonly code: "DRAFT_ALREADY_FINISHED" | "DRAFT_HAS_TOURNAMENT") {
    super(message);
    this.name = "DraftTerminalError";
  }
}
export interface DraftStartOptions { scheduleToken?: string }
export type { Draft, DraftCard, DraftConfig, DraftPick, DraftPlayer } from "../types/index.js";

export type DraftPoolCard = {
  draftCardId: number;
  catalogCardId: number;
  pickMethod: "manual" | "auto";
  forced: boolean;
  packRound: number;
  pickStep: number;
};

type DraftCardRow = {
  wave_number: number;
  draft_pack_id: number | null;
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
  seat_index: number | null;
};

function mapDraft(row: any): Draft {
  return {
    id: row.id,
    guildId: row.guild_id,
    channelId: row.channel_id,
    name: row.name,
    status: row.status,
    visibility: row.visibility,
    createdByUserId: row.created_by_user_id,
    config: normalizeDraftConfig(JSON.parse(row.config_json), row.status !== "pending"),
    currentPackRound: row.current_wave_number,
    currentPickStep: row.current_pick_step,
    pickDeadlineAt: row.pick_deadline_at,
    statusMessageId: row.status_message_id,
    webSlug: row.web_slug ?? undefined,
    tournamentId: row.tournament_id ?? undefined,
    completeMessageId: row.complete_message_id ?? undefined,
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
    pickMethod: row.pick_method,
    forced: row.forced === 1,
    pickedAt: row.picked_at,
  };
}

function normalizeName(value: string) {
  return value.trim().toLowerCase();
}

const defaultDraftConfig = {
  packSize: 8,
  packsPerPlayer: 5,
  cardsPerPlayer: 40,
  pickSeconds: 45,
  alternatePassDirection: true,
  randomizeSeats: false,
} satisfies Required<Pick<DraftConfig, "packSize" | "packsPerPlayer" | "cardsPerPlayer" | "pickSeconds" | "alternatePassDirection" | "randomizeSeats">>;

function normalizeDraftConfig(config: DraftConfig, preserveBoosterRounds = false): DraftConfig {
  const base = {
    ...config,
    packSize: config.packSize ?? defaultDraftConfig.packSize,
    ...effectiveDraftNumbers(config, preserveBoosterRounds),
    pickSeconds: config.pickSeconds ?? defaultDraftConfig.pickSeconds,
    alternatePassDirection: config.alternatePassDirection ?? defaultDraftConfig.alternatePassDirection,
    randomizeSeats: config.randomizeSeats ?? defaultDraftConfig.randomizeSeats,
    copyLimit: config.copyLimit !== false,
  };
  if (config.mode !== "theme") {
    return { ...base, extraDeckEnabled: config.extraDeckEnabled ?? false,
      extraDeckSize: config.extraDeckSize ?? 15, picksPerStep: config.picksPerStep ?? 1 };
  }
  return {
    ...base,
    mode: "theme",
    themePackSize: config.themePackSize ?? 3,
    extraDeckEnabled: config.extraDeckEnabled ?? true,
    extraDeckSize: config.extraDeckSize ?? 15,
    burnUnpicked: config.burnUnpicked ?? false,
    themeSelection: config.themeSelection ?? "player_pick",
    uniqueThemes: config.uniqueThemes ?? true,
  };
}

/** Shared by theme start and the web create/edit routes. */
export function themeDraftNumberError(config: DraftConfig): string | null {
  const choices = config.themePackSize ?? 3;
  const main = mainDraftPicksPerPlayer(config);
  const extra = config.extraDeckSize ?? 15;
  if (!Number.isInteger(choices) || choices < 2) return "Choices per pick must be a whole number of 2 or more";
  if (!Number.isInteger(main) || main < 1) return "Cards per player must be a positive whole number";
  if (!Number.isInteger(extra) || extra < 0) return "Extra deck size must be a whole number of 0 or more";
  return null;
}

/** Per-player total rounds for a theme draft: main rounds + optional extra rounds. */
export function totalThemeRounds(config: DraftConfig): number {
  const main = mainDraftPicksPerPlayer(config);
  const extra = (config.extraDeckEnabled ?? true) ? (config.extraDeckSize ?? 15) : 0;
  return main + extra;
}

/** Normal drafts use one extra pack per player, after all main packs. */
export function boosterExtraSize(config: DraftConfig): number {
  return config.extraDeckEnabled === true ? config.extraDeckSize ?? 15 : 0;
}

export function totalBoosterCards(config: DraftConfig): number {
  return mainDraftPicksPerPlayer(config) + boosterExtraSize(config);
}

export function boosterDraftPhase(config: DraftConfig, packRound: number): "main" | "extra" {
  return boosterExtraSize(config) > 0 && packRound > boosterMainRounds(config) ? "extra" : "main";
}

/** Shared by normal start and create/edit routes. Theme validation stays independent. */
export function boosterDraftConfigError(config: DraftConfig): string | null {
  if (!Number.isSafeInteger(config.packSize ?? 8) || (config.packSize ?? 8) < 1) return "Pack size must be a positive whole number";
  if (!Number.isInteger(mainDraftPicksPerPlayer(config)) || mainDraftPicksPerPlayer(config) < 1) return "Cards per player must be a positive whole number";
  if (config.extraDeckEnabled !== undefined && typeof config.extraDeckEnabled !== "boolean") return "Extra deck enabled must be a boolean";
  const extra = config.extraDeckSize === undefined ? 15 : config.extraDeckSize;
  if (!Number.isInteger(extra) || extra < 0 || extra > 15) return "Extra deck size must be a whole number from 0 to 15";
  const picks = config.picksPerStep === undefined ? 1 : config.picksPerStep;
  if (picks !== 1 && picks !== 2) return "Picks per step must be 1 or 2";
  if (config.customExtraCardIds !== undefined && (!Array.isArray(config.customExtraCardIds)
    || config.customExtraCardIds.some((id) => !Number.isSafeInteger(id) || id <= 0))) return "customExtraCardIds must be a list of positive card IDs (one per copy)";
  if (config.customExtraCardIds && new Set(config.customExtraCardIds).size > 1000) return "customExtraCardIds may contain at most 1000 distinct card IDs";
  return null;
}

const pickOptionLimit = 8;

function deadlineIso(now: Date, seconds: number) {
  return new Date(now.getTime() + seconds * 1000).toISOString();
}

function isExtraDeckCatalogRow(row: CatalogRow) {
  return isExtraDeckFrame({ frameType: row.frame_type, type: row.type });
}

export function createDraftService(
  db: Database.Database,
  options: { random?: () => number; seedSource?: () => ShuffleSeed } = {},
) {
  const random = options.random ?? Math.random;
  // Deals, assignments and theme packs are persisted; their seeds stay in memory.
  const seedSource = options.seedSource ?? (() => randomBytes(32).toString("hex"));

  // Every path that ends a draft goes through here, so Discord and web drafts both leave each human
  // player a saved deck of their picks. A failure must not undo the last pick; the decks are
  // saved later, when the player opens My decks or the tournament page.
  const completeDraft = (draftId: number, now: Date, waveNumber?: number) => {
    clearDraftLobbyStart(db, draftId, true);
    if (waveNumber === undefined) {
      db.prepare("update drafts set status = 'completed', pick_deadline_at = null, ended_at = ? where id = ?").run(now.toISOString(), draftId);
    } else {
      db.prepare("update drafts set status = 'completed', pick_deadline_at = null, current_wave_number = ?, ended_at = ? where id = ?").run(
        waveNumber,
        now.toISOString(),
        draftId,
      );
    }
    try {
      createDraftDeckService(db).saveForDraft(draftId);
    } catch (error) {
      console.error(`[drafts] could not save the draft decks for draft ${draftId}:`, error);
    }
  };
  const seatOrder = (playerIds: number[], config: DraftConfig): number[] => {
    if (!config.randomizeSeats) return playerIds;

    const shuffled = playerIds.slice();
    for (let i = shuffled.length - 1; i > 0; i -= 1) {
      const j = Math.floor(random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return shuffled;
  };

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
      channelId: string | null,
      name: string,
      config: DraftConfig,
      createdByUserId: number,
      creatorPlayerId: number,
      visibility: DraftVisibility,
    ) => {
      assertLobbySeatTarget(config);
      const result = db
        .prepare(
          `
          insert into drafts (guild_id, channel_id, name, status, created_by_user_id, config_json, web_slug, visibility)
          values (?, ?, ?, 'pending', ?, ?, ?, ?)
        `,
        )
        .run(guildId, channelId, name, createdByUserId, JSON.stringify(normalizeDraftConfig(config)), generateWebSlug(), visibility);

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

  const hasPickedCurrentStep = (draftId: number, playerId: number, packRound: number, pickStep: number) =>
    Boolean(
      db
        .prepare(
          `
            select 1 from draft_picks
            where draft_id = ? and player_id = ? and wave_number = ? and pick_step = ?
          `,
        )
        .get(draftId, playerId, packRound, pickStep),
    );

  const hasPassedStep = (draftId: number, playerId: number, packRound: number, pickStep: number) =>
    Boolean(
      db
        .prepare(
          `
            select 1 from draft_passes
            where draft_id = ? and player_id = ? and wave_number = ? and pick_step = ?
          `,
        )
        .get(draftId, playerId, packRound, pickStep),
    );

  // A step is done for a player once they picked a card or passed.
  const hasActedCurrentStep = (draftId: number, playerId: number, packRound: number, pickStep: number) =>
    hasPickedCurrentStep(draftId, playerId, packRound, pickStep) ||
    hasPassedStep(draftId, playerId, packRound, pickStep);

  const boosterPhaseTarget = (draft: Draft, playerId: number): number => {
    if (boosterDraftPhase(draft.config, draft.currentPackRound) !== "extra") return mainDraftPicksPerPlayer(draft.config);
    // A finite Main pool may run out early; each player still gets their own full Extra target.
    const main = db.prepare("select count(*) as n from draft_picks where draft_id = ? and player_id = ? and wave_number <= ?")
      .get(draft.id, playerId, boosterMainRounds(draft.config)) as { n: number };
    return main.n + boosterExtraSize(draft.config);
  };

  // Extra-enabled swaps may only draw from the current phase. Legacy mixed pools keep their swaps.
  const boosterRemainder = (draft: Draft) => {
    const extra = boosterDraftPhase(draft.config, draft.currentPackRound) === "extra";
    const rows = db.prepare(`select u.position, u.catalog_card_id, c.type, c.frame_type from draft_undealt u
      left join card_catalog c on c.ygoprodeck_id = u.catalog_card_id where u.draft_id = ? order by u.position`)
      .all(draft.id) as Array<{ position: number; catalog_card_id: number; type: string | null; frame_type: string | null }>;
    return boosterExtraSize(draft.config) === 0 ? rows : rows
      .filter((row) => isExtraDeckFrame({ type: row.type ?? "", frameType: row.frame_type ?? "" }) === extra);
  };

  // Combined copies by name and type, exposed under every artwork id (main and extra together).
  const heldCopies = (draftId: number, playerId: number): Map<number, number> => {
    const rows = db
      .prepare(
        `
          select coalesce(art.ygoprodeck_id, dc.catalog_card_id) as catalog_card_id, count(*) as n
          from draft_picks pk
          inner join draft_cards dc on dc.id = pk.draft_card_id
          left join card_catalog picked on picked.ygoprodeck_id = dc.catalog_card_id
          left join card_catalog art on lower(trim(art.name)) = lower(trim(picked.name)) and art.type = picked.type
          where pk.draft_id = ? and pk.player_id = ?
          group by coalesce(art.ygoprodeck_id, dc.catalog_card_id)
        `,
      )
      .all(draftId, playerId) as Array<{ catalog_card_id: number; n: number }>;
    return new Map(rows.map((row) => [row.catalog_card_id, row.n]));
  };

  const isCapped = (held: Map<number, number>, catalogCardId: number) =>
    (held.get(catalogCardId) ?? 0) >= MAX_COPIES_PER_PLAYER;

  const assertUnderCopyCap = (draftId: number, playerId: number, draftCardId: number) => {
    const card = db
      .prepare("select catalog_card_id from draft_cards where id = ? and draft_id = ?")
      .get(draftCardId, draftId) as { catalog_card_id: number } | undefined;
    const draft = findById(draftId);
    if (draft.config.copyLimit === false) return false;
    if (card && isCapped(heldCopies(draftId, playerId), card.catalog_card_id)) {
      if (draft.config.mode !== "theme" && currentPackOptionsInternal(draftId, playerId, true).some((option) => option.id === draftCardId && option.forced)) return true;
      throw new Error(`You already have ${MAX_COPIES_PER_PLAYER} copies of this card`);
    }
    return false;
  };

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

  const allSeatIndexes = (draftId: number): number[] =>
    (
      db
        .prepare("select seat_index from draft_players where draft_id = ? and seat_index is not null order by seat_index")
        .all(draftId) as Array<{ seat_index: number }>
    ).map((row) => row.seat_index);

  // Every pack moves one seat, including finished seats. This is a permutation:
  // skipping seats would let two live packs converge on the same player.
  const advanceSeatIndex = (seatIndexes: number[], currentSeatIndex: number, direction: number): number => {
    const currentIndex = seatIndexes.indexOf(currentSeatIndex);
    if (currentIndex === -1 || seatIndexes.length === 0) return currentSeatIndex;
    const offset = direction >= 0 ? 1 : -1;
    return seatIndexes[(currentIndex + offset + seatIndexes.length) % seatIndexes.length];
  };

  const currentPackAtSeat = (draftId: number, waveNumber: number, seatIndex: number) =>
    db.prepare(
      `select p.id, p.pass_direction from draft_packs p
       where p.draft_id = ? and p.wave_number = ? and p.current_holder_seat_index = ?
         and exists (select 1 from draft_cards c where c.draft_pack_id = p.id and c.picked_by_player_id is null)
       order by p.id asc limit 1`,
    ).get(draftId, waveNumber, seatIndex) as { id: number; pass_direction: number } | undefined;

  // Also called from settlement and expiry. Nested transactions use a savepoint, so
  // a failed pick rolls back its swap. Reading options persists the same pack a bot or UI sees.
  const prepareBoosterPack = db.transaction((draftId: number, playerId: number) => {
    const draft = findById(draftId);
    if (draft.config.mode === "theme" || draft.config.copyLimit === false) return;
    const pack = currentPackAtSeat(draftId, draft.currentPackRound, playerSeatIndex(draftId, playerId));
    if (!pack) return;
    const cards = db.prepare("select id, catalog_card_id from draft_cards where draft_pack_id = ? and picked_by_player_id is null order by position, id")
      .all(pack.id) as Array<{ id: number; catalog_card_id: number }>;
    const held = heldCopies(draftId, playerId);
    if (cards.length === 0 || cards.some((card) => !isCapped(held, card.catalog_card_id))) return;
    const remainder = boosterRemainder(draft);
    const replacement = remainder.find((card) => !isCapped(held, card.catalog_card_id));
    if (!replacement) return; // Old drafts and exhausted piles use the forced-pick rule.
    const outgoing = cards[randomInt(cards.length)];
    const tail = (db.prepare("select max(position) as n from draft_undealt where draft_id = ?").get(draftId) as { n: number }).n + 1;
    db.prepare("delete from draft_undealt where draft_id = ? and position = ?").run(draftId, replacement.position);
    db.prepare("insert into draft_undealt (draft_id, position, catalog_card_id) values (?, ?, ?)").run(draftId, tail, outgoing.catalog_card_id);
    db.prepare("update draft_cards set catalog_card_id = ? where id = ?").run(replacement.catalog_card_id, outgoing.id);
  }).immediate;

  const pool = (draftId: number, playerId: number): DraftPoolCard[] => {
    findById(draftId);
    assertJoinedPlayer(draftId, playerId);

    return db
      .prepare(
        `
          select
            dp.draft_card_id,
            dc.catalog_card_id,
            dp.pick_method,
            dp.forced,
            dp.wave_number,
            dp.pick_step
          from draft_picks dp
          inner join draft_cards dc on dc.id = dp.draft_card_id
          where dp.draft_id = ? and dp.player_id = ?
          order by dp.id asc
        `,
      )
      .all(draftId, playerId)
      .map((row: any) => ({
        draftCardId: row.draft_card_id,
        catalogCardId: row.catalog_card_id,
        pickMethod: row.pick_method,
        forced: row.forced === 1,
        packRound: row.wave_number,
        pickStep: row.pick_step,
      }));
  };

  const exportYdk = (draftId: number, playerId: number): string => {
    const draft = findById(draftId);
    assertJoinedPlayer(draftId, playerId);
    const target = draft.config.mode === "theme" ? totalThemeRounds(draft.config) : totalBoosterCards(draft.config);
    if (draft.status !== "completed" && playerProgress(draftId, playerId).pick_count < target) {
      throw new Error("Deck is not complete yet");
    }
    const rows = db.prepare(`select dc.catalog_card_id, cc.name, cc.type, cc.frame_type, pk.forced
      from draft_picks pk join draft_cards dc on dc.id = pk.draft_card_id
      left join card_catalog cc on cc.ygoprodeck_id = dc.catalog_card_id
      where pk.draft_id = ? and pk.player_id = ? order by pk.id`)
      .all(draftId, playerId) as Array<{ catalog_card_id: number; name: string | null; type: string | null; frame_type: string | null; forced: number }>;
    const deck = buildDraftDeck(rows.map((row) => ({ catalogId: row.catalog_card_id, name: row.name, type: row.type,
      forced: row.forced === 1,
      extra: isExtraDeckFrame({ type: row.type ?? "", frameType: row.frame_type ?? "" }) })));
    return ["#main", ...deck.main, "#extra", ...deck.extra, "", "!side", ...deck.side, ""].join("\n");
  };

  const catalogCardIdsForDraft = (config: DraftConfig): number[] => {
    const artworkIdentity = loadArtworkIdentityCatalog();
    const isMain = (row: CatalogRow & { art_is_main: number }) => row.art_is_main === 1
      && canonicalCardCode(row.ygoprodeck_id, artworkIdentity) === row.ygoprodeck_id;
    const setNames = new Set((config.setNames ?? []).map((name) => name.trim()));
    const customCardIds = config.customCardIds ?? [];
    const customCardIdSet = new Set(customCardIds);
    const includeNames = new Set((config.includeNames ?? []).map(normalizeName));
    const excludeNames = new Set((config.excludeNames ?? []).map(normalizeName));
    const hasExplicitPool = setNames.size > 0 || customCardIds.length > 0 || includeNames.size > 0;
    const rows = db
      .prepare(
        `select cc.ygoprodeck_id, cc.name, cc.type, cc.frame_type, cc.card_sets_json, coalesce(a.is_main, 1) as art_is_main
         from card_catalog cc left join card_artworks a on a.artwork_id = cc.ygoprodeck_id order by cc.ygoprodeck_id`,
      )
      .all()
      .map((raw: any) => {
        const row = raw as CatalogRow & { art_is_main: number };
        return { row, cardSets: JSON.parse(row.card_sets_json) as Array<{ set_name: string }> };
      })
      .filter(({ row, cardSets }) => {
        const normalizedName = normalizeName(row.name);

        if (isExtraDeckCatalogRow(row)) {
          return false;
        }

        if (excludeNames.has(normalizedName)) {
          return false;
        }

        if (!isMain(row) && !customCardIdSet.has(row.ygoprodeck_id)) return false;

        if (!hasExplicitPool) {
          return true;
        }

        if (includeNames.has(normalizedName)) {
          return true;
        }

        if (customCardIdSet.has(row.ygoprodeck_id)) {
          return true;
        }

        return cardSets.some((cardSet) => setNames.has(cardSet.set_name));
      });

    if (!hasExplicitPool) {
      return rows.map(({ row }) => row.ygoprodeck_id);
    }

    // baseline (set/include) appears once; custom occurrences are additive and
    // preserve repeats, so total per card = baseline + count in customCardIds.
    const baseIds = new Set<number>();
    const customEligibleIds = new Set<number>();
    for (const { row, cardSets } of rows) {
      customEligibleIds.add(row.ygoprodeck_id);
      const normalizedName = normalizeName(row.name);
      if (isMain(row) && (includeNames.has(normalizedName) || cardSets.some((cardSet) => setNames.has(cardSet.set_name)))) {
        baseIds.add(row.ygoprodeck_id);
      }
    }

    return [...baseIds, ...customCardIds.filter((id) => customEligibleIds.has(id))];
  };

  const activePlayerRows = (draftId: number): DraftPlayerProgressRow[] =>
    db
      .prepare(
        `
          select player_id, pick_count, finished_at, seat_index
          from draft_players
          where draft_id = ? and finished_at is null
          order by joined_at asc, rowid asc
        `,
      )
      .all(draftId)
      .map((row: any) => row as DraftPlayerProgressRow);

  const resolveExtraCardIds = (config: DraftConfig, guildId: string): number[] => {
    const ids = config.customExtraCardIds ?? (config.poolSource ?
      (db.prepare(`select cc.catalog_card_id, cc.max_copies from cube_cards cc join cubes c on c.id = cc.cube_id
        where cc.cube_id = ? and cc.pool = 'extra' and c.guild_id = ? order by cc.rowid`)
        .all(config.poolSource.cubeId, guildId) as Array<{ catalog_card_id: number; max_copies: number }>)
        .flatMap((row) => Array<number>(row.max_copies).fill(row.catalog_card_id)) : []);
    const eligible = new Set((db.prepare("select ygoprodeck_id, type, frame_type from card_catalog").all() as CatalogRow[])
      .filter(isExtraDeckCatalogRow).map((row) => row.ygoprodeck_id));
    return ids.filter((id) => eligible.has(id));
  };

  const analyzeBoosterDraft = (config: DraftConfig, players: number, guildId: string) => {
    const numberError = boosterDraftConfigError(config);
    if (numberError) return { ok: false, errors: [numberError], warnings: [] };
    const packSize = config.packSize ?? defaultDraftConfig.packSize;
    const waves = boosterMainRounds(config);
    const main = resolveMainCardIds(config);
    const mainPool = prepareBoosterPool(main, config, players * waves * packSize);
    const analysis = analyzeCube(mainPool, players, waves, packSize, mainDraftPicksPerPlayer(config));
    // Full final packs are optional. A truly exhausted pool is advisory, and uses every available copy.
    analysis.errors = mainPool.length === 0 ? ["Draft pool is empty"] : [];
    const needed = players * mainDraftPicksPerPlayer(config);
    if (mainPool.length < needed) analysis.warnings.push(`Main pool has ${mainPool.length} cards for ${needed} requested picks (${players} players × ${mainDraftPicksPerPlayer(config)}). Players may finish with fewer Main Deck cards when the pool runs out.`);
    const extraSize = boosterExtraSize(config);
    if (!numberError && extraSize > 0) {
      const extra = analyzeCube(resolveExtraCardIds(config, guildId), players, 1, extraSize, extraSize);
      analysis.errors.push(...extra.errors.map((e) => `Extra pool: ${e}`));
      analysis.warnings.push(...extra.warnings.map((w) => `Extra pool: ${w}`));
    }
    analysis.ok = analysis.errors.length === 0;
    return analysis;
  };

  const resolveMainCardIds = (config: DraftConfig): number[] => {
    const ids = config.cubeCardIds?.length ? config.cubeCardIds : config.poolCardIds?.length ? config.poolCardIds : catalogCardIdsForDraft(config);
    // Without a separate Extra round, authored mixed pools keep Extra monsters in the passing packs.
    if (!boosterExtraSize(config)) return ids;
    const extra = new Set((db.prepare("select ygoprodeck_id, type, frame_type from card_catalog").all() as CatalogRow[])
      .filter(isExtraDeckCatalogRow).map((row) => row.ygoprodeck_id));
    return ids.filter((id) => !extra.has(id));
  };

  const openWave = (draftId: number, waveNumber: number, playerCount: number, config: DraftConfig) => {
    const mainPacks = boosterMainRounds(config);
    const mainPackSize = config.packSize ?? defaultDraftConfig.packSize;
    const extra = boosterDraftPhase(config, waveNumber) === "extra";
    const packSize = extra ? boosterExtraSize(config) : mainPackSize;
    const passDirection = waveNumber % 2 === 0 && config.alternatePassDirection ? -1 : 1;
    const insertPack = db.prepare(
      `
        insert into draft_packs (
          draft_id,
          wave_number,
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

    const hasCube = db.prepare("select 1 from draft_deal where draft_id = ? limit 1").get(draftId);

    if (hasCube) {
      const selectSlice = db.prepare(
        "select catalog_card_id from draft_deal where draft_id = ? and position >= ? and position < ? order by position",
      );
      for (let playerIndex = 0; playerIndex < playerCount; playerIndex += 1) {
        const start = extra ? mainPacks * playerCount * mainPackSize + playerIndex * packSize
          : ((waveNumber - 1) * playerCount + playerIndex) * packSize;
        const sliceRows = selectSlice.all(
          draftId,
          start,
          start + packSize,
        ) as Array<{ catalog_card_id: number }>;
        const packId = Number(
          insertPack.run(draftId, waveNumber, playerIndex, playerIndex, passDirection).lastInsertRowid,
        );
        sliceRows.forEach((row, cardIndex) => {
          insertDraftCard.run(draftId, waveNumber, packId, row.catalog_card_id, cardIndex);
        });
      }
      return;
    }

    // Legacy path: drafts already active before the cube model deployed have
    // no draft_deal rows and finish all remaining waves on the old generator.
    const catalogCardIds =
      config.cubeCardIds && config.cubeCardIds.length > 0
        ? config.cubeCardIds
        : config.poolCardIds && config.poolCardIds.length > 0
          ? config.poolCardIds
          : catalogCardIdsForDraft(config);

    if (catalogCardIds.length === 0) {
      throw new Error("Draft pool is empty");
    }

    for (let playerIndex = 0; playerIndex < playerCount; playerIndex += 1) {
      const packId = Number(
        insertPack.run(draftId, waveNumber, playerIndex, playerIndex, passDirection).lastInsertRowid,
      );

      for (let cardIndex = 0; cardIndex < packSize; cardIndex += 1) {
        const catalogCardId = catalogCardIds[Math.floor(Math.random() * catalogCardIds.length)];
        insertDraftCard.run(draftId, waveNumber, packId, catalogCardId, cardIndex);
      }
    }
  };

  // Theme mode: deal each active player a private pack of `themePackSize` distinct
  // choices from their assigned theme's current-phase pool. Returns the number of
  // packs dealt this round (0 when every assigned theme's pool is exhausted).
  const openThemeRound = (draftId: number, roundNumber: number, config: DraftConfig): number => {
    const cardsPerPlayer = mainDraftPicksPerPlayer(config);
    const themePackSize = config.themePackSize ?? 3;
    const burnUnpicked = config.burnUnpicked ?? false;
    const phase: "main" | "extra" = roundNumber <= cardsPerPlayer ? "main" : "extra";

    const insertPack = db.prepare(
      `insert into draft_packs (draft_id, wave_number, origin_seat_index, current_holder_seat_index, pass_direction)
       values (?, ?, ?, ?, ?)`,
    );
    const insertDraftCard = db.prepare(
      `insert into draft_cards (draft_id, wave_number, draft_pack_id, catalog_card_id, position) values (?, ?, ?, ?, ?)`,
    );
    const markFinished = db.prepare(
      "update draft_players set finished_at = ? where draft_id = ? and player_id = ? and finished_at is null",
    );
    const poolStmt = db.prepare(
      "select catalog_card_id, max_copies from cube_cards where cube_id = ? and pool = ?",
    );
    const burnConsumedStmt = db.prepare(
      `select dc.catalog_card_id as catalog_card_id, count(*) as n
         from draft_cards dc
         join draft_packs dp on dp.id = dc.draft_pack_id
        where dp.draft_id = ? and dp.origin_seat_index = ? and dp.wave_number < ?
        group by dc.catalog_card_id`,
    );
    const pickConsumedStmt = db.prepare(
      `select dc.catalog_card_id as catalog_card_id, count(*) as n
         from draft_picks pk
         join draft_cards dc on dc.id = pk.draft_card_id
        where pk.draft_id = ? and pk.player_id = ?
        group by dc.catalog_card_id`,
    );

    const nowIso = new Date().toISOString();
    let dealt = 0;

    for (const player of activePlayerRows(draftId)) {
      const cubeRow = db
        .prepare("select cube_id from draft_player_cube where draft_id = ? and player_id = ?")
        .get(draftId, player.player_id) as { cube_id: number } | undefined;
      const seat = player.seat_index;
      if (!cubeRow || seat === null || seat === undefined) {
        continue;
      }

      const remaining = new Map<number, number>();
      for (const row of poolStmt.all(cubeRow.cube_id, phase) as Array<{ catalog_card_id: number; max_copies: number }>) {
        remaining.set(row.catalog_card_id, row.max_copies);
      }

      const consumed = (
        burnUnpicked
          ? burnConsumedStmt.all(draftId, seat, roundNumber)
          : pickConsumedStmt.all(draftId, player.player_id)
      ) as Array<{ catalog_card_id: number; n: number }>;
      for (const row of consumed) {
        const cur = remaining.get(row.catalog_card_id);
        if (cur !== undefined) {
          remaining.set(row.catalog_card_id, Math.max(0, cur - row.n));
        }
      }

      // A player never gets a card they already hold the maximum copies of.
      const held = heldCopies(draftId, player.player_id);
      const candidates = [...remaining.entries()]
        .filter(([id, count]) => count > 0 && (config.copyLimit === false || !isCapped(held, id)))
        .flatMap(([id, count]) => Array<number>(count).fill(id));
      if (candidates.length === 0) {
        // Exhausting Main must not exclude the player from their Extra rounds.
        if (phase === "extra" || totalThemeRounds(config) === cardsPerPlayer) {
          markFinished.run(nowIso, draftId, player.player_id);
        }
        continue;
      }

      const chosen = [...new Set(seededShuffle(candidates, seedSource()))].slice(0, themePackSize);
      if (chosen.length === 0) continue;
      const packId = Number(insertPack.run(draftId, roundNumber, seat, seat, 1).lastInsertRowid);
      chosen.forEach((catalogCardId, index) => {
        insertDraftCard.run(draftId, roundNumber, packId, catalogCardId, index);
      });
      dealt += 1;
    }

    return dealt;
  };

  // Advance/complete the global round counter past any freshly-opened rounds that
  // dealt zero packs (every assigned theme's pool exhausted). Loops so several empty
  // Extra rounds in a row still terminate. Assumes the just-opened `roundNumber` is set.
  const settleThemeRound = (draftId: number, openedRound: number, dealt: number, config: DraftConfig, now: Date) => {
    let round = openedRound;
    let dealtThisRound = dealt;
    const total = totalThemeRounds(config);
    while (dealtThisRound === 0 && round < total) {
      round += 1;
      dealtThisRound = openThemeRound(draftId, round, config);
    }
    if (dealtThisRound === 0) {
      // Nothing left to deal anywhere — complete.
      completeDraft(draftId, now, round);
      return;
    }
    db.prepare(
      "update drafts set current_wave_number = ?, current_pick_step = 1, pick_deadline_at = ? where id = ?",
    ).run(round, deadlineIso(now, config.pickSeconds ?? defaultDraftConfig.pickSeconds), draftId);
  };

  const assignThemes = (draftId: number, playerIds: number[], config: DraftConfig, guildId: string) => {
    const requested = config.allowedCubeIds ?? [];
    // References are scoped to the draft's guild at the final write boundary.
    // Legacy deleted, unused cubes are still dropped from the allowed list.
    const existing = new Set(
      (db.prepare("select id from cubes where guild_id = ?").all(guildId) as Array<{ id: number }>).map((r) => r.id),
    );
    const foreign = new Set((db.prepare("select id from cubes where guild_id != ?").all(guildId) as Array<{ id: number }>).map((r) => r.id));
    if (requested.some((id) => foreign.has(id))) {
      throw new Error("Allowed themes must belong to the draft's guild");
    }
    const allowed = requested.filter((id) => existing.has(id));
    if (allowed.length === 0) {
      throw new Error("Theme draft requires at least one allowed theme");
    }
    const uniqueThemes = config.uniqueThemes ?? true;
    const selection = config.themeSelection ?? "player_pick";

    if (uniqueThemes && allowed.length < playerIds.length) {
      throw new Error(
        `Theme draft needs at least ${playerIds.length} themes for ${playerIds.length} players when uniqueThemes is on, but only ${allowed.length} are allowed.`,
      );
    }

    const upsertTheme = db.prepare(
      `insert into draft_player_cube (draft_id, player_id, cube_id) values (?, ?, ?)
       on conflict (draft_id, player_id) do update set cube_id = excluded.cube_id`,
    );

    // Existing claims (player_pick lobby). Other modes ignore them.
    const claims = new Map<number, number>();
    if (selection === "player_pick") {
      for (const row of db
        .prepare("select player_id, cube_id from draft_player_cube where draft_id = ?")
        .all(draftId) as Array<{ player_id: number; cube_id: number }>) {
        if (!playerIds.includes(row.player_id) || !allowed.includes(row.cube_id)) {
          throw new Error("Player claims must reference allowed themes in the draft's guild");
        }
        claims.set(row.player_id, row.cube_id);
      }
      if (uniqueThemes && new Set(claims.values()).size !== claims.size) {
        throw new Error("Player claims must be distinct when uniqueThemes is enabled");
      }
    }

    const shuffled = seededShuffle(allowed, seedSource());
    const used = new Set<number>(claims.values());
    let cursor = 0;
    const nextTheme = (): number => {
      if (uniqueThemes) {
        while (cursor < shuffled.length && used.has(shuffled[cursor])) cursor += 1;
        const theme = shuffled[cursor] ?? shuffled[shuffled.length - 1];
        used.add(theme);
        cursor += 1;
        return theme;
      }
      const theme = shuffled[cursor % shuffled.length];
      cursor += 1;
      return theme;
    };

    for (const playerId of playerIds) {
      let themeId: number | undefined;
      if (selection === "host_assigned") {
        themeId = config.themeAssignments?.[String(playerId)];
        if (themeId === undefined) {
          throw new Error(`Host-assigned theme draft is missing an assignment for player ${playerId}`);
        }
      } else if (selection === "player_pick" && claims.has(playerId)) {
        themeId = claims.get(playerId);
      } else {
        themeId = nextTheme();
      }
      upsertTheme.run(draftId, playerId, themeId);
    }
  };

  const preflightThemes = (draftId: number, config: DraftConfig) => {
    const cardsPerPlayer = mainDraftPicksPerPlayer(config);
    const themePackSize = config.themePackSize ?? 3;
    const burnUnpicked = config.burnUnpicked ?? false;
    const requiredMain = burnUnpicked ? cardsPerPlayer * themePackSize : cardsPerPlayer + (themePackSize - 1);

    const rows = db.prepare("select distinct cube_id from draft_player_cube where draft_id = ?")
      .all(draftId) as Array<{ cube_id: number }>;

    // A player never gets more than MAX_COPIES_PER_PLAYER of one card, so a cube with many
    // copies of a few cards cannot fill a deck even when the raw count looks big enough.
    // Each burned choice can consume a reachable copy too. Requiring enough
    // capped-reachable copies for all choices is conservative for any pick order.
    const requiredReachable = requiredMain;

    for (const row of rows) {
      const { size: mainSize, reachable: reachableSize } = cubePoolSizes(db, row.cube_id, "main");
      if (mainSize < requiredMain) {
        throw new Error(
          `Cube ${row.cube_id} has only ${mainSize} main-pool cards but needs ${requiredMain} to fill a ${cardsPerPlayer}-card main deck.`,
        );
      }
      if (config.copyLimit !== false && reachableSize < requiredReachable) {
        throw new Error(
          `Cube ${row.cube_id} gives one player only ${reachableSize} main-pool cards (at most ${MAX_COPIES_PER_PLAYER} copies of a card) but needs ${requiredReachable} to fill a ${cardsPerPlayer}-card main deck${burnUnpicked ? " including burned choices (burn on)" : ""}.`,
        );
      }
    }
  };

  const startThemeDraft = (draftId: number, draft: Draft, now: Date): Draft => {
    const numberError = themeDraftNumberError(draft.config);
    if (numberError) throw new Error(numberError);
    const playerIds = db
      .prepare("select player_id from draft_players where draft_id = ? order by joined_at asc, rowid asc")
      .all(draftId)
      .map((row: any) => row.player_id as number);

    if (playerIds.length < 2) {
      throw new Error("Draft requires at least two players to start");
    }

    if (draft.config.themeSelection === "host_assigned") {
      const assignments = draft.config.themeAssignments ?? {};
      const assignedCubeIds = playerIds.map((playerId) => assignments[String(playerId)]);
      const allowed = draft.config.allowedCubeIds ?? [];
      const validAssignment = (cubeId: number) => Number.isInteger(cubeId) && allowed.includes(cubeId);
      if (!assignedCubeIds.every(validAssignment)) {
        throw new Error("Host-assigned themes require an allowed theme assignment for every player. Choose Random or Players pick instead.");
      }

      const findCube = db.prepare("select id from cubes where id = ? and guild_id = ?");
      if (assignedCubeIds.some((cubeId) => !findCube.get(cubeId, draft.guildId))) {
        throw new Error("Host-assigned themes must exist in the draft's guild. Choose valid themes or switch to Random or Players pick.");
      }

      if ((draft.config.uniqueThemes ?? true) && new Set(assignedCubeIds).size !== assignedCubeIds.length) {
        throw new Error("Host-assigned themes must be distinct when uniqueThemes is enabled.");
      }
    }

    const assignSeat = db.prepare("update draft_players set seat_index = ? where draft_id = ? and player_id = ?");
    for (const [seatIndex, playerId] of seatOrder(playerIds, draft.config).entries()) {
      assignSeat.run(seatIndex, draftId, playerId);
    }

    assignThemes(draftId, playerIds, draft.config, draft.guildId);
    preflightThemes(draftId, draft.config);

    db.prepare(
      `update drafts set status = 'active', started_at = ?, current_wave_number = 1, current_pick_step = 1, pick_deadline_at = ? where id = ?`,
    ).run(now.toISOString(), deadlineIso(now, draft.config.pickSeconds ?? defaultDraftConfig.pickSeconds), draftId);

    const dealt = openThemeRound(draftId, 1, draft.config);
    settleThemeRound(draftId, 1, dealt, draft.config, now);

    return findById(draftId);
  };

  const startDraft = db.transaction((draftId: number, now = new Date(), options: DraftStartOptions = {}) => {
    const draft = findById(draftId);

    if (draft.status !== "pending") {
      throw new Error("Draft must be pending to start");
    }

    const schedule = db.prepare("select lobby_start_token, lobby_start_revision, lobby_revision from drafts where id = ?")
      .get(draftId) as { lobby_start_token: string | null; lobby_start_revision: number | null; lobby_revision: number };
    if ((schedule.lobby_start_token || options.scheduleToken) && (schedule.lobby_start_token !== options.scheduleToken
      || schedule.lobby_start_revision !== schedule.lobby_revision)) {
      throw new DraftLobbyServiceError("Start token does not match the current countdown", "START_TOKEN_MISMATCH");
    }
    const joined = db.prepare(`select p.id, p.guild_id from draft_players dp join players p on p.id = dp.player_id
      where dp.draft_id = ?`).all(draftId) as Array<{ id: number; guild_id: string }>;
    assertLobbySeatTarget(draft.config, joined.length);
    for (const player of joined) assertPlayerGuild(player.id, draft.guildId);

    if (draft.config.mode === "theme") {
      const started = startThemeDraft(draftId, draft, now);
      clearDraftLobbyStart(db, draftId, true);
      db.prepare("update drafts set lobby_revision = lobby_revision + 1 where id = ?").run(draftId);
      return started;
    }
    const numberError = boosterDraftConfigError(draft.config);
    if (numberError) throw new Error(numberError);

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

    for (const [seatIndex, playerId] of seatOrder(playerIds, draft.config).entries()) {
      assignSeat.run(seatIndex, draftId, playerId);
    }

    const packSize = draft.config.packSize ?? defaultDraftConfig.packSize;
    const packsPerPlayer = boosterMainRounds(draft.config);

    const poolCardIds = resolveMainCardIds(draft.config);

    const players = playerIds.length;
    const waves = packsPerPlayer;
    const cubeCardIds = prepareBoosterPool(poolCardIds, draft.config, players * waves * packSize);
    const analysis = analyzeBoosterDraft(draft.config, players, draft.guildId);
    if (!analysis.ok) {
      throw new Error(analysis.errors.join(" "));
    }

    const seed = seedSource();
    const { packs, remainder } = buildCappedBoosterDeal(cubeCardIds, players, draft.config, seed);
    const extraSize = boosterExtraSize(draft.config);
    const extraDeal = extraSize > 0 ? buildDealWithRemainder(resolveExtraCardIds(draft.config, draft.guildId),
      { players, waves: 1, packSize: extraSize, seed: seedSource() }) : { packs: [], remainder: [] };
    const insertCube = db.prepare(
      "insert into draft_deal (draft_id, position, catalog_card_id) values (?, ?, ?)",
    );
    let position = 0;
    for (const [packIndex, pack] of [...packs, ...extraDeal.packs].entries()) {
      const width = packIndex < packs.length ? packSize : extraSize;
      pack.forEach((cardId, cardIndex) => insertCube.run(draftId, position + cardIndex, cardId));
      // Preserve the slot offsets read by openWave even when a finite pool has partial packs.
      position += width;
    }

    const insertUndealt = db.prepare("insert into draft_undealt (draft_id, position, catalog_card_id) values (?, ?, ?)");
    for (const cardId of [...remainder, ...extraDeal.remainder]) insertUndealt.run(draftId, position++, cardId);

    openWave(draftId, 1, playerIds.length, draft.config);

    db.prepare(
      `
        update drafts
        set status = 'active',
            config_json = ?,
            started_at = ?,
            current_wave_number = 1,
            current_pick_step = 1,
            pick_deadline_at = ?
        where id = ?
      `,
    ).run(JSON.stringify(draft.config), now.toISOString(), deadlineIso(now, draft.config.pickSeconds ?? defaultDraftConfig.pickSeconds), draftId);

    clearDraftLobbyStart(db, draftId, true);
    db.prepare("update drafts set lobby_revision = lobby_revision + 1 where id = ?").run(draftId);
    return findById(draftId);
  });

  const waveHasPickableCard = (draftId: number, waveNumber: number, active: DraftPlayerProgressRow[]): boolean =>
    active.length > 0 && Boolean(db.prepare("select 1 from draft_cards where draft_id = ? and wave_number = ? and picked_by_player_id is null limit 1").get(draftId, waveNumber));

  const finishCappedMainPacks = (draft: Draft) => {
    if (boosterDraftPhase(draft.config, draft.currentPackRound) !== "main") return;
    const mainRounds = boosterMainRounds(draft.config);
    if (!draft.config.burnUnpicked) {
      const leftover = db.prepare("select catalog_card_id from draft_cards where draft_id = ? and wave_number <= ? and picked_by_player_id is null order by id")
        .all(draft.id, mainRounds) as Array<{ catalog_card_id: number }>;
      let position = (db.prepare("select coalesce(max(position), -1) as n from draft_undealt where draft_id = ?").get(draft.id) as { n: number }).n + 1;
      const insert = db.prepare("insert into draft_undealt (draft_id, position, catalog_card_id) values (?, ?, ?)");
      for (const card of leftover) insert.run(draft.id, position++, card.catalog_card_id);
    }
    db.prepare("delete from draft_cards where draft_id = ? and wave_number <= ? and picked_by_player_id is null").run(draft.id, mainRounds);
  };

  // Empty seats pass. A capped pack offers a swap or a forced pick, so it never loses a pick.
  // Finish the step after all active seats act, and rotate every pack in the usual direction.
  const settleBoosterStep = (draftId: number, now: Date) => {
    const insertPass = db.prepare(
      `
        insert or ignore into draft_passes (draft_id, player_id, wave_number, pick_step, passed_at)
        values (?, ?, ?, ?, ?)
      `,
    );
    const updatePackHolder = db.prepare("update draft_packs set current_holder_seat_index = ? where id = ?");

    // Steps in a row where nobody could pick. With packs on distinct seats, one full turn of the table
    // shows every pack to every seat. A seat visit takes picksPerStep selections, so count full visits
    // before deciding that packs are stacked on one seat
    // (drafts that started under the old rotation). Then each pack goes back to its origin seat once;
    // if the table is still stuck after that, the wave ends. This keeps the loop from running forever.
    let idleSteps = 0;
    let waveRound = -1;
    let repaired = false;

    for (;;) {
      const draft = findById(draftId);
      if (draft.status !== "active") {
        return;
      }
      if (draft.currentPackRound !== waveRound) {
        waveRound = draft.currentPackRound;
        idleSteps = 0;
        repaired = false;
      }

      const active = activePlayerRows(draftId).filter((row) => row.pick_count < boosterPhaseTarget(draft, row.player_id));
      if (active.length === 0) {
        finishCappedMainPacks(draft);
        if (boosterDraftPhase(draft.config, draft.currentPackRound) === "main" && boosterExtraSize(draft.config) > 0) {
          const extraRound = boosterMainRounds(draft.config) + 1;
          openWave(draftId, extraRound, allSeatIndexes(draftId).length, draft.config);
          db.prepare("update drafts set current_wave_number = ?, current_pick_step = 1, pick_deadline_at = ? where id = ?")
            .run(extraRound, deadlineIso(now, draft.config.pickSeconds ?? defaultDraftConfig.pickSeconds), draftId);
          continue;
        }
        completeDraft(draftId, now);
        return;
      }

      const { currentPackRound, currentPickStep } = draft;
      for (const row of active) {
        if (
          !hasActedCurrentStep(draftId, row.player_id, currentPackRound, currentPickStep) &&
          currentPackOptionsInternal(draftId, row.player_id, true).length === 0
        ) {
          insertPass.run(draftId, row.player_id, currentPackRound, currentPickStep, now.toISOString());
        }
      }

      if (active.some((row) => !hasActedCurrentStep(draftId, row.player_id, currentPackRound, currentPickStep))) {
        return;
      }

      // With all seats in rotation, every remaining pack can reach every active
      // player. End a wave only when no active player can take a remaining card.
      idleSteps += 1;
      const stuck = idleSteps > (allSeatIndexes(draftId).length + 1) * (draft.config.picksPerStep ?? 1);
      if (stuck && !repaired) {
        db.prepare(
          "update draft_packs set current_holder_seat_index = origin_seat_index where draft_id = ? and wave_number = ?",
        ).run(draftId, currentPackRound);
        repaired = true;
        idleSteps = 0;
        continue;
      }
      if (stuck || !waveHasPickableCard(draftId, currentPackRound, active)) {
        const mainPacks = boosterMainRounds(draft.config);
        const totalPacks = mainPacks + (boosterExtraSize(draft.config) > 0 ? 1 : 0);
        if (currentPackRound === mainPacks) finishCappedMainPacks(draft);
        if (currentPackRound >= totalPacks) {
          completeDraft(draftId, now);
          return;
        }
        const seatCount = allSeatIndexes(draftId).length;
        openWave(draftId, currentPackRound + 1, seatCount, draft.config);
        db.prepare(
          `
            update drafts
            set current_wave_number = ?, current_pick_step = 1, pick_deadline_at = ?
            where id = ?
          `,
        ).run(
          currentPackRound + 1,
          deadlineIso(now, draft.config.pickSeconds ?? defaultDraftConfig.pickSeconds),
          draftId,
        );
        continue;
      }

      const seatIndexes = allSeatIndexes(draftId);
      const currentPacks = db
        .prepare(
          `
            select id, current_holder_seat_index, pass_direction
            from draft_packs
            where draft_id = ? and wave_number = ?
            order by id asc
          `,
        )
        .all(draftId, currentPackRound) as Array<{
        id: number;
        current_holder_seat_index: number;
        pass_direction: number;
      }>;

      // Each pick keeps its own persisted step/deadline; pass only after the configured group.
      for (const pack of currentPickStep % (draft.config.picksPerStep ?? 1) === 0 ? currentPacks : []) {
        updatePackHolder.run(
          advanceSeatIndex(seatIndexes, pack.current_holder_seat_index, pack.pass_direction),
          pack.id,
        );
      }

      db.prepare(
        `
          update drafts
          set current_pick_step = current_pick_step + 1,
              pick_deadline_at = ?
          where id = ?
        `,
      ).run(deadlineIso(now, draft.config.pickSeconds ?? defaultDraftConfig.pickSeconds), draftId);

      // Finished seats do not gate the step; rounds with only passes rotate immediately.
    }
  };

  // Theme-mode pick: validate the card is in the player's private pack, record it,
  // and advance the global round once every player dealt a pack this round has picked.
  // Does NOT run the booster pass-the-pack logic.
  const pickThemeCard = (
    draftId: number,
    playerId: number,
    draftCardId: number,
    pickMethod: "manual" | "auto",
    now: Date,
  ): DraftPick => {
    const draft = findById(draftId);
    const config = draft.config;
    const total = totalThemeRounds(config);

    const playerRow = playerProgress(draftId, playerId);
    if (playerRow.finished_at !== null || playerRow.pick_count >= total) {
      throw new Error("Player has already finished drafting");
    }
    if (hasPickedCurrentStep(draftId, playerId, draft.currentPackRound, 1)) {
      throw new Error("Player has already picked this step");
    }

    const seat = playerSeatIndex(draftId, playerId);
    const pack = currentPackAtSeat(draftId, draft.currentPackRound, seat);
    if (!pack) {
      throw new Error("Player has no current pack");
    }
    const cardRow = db
      .prepare("select wave_number, draft_pack_id, picked_by_player_id from draft_cards where id = ? and draft_id = ?")
      .get(draftCardId, draftId) as DraftCardRow | undefined;
    if (!cardRow || cardRow.wave_number !== draft.currentPackRound) {
      throw new Error("Card is not in the current wave");
    }
    if (cardRow.draft_pack_id !== pack.id) {
      throw new Error("Card is not in your current pack");
    }
    if (cardRow.picked_by_player_id !== null) {
      throw new Error("Card has already been picked");
    }
    assertUnderCopyCap(draftId, playerId, draftCardId);

    db.prepare("update draft_cards set picked_by_player_id = ?, picked_at = ? where id = ?").run(
      playerId,
      now.toISOString(),
      draftCardId,
    );
    const result = db
      .prepare(
        `insert into draft_picks (draft_id, player_id, draft_card_id, wave_number, pick_step, pick_method, picked_at)
         values (?, ?, ?, ?, 1, ?, ?)`,
      )
      .run(draftId, playerId, draftCardId, draft.currentPackRound, pickMethod, now.toISOString());
    db.prepare(
      `update draft_players set pick_count = pick_count + 1,
              finished_at = case when pick_count + 1 >= ? then ? else finished_at end
        where draft_id = ? and player_id = ?`,
    ).run(total, now.toISOString(), draftId, playerId);

    // Advance gate: every player dealt a pack this round must have picked.
    const dealt = db
      .prepare("select count(*) as n from draft_packs where draft_id = ? and wave_number = ?")
      .get(draftId, draft.currentPackRound) as { n: number };
    const picked = db
      .prepare("select count(*) as n from draft_picks where draft_id = ? and wave_number = ?")
      .get(draftId, draft.currentPackRound) as { n: number };

    if (picked.n >= dealt.n) {
      if (draft.currentPackRound >= total) {
        completeDraft(draftId, now);
      } else {
        const nextRound = draft.currentPackRound + 1;
        const dealtNext = openThemeRound(draftId, nextRound, config);
        settleThemeRound(draftId, nextRound, dealtNext, config, now);
      }
    }

    return mapDraftPick(db.prepare("select * from draft_picks where id = ?").get(Number(result.lastInsertRowid)));
  };

  const pickCard = db.transaction(
    (
      draftId: number,
      playerId: number,
      draftCardId: number,
      pickMethod: "manual" | "auto" = "manual",
      now = new Date(),
    ) => {
    const draft = findById(draftId);
    assertActiveDraft(draft);
    assertJoinedPlayer(draftId, playerId);

    if (draft.config.mode === "theme") {
      return pickThemeCard(draftId, playerId, draftCardId, pickMethod, now);
    }

    const playerRow = playerProgress(draftId, playerId);

    const cardsPerPlayer = boosterDraftPhase(draft.config, draft.currentPackRound) === "extra"
      ? boosterPhaseTarget(draft, playerId) : totalBoosterCards(draft.config);
    if (playerRow.finished_at !== null || playerRow.pick_count >= boosterPhaseTarget(draft, playerId)) {
      throw new Error("Player has already finished drafting");
    }

    if (hasPickedCurrentStep(draftId, playerId, draft.currentPackRound, draft.currentPickStep)) {
      throw new Error("Player has already picked this step");
    }
    if (hasPassedStep(draftId, playerId, draft.currentPackRound, draft.currentPickStep)) {
      throw new Error("Player has no card to pick this step");
    }

    prepareBoosterPack(draftId, playerId);

    const cardRow = db
      .prepare("select wave_number, draft_pack_id, picked_by_player_id from draft_cards where id = ? and draft_id = ?")
      .get(draftCardId, draftId) as DraftCardRow | undefined;

    if (!cardRow || cardRow.wave_number !== draft.currentPackRound) {
      throw new Error("Card is not in the current wave");
    }

    const seatIndex = playerSeatIndex(draftId, playerId);
    const currentPack = currentPackAtSeat(draftId, draft.currentPackRound, seatIndex);

    if (!currentPack) {
      throw new Error("Player has no current pack");
    }

    if (cardRow.draft_pack_id !== currentPack.id) {
      throw new Error("Card is not in your current pack");
    }

    if (cardRow.picked_by_player_id !== null) {
      throw new Error("Card has already been picked");
    }
    const forced = assertUnderCopyCap(draftId, playerId, draftCardId);

    db.prepare(
      `
        update draft_cards
        set picked_by_player_id = ?, picked_at = ?
        where id = ?
      `,
    ).run(playerId, now.toISOString(), draftCardId);

    const result = db
      .prepare(
        `
          insert into draft_picks (draft_id, player_id, draft_card_id, wave_number, pick_step, pick_method, forced, picked_at)
          values (?, ?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(draftId, playerId, draftCardId, draft.currentPackRound, draft.currentPickStep, pickMethod,
        forced ? 1 : 0,
        now.toISOString());

    db.prepare(
      `
        update draft_players
        set pick_count = pick_count + 1,
            finished_at = case when pick_count + 1 >= ? then ? else finished_at end
        where draft_id = ? and player_id = ?
      `,
    ).run(cardsPerPlayer, now.toISOString(), draftId, playerId);

    settleBoosterStep(draftId, now);

    const pickRow = db.prepare("select * from draft_picks where id = ?").get(Number(result.lastInsertRowid));
    return mapDraftPick(pickRow);
    },
  );

  const recordManualPick = db.transaction(
    (draftId: number, playerId: number, draftCardId: number, now = new Date()): { alreadyPicked: boolean } => {
      const draftBefore = findById(draftId);
      expireCurrentPickStep(draftId, now);
      if (hasPickedCurrentStep(draftId, playerId, draftBefore.currentPackRound, draftBefore.currentPickStep)) {
        return { alreadyPicked: true };
      }
      pickCard(draftId, playerId, draftCardId, "manual", now);
      return { alreadyPicked: false };
    },
  );

  const expireCurrentPickStep = db.transaction((draftId: number, now = new Date()): { autoPickedPlayerIds: number[] } => {
    const draft = findById(draftId);

    if (draft.status !== "active" || !draft.pickDeadlineAt || new Date(draft.pickDeadlineAt).getTime() > now.getTime()) {
      return { autoPickedPlayerIds: [] };
    }

    const pendingPlayers = activePlayerRows(draftId)
      .filter((row) => !hasActedCurrentStep(draftId, row.player_id, draft.currentPackRound, draft.currentPickStep))
      .map((row) => row.player_id);
    const autoPickedPlayerIds: number[] = [];

    for (const playerId of pendingPlayers) {
      const current = findById(draftId);
      if (current.status !== "active" || current.currentPackRound !== draft.currentPackRound || current.currentPickStep !== draft.currentPickStep) break;
      // Only cards the player may take: a card they hold the maximum copies of is never auto-picked.
      const options = currentPackOptionsInternal(draftId, playerId, true);

      if (options.length === 0) {
        continue;
      }

      const option = options[Math.floor(Math.random() * options.length)];
      pickCard(draftId, playerId, option.id, "auto", now);
      autoPickedPlayerIds.push(playerId);
    }

    // A player with nothing to pick passes; this closes the step if they were the last one waited on.
    if (draft.config.mode !== "theme") {
      settleBoosterStep(draftId, now);
    }

    return { autoPickedPlayerIds };
  });

  // Legal choices first; a fully capped booster pack permits one forced pick.
  const currentPackOptionsInternal = (draftId: number, playerId: number, pickableOnly = false, swapping = false): DraftCard[] => {
    const draft = findById(draftId);
    if (draft.status === "completed") {
      return [];
    }
    assertActiveDraft(draft);
    assertJoinedPlayer(draftId, playerId);

    const playerRow = playerProgress(draftId, playerId);

    const perPlayerTotal =
      draft.config.mode === "theme"
        ? totalThemeRounds(draft.config)
        : boosterPhaseTarget(draft, playerId);
    if (playerRow.finished_at !== null || playerRow.pick_count >= perPlayerTotal) {
      return [];
    }

    if (hasActedCurrentStep(draftId, playerId, draft.currentPackRound, draft.currentPickStep)) {
      return [];
    }

    const seatIndex = playerSeatIndex(draftId, playerId);
    const pack = currentPackAtSeat(draftId, draft.currentPackRound, seatIndex);

    if (!pack) {
      return [];
    }

    const readCards = () => db
      .prepare(
        `
          select * from draft_cards
          where draft_pack_id = ? and picked_by_player_id is null
          order by position asc, id asc
        `,
      )
      .all(pack.id)
      .map(mapDraftCard);
    let cards = readCards();
    if (draft.config.copyLimit === false) return cards;

    const held = heldCopies(draftId, playerId);
    let legal = cards.filter((card) => !isCapped(held, card.catalogCardId));
    if (draft.config.mode !== "theme" && cards.length > 0 && legal.length === 0) {
      if (!swapping) {
        const remainder = boosterRemainder(draft);
        // Only take the write lock if a swap is possible; recheck everything inside it.
        if (remainder.some((card) => !isCapped(held, card.catalog_card_id))) {
          return swapPackOptions(draftId, playerId, pickableOnly);
        }
      } else {
        prepareBoosterPack(draftId, playerId);
        cards = readCards();
        legal = cards.filter((card) => !isCapped(held, card.catalogCardId));
      }
    }
    if (draft.config.mode !== "theme" && legal.length === 0) {
      return cards.map((card) => ({ ...card, forced: true }));
    }
    return pickableOnly ? legal : cards;
  };

  const swapPackOptions = db.transaction((draftId: number, playerId: number, pickableOnly: boolean) =>
    currentPackOptionsInternal(draftId, playerId, pickableOnly, true),
  ).immediate;

  return {
    create(
      guildId: string,
      channelId: string | null,
      name: string,
      config: DraftConfig,
      createdByUserId: number,
      creatorPlayerId: number,
      visibility: DraftVisibility = "private",
    ): Draft {
      const existingCurrent = db
        .prepare(
          `
          select id from drafts
          where guild_id = ?
            and created_by_user_id = ?
            and name = ?
            and status in ('pending', 'active')
          limit 1
        `,
        )
        .get(guildId, createdByUserId, name);

      if (existingCurrent) {
        throw new CurrentNameTakenError("draft");
      }

      assertPlayerGuild(creatorPlayerId, guildId);

      try {
        return findById(createDraft(guildId, channelId, name, config, createdByUserId, creatorPlayerId, visibility));
      } catch (error) {
        if ((error as { code?: string }).code === "SQLITE_CONSTRAINT_UNIQUE" && error instanceof Error
          && error.message.includes("drafts.guild_id, drafts.created_by_user_id, drafts.name")) {
          throw new CurrentNameTakenError("draft");
        }
        throw error;
      }
    },

    findById,

    /** Caller-aware bot lookup: prefer their current entry, then the newest readable entry. */
    findByName(guildId: string, name: string, userId?: number): Draft | undefined {
      const rows = db
        .prepare(
          `
          select * from drafts
          where guild_id = ? and name = ?
          order by
            case when status in ('pending', 'active') then 0 else 1 end,
            case when created_by_user_id = ? then 0 else 1 end,
            created_at desc, id desc
        `,
        )
        .all(guildId, name, userId ?? null) as Array<{ id: number }>;

      const row = rows.find(row => userId === undefined || findDraftReadAccess(db, row.id, guildId, userId)?.canRead);

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

    listActive(): Draft[] {
      return db
        .prepare(
          `
          select * from drafts
          where status = 'active'
          order by id asc
        `,
        )
        .all()
        .map(mapDraft);
    },

    join(draftId: number, playerId: number): void {
      db.transaction(() => {
        const draft = findById(draftId);

        if (draft.status !== "pending") {
          throw new DraftLobbyServiceError("Draft is no longer accepting players", "DRAFT_NOT_PENDING");
        }

        assertPlayerGuild(playerId, draft.guildId);

        const existing = db.prepare("select 1 from draft_players where draft_id = ? and player_id = ?").get(draftId, playerId);

        if (existing) {
          throw new Error("You have already joined this draft");
        }

        const count = (db.prepare("select count(*) as n from draft_players where draft_id = ?").get(draftId) as { n: number }).n;
        assertLobbySeatTarget(draft.config, count);
        if (draft.config.lobbySeats !== undefined && count >= draft.config.lobbySeats) {
          throw new DraftLobbyServiceError("All lobby seats are occupied", "LOBBY_FULL");
        }

        db.prepare("insert into draft_players (draft_id, player_id) values (?, ?)").run(draftId, playerId);
        invalidateDraftLobby(db, draftId);
      }).immediate();
    },

    players(draftId: number): DraftPlayer[] {
      return db
        .prepare(
          `
          select p.id as player_id, p.display_name, dp.seat_index
          from draft_players dp
          inner join players p on p.id = dp.player_id
          where dp.draft_id = ?
          order by dp.seat_index asc, dp.joined_at asc, dp.rowid asc
        `,
        )
        .all(draftId)
        .map((row: any) => ({
          playerId: row.player_id,
          displayName: row.display_name,
          ...(row.seat_index === null ? {} : { seatIndex: row.seat_index }),
        }));
    },

    start(draftId: number, now = new Date(), options: DraftStartOptions = {}): Draft {
      return startDraft.immediate(draftId, now, options);
    },

    currentPackOptions(draftId: number, playerId: number): DraftCard[] {
      return currentPackOptionsInternal(draftId, playerId);
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

    /** The cards the player may take now: the pack without cards they hold the maximum copies of. */
    pickOptions(draftId: number, playerId: number): DraftCard[] {
      return currentPackOptionsInternal(draftId, playerId, true);
    },

    /** Copies of each passcode the player holds in this draft, for showing the per-player cap. */
    heldCopies(draftId: number, playerId: number): Record<number, number> {
      assertJoinedPlayer(draftId, playerId);
      return Object.fromEntries(heldCopies(draftId, playerId));
    },

    /** True when the player has no card to pick this step and passed (or must pass) it. */
    hasPassedStep(draftId: number, playerId: number): boolean {
      const draft = findById(draftId);
      return hasPassedStep(draftId, playerId, draft.currentPackRound, draft.currentPickStep);
    },

    pickCard(
      draftId: number,
      playerId: number,
      draftCardId: number,
      pickMethod: "manual" | "auto" = "manual",
      now = new Date(),
    ): DraftPick {
      return pickCard.immediate(draftId, playerId, draftCardId, pickMethod, now);
    },

    expireCurrentPickStep(draftId: number, now = new Date()): { autoPickedPlayerIds: number[] } {
      return expireCurrentPickStep.immediate(draftId, now);
    },

    recordManualPick(draftId: number, playerId: number, draftCardId: number, now = new Date()): { alreadyPicked: boolean } {
      return recordManualPick.immediate(draftId, playerId, draftCardId, now);
    },

    pool(draftId: number, playerId: number): DraftPoolCard[] {
      return pool(draftId, playerId);
    },

    exportYdk(draftId: number, playerId: number): string {
      return exportYdk(draftId, playerId);
    },

    picks(draftId: number): DraftPick[] {
      findById(draftId);

      return db
        .prepare(
          `
            select * from draft_picks
            where draft_id = ?
            order by id asc
          `,
        )
        .all(draftId)
        .map(mapDraftPick);
    },

    setStatusMessageId(draftId: number, messageId: string | null): void {
      findById(draftId);

      db.prepare("update drafts set status_message_id = ? where id = ?").run(messageId, draftId);
    },

    cancel(draftId: number): Draft {
      return db.transaction(() => {
        const draft = findById(draftId);

        if (draft.status === "cancelled") return draft;
        if (draft.status === "completed") {
          throw new DraftTerminalError("Draft is already finished", "DRAFT_ALREADY_FINISHED");
        }
        // Normally only completed drafts have tournaments. Protect legacy/manual links as well.
        if (draft.tournamentId !== undefined) {
          throw new DraftTerminalError("Draft has a linked tournament", "DRAFT_HAS_TOURNAMENT");
        }
        const changed = db.prepare(`update drafts set status = 'cancelled', ended_at = current_timestamp,
          pick_deadline_at = null where id = ? and status in ('pending', 'active')`).run(draftId).changes;
        if (changed !== 1) throw new DraftTerminalError("Draft is already finished", "DRAFT_ALREADY_FINISHED");
        // Keep the draft and roster for access and the cancelled room; discard all drafting data.
        for (const table of ["draft_passes", "draft_picks", "draft_cards", "draft_packs", "draft_undealt", "draft_deal", "draft_player_cube"]) {
          db.prepare(`delete from ${table} where draft_id = ?`).run(draftId);
        }
        db.prepare("update draft_players set pick_count = 0, finished_at = null where draft_id = ?").run(draftId);
        clearDraftLobbyStart(db, draftId, true);
        db.prepare("update drafts set lobby_revision = lobby_revision + 1 where id = ?").run(draftId);

        return findById(draftId);
      }).immediate();
    },

    resolveCubeCardIds(config: DraftConfig): number[] {
      return resolveMainCardIds(config);
    },

    resolveExtraCardIds,
    analyzeBoosterDraft,

    /** @deprecated use resolveCubeCardIds; retained for callers not yet migrated */
    resolvePoolCardIds(config: DraftConfig): number[] {
      return resolveMainCardIds(config);
    },

    autocomplete(input: {
      guildId: string;
      query: string;
      statuses?: DraftStatus[];
      createdByUserId?: number;
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
