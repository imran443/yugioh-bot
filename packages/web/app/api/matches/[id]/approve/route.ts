import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { auth } from "@/lib/auth";
import { createMatchService, createPlayerService } from "@yugidraft/shared/services";
import { env } from "@/lib/env";
import { notifyWsTournament } from "@/lib/notify-ws-tournament";
import { announceToBot } from "@/lib/announce-bot";

export const runtime = "nodejs";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { id } = await params;
    const matchId = Number(id);
    if (!Number.isInteger(matchId) || matchId <= 0) {
      return NextResponse.json({ error: "Invalid match id" }, { status: 400 });
    }

    const db = getDb();
    const matches = createMatchService(db);
    const match = db
      .prepare(`
        select m.guild_id, m.tournament_id, t.web_slug as tournament_slug
        from matches m
        left join tournaments t on t.id = m.tournament_id
        where m.id = ?
      `)
      .get(matchId) as { guild_id: string; tournament_id: number | null; tournament_slug: string | null } | undefined;

    if (!match) {
      return NextResponse.json({ error: "Match not found" }, { status: 404 });
    }

    const players = createPlayerService(db);
    const player = players.findByGuildAndUser(match.guild_id, session.user.id);
    if (!player) {
      return NextResponse.json({ error: "Player not found" }, { status: 404 });
    }

    const approved = matches.approve(matchId, player.id);
    void announceToBot(
      { url: env.botAnnounceUrl, secret: env.botAnnounceSecret },
      { kind: "match-resolved", matchId },
    );
    if (approved.tournamentId && matches.claimTournamentCompletionAnnouncement(approved.tournamentId)) {
      void announceToBot(
        { url: env.botAnnounceUrl, secret: env.botAnnounceSecret },
        { kind: "tournament-completed", tournamentId: approved.tournamentId },
      );
    }
    if (match.tournament_slug) {
      void notifyWsTournament(
        { url: env.wsInternalUrl, secret: env.wsInternalSecret },
        { kind: "match-updated", slug: match.tournament_slug },
      );
    }
    return NextResponse.json(approved);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to approve match";
    console.error("[api/matches/[id]/approve] error:", error);
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
