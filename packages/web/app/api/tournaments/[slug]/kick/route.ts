import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { auth } from "@/lib/auth";
import { env } from "@/lib/env";
import { createTournamentService } from "@yugidraft/shared/services";
import { notifyWsTournament } from "@/lib/notify-ws-tournament";

export const runtime = "nodejs";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ slug: string }> }
) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { slug } = await params;
    const body = await request.json();
    const playerId = Number(body?.playerId);
    if (!playerId || !Number.isInteger(playerId)) {
      return NextResponse.json({ error: "playerId is required" }, { status: 400 });
    }

    const db = getDb();
    const tournament = db
      .prepare("select id, created_by_user_id, status from tournaments where web_slug = ?")
      .get(slug) as { id: number; created_by_user_id: string; status: string } | undefined;

    if (!tournament) {
      return NextResponse.json({ error: "Tournament not found" }, { status: 404 });
    }

    if (tournament.created_by_user_id !== session.user.id) {
      return NextResponse.json({ error: "Only the organizer can kick participants" }, { status: 403 });
    }

    const tournaments = createTournamentService(db);
    tournaments.kick(tournament.id, session.user.id, playerId);

    void notifyWsTournament(
      { url: env.wsInternalUrl, secret: env.wsInternalSecret },
      { kind: "participant-left", slug, playerId },
    );

    return NextResponse.json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to kick participant";
    console.error("[api/tournaments/[slug]/kick] error:", error);
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
