import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { env } from "@/lib/env";
import { createCardCatalogService, createDraftService } from "@yugidraft/shared/services";

function getTimerSeconds(pickDeadlineAt: string | null | undefined): number {
  if (!pickDeadlineAt) {
    return 0;
  }

  const remainingMs = new Date(pickDeadlineAt).getTime() - Date.now();
  return Math.max(0, Math.ceil(remainingMs / 1000));
}

function mapDraftCardDetails(
  db: ReturnType<typeof getDb>,
  cards: Array<{ draftCardId: number; catalogCardId: number }>
) {
  if (cards.length === 0) {
    return [];
  }

  const catalog = createCardCatalogService(db);
  const catalogCards = catalog.findByIds(cards.map((card) => card.catalogCardId));

  return cards.map((card, index) => {
    const catalogCard = catalogCards[index];

    return {
      id: card.draftCardId,
      name: catalogCard?.name ?? `Card ${card.catalogCardId}`,
      type: catalogCard?.type ?? "Unknown",
      frameType: catalogCard?.frameType ?? "normal",
      attribute: catalogCard?.attribute,
      level: catalogCard?.level,
      effectText: catalogCard?.effectText ?? "",
      atk: catalogCard?.atk,
      def: catalogCard?.def,
      imageUrl: catalogCard?.imageUrl ?? "",
      imageUrlSmall: catalogCard?.imageUrlSmall ?? catalogCard?.imageUrl ?? "",
    };
  });
}

export async function buildDraftResponse(slug: string, userId: string) {
  const db = getDb();
  const drafts = createDraftService(db);
  const guildId = env.discordGuildId;

  const draft = db
    .prepare(
      `
        select
          d.id,
          d.guild_id,
          d.channel_id,
          d.name,
          d.status,
          d.created_by_user_id,
          d.config_json,
          d.current_wave_number,
          d.current_pick_step,
          d.pick_deadline_at,
          d.status_message_id,
          d.web_slug,
          d.created_at,
          d.started_at,
          d.ended_at,
          count(dp.player_id) as player_count
        from drafts d
        left join draft_players dp on dp.draft_id = d.id
        where d.web_slug = ? and d.guild_id = ?
        group by d.id
      `
    )
    .get(slug, guildId) as any;

  if (!draft) {
    return null;
  }

  const draftModel = drafts.findById(draft.id);

  const players = db
    .prepare(
      `
        select p.id as player_id, p.display_name, dp.seat_index, dp.pick_count, dp.finished_at, dp.joined_at
        from draft_players dp
        inner join players p on p.id = dp.player_id
        where dp.draft_id = ?
        order by dp.joined_at asc, dp.rowid asc
      `
    )
    .all(draft.id)
    .map((row: any) => ({
      playerId: row.player_id,
      displayName: row.display_name,
      seatIndex: row.seat_index ?? undefined,
      pickCount: row.pick_count,
      finishedAt: row.finished_at ?? undefined,
      joinedAt: row.joined_at,
    }));

  const currentPlayer = db
    .prepare("select id from players where guild_id = ? and discord_user_id = ?")
    .get(draft.guild_id, userId) as { id: number } | undefined;

  const isParticipant = currentPlayer
    ? players.some((p: any) => p.playerId === currentPlayer.id)
    : false;

  const pickedPlayerIds = new Set(
    db
      .prepare(
        `
          select player_id from draft_picks
          where draft_id = ? and wave_number = ? and pick_step = ?
        `
      )
      .all(draft.id, draftModel.currentPackRound, draftModel.currentPickStep)
      .map((row: any) => row.player_id as number)
  );

  const seats = players
    .map((player, index) => ({
      seatIndex: player.seatIndex ?? index,
      playerId: player.playerId,
      displayName: player.displayName,
      hasPicked: pickedPlayerIds.has(player.playerId),
      isCurrentPlayer: currentPlayer ? player.playerId === currentPlayer.id : false,
    }))
    .sort((a, b) => a.seatIndex - b.seatIndex);

  const currentPackCards =
    draft.status === "active" && currentPlayer
      ? drafts.currentPackOptions(draft.id, currentPlayer.id).map((card) => ({
          draftCardId: card.id,
          catalogCardId: card.catalogCardId,
        }))
      : [];

  const myPoolCards =
    currentPlayer && isParticipant
      ? drafts.pool(draft.id, currentPlayer.id).map((card) => ({
          draftCardId: card.draftCardId,
          catalogCardId: card.catalogCardId,
        }))
      : [];

  const currentPack = mapDraftCardDetails(db, currentPackCards);
  const myPool = mapDraftCardDetails(db, myPoolCards);
  const timerSeconds = getTimerSeconds(draft.pick_deadline_at);
  const pickSeconds = draftModel.config.pickSeconds ?? 45;
  const isMyTurn = draft.status === "active" && currentPack.length > 0;
  const participantPickCount = currentPlayer && isParticipant
    ? players.find((player) => player.playerId === currentPlayer.id)?.pickCount
    : undefined;

  return {
    id: draft.id,
    guildId: draft.guild_id,
    channelId: draft.channel_id,
    name: draft.name,
    status: draft.status,
    createdByUserId: draft.created_by_user_id,
    config: draftModel.config,
    currentPackRound: draftModel.currentPackRound,
    currentPickStep: draftModel.currentPickStep,
    pickDeadlineAt: draft.pick_deadline_at ?? undefined,
    statusMessageId: draft.status_message_id ?? undefined,
    webSlug: draft.web_slug ?? undefined,
    createdAt: draft.created_at,
    startedAt: draft.started_at ?? undefined,
    endedAt: draft.ended_at ?? undefined,
    playerCount: draft.player_count,
    players,
    participantPickCount,
    isParticipant,
    currentPack,
    myPool,
    seats,
    packRound: draftModel.currentPackRound,
    pickStep: draftModel.currentPickStep,
    timerSeconds,
    isMyTurn,
    completed: draft.status === "completed",
    pickSeconds,
  };
}
