import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { auth } from "@/lib/auth";
import { createPlayerService } from "@yugidraft/shared/services";

export const runtime = "nodejs";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ slug: string }> }
) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { slug } = await params;
    const db = getDb();

    const tournament = db
      .prepare("select id, guild_id, status from tournaments where web_slug = ?")
      .get(slug) as { id: number; guild_id: string; status: string } | undefined;

    if (!tournament) {
      return NextResponse.json({ error: "Tournament not found" }, { status: 404 });
    }

    if (tournament.status !== "pending") {
      return NextResponse.json({ error: "Tournament has already started" }, { status: 400 });
    }

    const tournamentId = tournament.id;
    const guildId = tournament.guild_id;

    const players = createPlayerService(db);
    const player = players.findOrCreate(guildId, session.user.id, session.user.name ?? "Unknown");

    const existing = db
      .prepare("select 1 from tournament_participants where tournament_id = ? and player_id = ?")
      .get(tournamentId, player.id);

    if (existing) {
      return NextResponse.json({ error: "You have already joined this tournament" }, { status: 400 });
    }

    db.prepare(
      "insert into tournament_participants (tournament_id, player_id) values (?, ?)"
    ).run(tournamentId, player.id);

    return NextResponse.json({ success: true, playerId: player.id, displayName: player.displayName });
  } catch (error) {
    console.error("[api/tournaments/[slug]/join] error:", error);
    return NextResponse.json(
      { error: "Failed to join tournament" },
      { status: 500 }
    );
  }
}
