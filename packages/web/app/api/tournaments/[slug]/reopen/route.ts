import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { auth } from "@/lib/auth";
import { env } from "@/lib/env";
import { createTournamentService } from "@yugidraft/shared/services";
import { notifyWsTournament } from "@/lib/notify-ws-tournament";

export const runtime = "nodejs";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { slug } = await params;
    const body = (await request.json()) as { tournamentMatchId?: number };
    if (!body.tournamentMatchId) {
      return NextResponse.json({ error: "Missing tournamentMatchId" }, { status: 400 });
    }

    const db = getDb();
    const tournament = db
      .prepare("select id from tournaments where web_slug = ?")
      .get(slug) as { id: number } | undefined;
    if (!tournament) {
      return NextResponse.json({ error: "Tournament not found" }, { status: 404 });
    }

    const tm = db
      .prepare("select tournament_id from tournament_matches where id = ?")
      .get(body.tournamentMatchId) as { tournament_id: number } | undefined;
    if (!tm || tm.tournament_id !== tournament.id) {
      return NextResponse.json({ error: "Match not found" }, { status: 404 });
    }

    try {
      createTournamentService(db).reopenTournamentMatch(body.tournamentMatchId, session.user.id);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to reopen";
      const status = /organizer/i.test(message) ? 403 : 400;
      return NextResponse.json({ error: message }, { status });
    }

    void notifyWsTournament(
      { url: env.wsInternalUrl, secret: env.wsInternalSecret },
      { kind: "match-updated", slug },
    );

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("[api/tournaments/[slug]/reopen] error:", error);
    return NextResponse.json({ error: "Failed to reopen match" }, { status: 500 });
  }
}
