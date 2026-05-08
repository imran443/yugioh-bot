import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { auth } from "@/lib/auth";
import { createMatchService, createPlayerService } from "@yugidraft/shared/services";

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
    const match = db.prepare("select * from matches where id = ?").get(matchId) as
      | { guild_id: string }
      | undefined;

    if (!match) {
      return NextResponse.json({ error: "Match not found" }, { status: 404 });
    }

    const players = createPlayerService(db);
    const player = players.findByGuildAndUser(match.guild_id, session.user.id);
    if (!player) {
      return NextResponse.json({ error: "Player not found" }, { status: 404 });
    }

    const denied = matches.deny(matchId, player.id);
    return NextResponse.json(denied);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to deny match";
    console.error("[api/matches/[id]/deny] error:", error);
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
