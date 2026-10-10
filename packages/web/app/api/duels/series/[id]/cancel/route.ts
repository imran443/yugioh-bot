import { NextResponse } from "next/server";
import { createDuelSeriesService, DuelServiceError, findTournamentReadAccess } from "@yugidraft/shared/services";
import { getDb } from "@/lib/db";
import { readDuelControl, duelErrorResponse, requireDuelActor } from "@/lib/duel-host";
import { notifyDuelChange } from "@/lib/notify-duel";
import { broadcaster } from "@/lib/notify";

export const runtime = "nodejs";

/** Casual series: a series player cancels. Tournament series: only the tournament creator. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const actor = await requireDuelActor();
  if (!actor.ok) return actor.response;
  const seriesId = Number((await params).id);
  if (!Number.isInteger(seriesId) || seriesId < 1) {
    return NextResponse.json({ error: "Series not found" }, { status: 404 });
  }

  try {
    readDuelControl(request);
    const db = getDb();
    const seriesService = createDuelSeriesService(db);
    const series = seriesService.get(seriesId, actor.guildId);

    if (series.tournamentId !== null) {
      const tournament = db
        .prepare("select created_by_user_id from tournaments where id = ?")
        .get(series.tournamentId) as { created_by_user_id: number } | undefined;
      const player = db.prepare("select user_id from players where id = ? and guild_id = ?")
        .get(actor.playerId, actor.guildId) as { user_id: number } | undefined;
      if (!tournament || tournament.created_by_user_id !== player?.user_id) {
        const readable = player && findTournamentReadAccess(db, series.tournamentId, actor.guildId, player.user_id)?.canRead;
        throw new DuelServiceError(readable
          ? "Only the tournament organizer can cancel a tournament match"
          : "Only a player of this match can cancel it", 403);
      }
    } else if (!series.playerIds.includes(actor.playerId)) {
      throw new DuelServiceError("Only a player of this match can cancel it", 403);
    }

    const { changedSlugs } = seriesService.cancel(seriesId, actor.guildId);
    const slugs = new Set(changedSlugs);
    if (series.currentDuelSlug) slugs.add(series.currentDuelSlug);
    for (const slug of slugs) await notifyDuelChange(slug, actor.guildId);
    if (series.tournamentSlug) void broadcaster.tournament({ kind: "match-updated", slug: series.tournamentSlug });

    return NextResponse.json({ series: seriesService.get(seriesId, actor.guildId), changedSlugs });
  } catch (error) {
    return duelErrorResponse(error);
  }
}
