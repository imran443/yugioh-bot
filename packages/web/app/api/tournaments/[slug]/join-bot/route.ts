import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { auth } from "@/lib/auth";
import { createPlayerService } from "@yugidraft/shared/services";
import { env } from "@/lib/env";
import { notifyWsTournament } from "@/lib/notify-ws-tournament";

export const runtime = "nodejs";

const TOURNAMENT_BOTS = [
  { discordUserId: "tournament_bot_dev_1", displayName: "Bot 1" },
  { discordUserId: "tournament_bot_dev_2", displayName: "Bot 2" },
  { discordUserId: "tournament_bot_dev_3", displayName: "Bot 3" },
] as const;

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { slug } = await params;
    const db = getDb();

    const tournament = db
      .prepare("select id, guild_id, status, created_by_user_id from tournaments where web_slug = ?")
      .get(slug) as { id: number; guild_id: string; status: string; created_by_user_id: string } | undefined;

    if (!tournament) {
      return NextResponse.json({ error: "Tournament not found" }, { status: 404 });
    }

    if (tournament.status !== "pending") {
      return NextResponse.json({ error: "Tournament has already started" }, { status: 400 });
    }

    if (tournament.created_by_user_id !== session.user.id) {
      return NextResponse.json({ error: "Only the organizer can add bots" }, { status: 403 });
    }

    const players = createPlayerService(db);

    for (const botIdentity of TOURNAMENT_BOTS) {
      const bot = players.findOrCreate(tournament.guild_id, botIdentity.discordUserId, botIdentity.displayName);
      const existing = db
        .prepare("select 1 from tournament_participants where tournament_id = ? and player_id = ?")
        .get(tournament.id, bot.id);

      if (existing) {
        continue;
      }

      db.prepare("insert into tournament_participants (tournament_id, player_id) values (?, ?)").run(tournament.id, bot.id);

      void notifyWsTournament(
        { url: env.wsInternalUrl, secret: env.wsInternalSecret },
        {
          kind: "participant-joined",
          slug,
          playerId: bot.id,
          displayName: bot.displayName,
        },
      );

      return NextResponse.json({ success: true, playerId: bot.id, displayName: bot.displayName });
    }

    return NextResponse.json({ error: "No more dev bots available" }, { status: 400 });
  } catch (error) {
    console.error("[api/tournaments/[slug]/join-bot] error:", error);
    return NextResponse.json({ error: "Failed to add bot to tournament" }, { status: 500 });
  }
}
