import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { auth } from "@/lib/auth";
import { createMatchService, createPlayerService } from "@yugidraft/shared/services";
import { broadcaster, announcer } from "@/lib/notify";

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

    const denied = matches.deny(matchId, player.id);
    void announcer.announce(
      { kind: "match-resolved", matchId },
    );
    if (match.tournament_slug) {
      void broadcaster.tournament(
        { kind: "match-updated", slug: match.tournament_slug },
      );
    }
    return NextResponse.json(denied);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to deny match";
    console.error("[api/matches/[id]/deny] error:", error);
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
