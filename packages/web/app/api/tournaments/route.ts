import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { auth } from "@/lib/auth";
import { env } from "@/lib/env";
import { createPlayerService, createTournamentService } from "@yugidraft/shared/services";
import { announceToBot } from "@/lib/announce-bot";

const VALID_FORMATS = ["round_robin", "single_elim"] as const;

export const runtime = "nodejs";

export async function GET() {
  try {
    const db = getDb();
    const tournaments = db
      .prepare(
        `
        select
          t.id,
          t.guild_id,
          t.name,
          t.format,
          t.status,
          t.created_by_user_id,
          t.web_slug,
          count(tp.player_id) as participant_count
        from tournaments t
        left join tournament_participants tp on tp.tournament_id = t.id
        where t.status in ('pending', 'active')
        group by t.id
        order by
          case t.status when 'active' then 0 else 1 end,
          t.created_at desc
      `
      )
      .all()
      .map((row: any) => ({
        id: row.id,
        guildId: row.guild_id,
        name: row.name,
        format: row.format,
        status: row.status,
        createdByUserId: row.created_by_user_id,
        webSlug: row.web_slug ?? undefined,
        participantCount: row.participant_count,
      }));

    return NextResponse.json(tournaments);
  } catch (error) {
    console.error("[api/tournaments] error:", error);
    return NextResponse.json(
      { error: "Failed to load tournaments" },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json();
  const { name, format } = body as { name: string; format: string };

  if (!name || !format) {
    return NextResponse.json(
      { error: "name and format are required" },
      { status: 400 }
    );
  }

  if (!VALID_FORMATS.includes(format as any)) {
    return NextResponse.json(
      { error: "format must be round_robin or single_elim" },
      { status: 400 }
    );
  }

  const guildId = env.discordGuildId;
  if (!guildId) {
    return NextResponse.json(
      { error: "Server not configured for tournament creation" },
      { status: 500 }
    );
  }

  try {
    const db = getDb();
    const players = createPlayerService(db);
    players.findOrCreate(guildId, session.user.id, session.user.name ?? "Unknown");

    const tournaments = createTournamentService(db);
    const tournament = tournaments.create(guildId, name, format as "round_robin" | "single_elim", session.user.id);

    void announceToBot(
      { url: env.botAnnounceUrl, secret: env.botAnnounceSecret },
      {
        kind: "tournament-created",
        tournamentId: tournament.id,
        channelId: env.discordDefaultChannelId,
        name: tournament.name,
        format: tournament.format,
        webSlug: tournament.webSlug ?? "",
      },
    );

    return NextResponse.json(
      {
        id: tournament.id,
        name: tournament.name,
        format: tournament.format,
        status: tournament.status,
        webSlug: tournament.webSlug,
      },
      { status: 201 }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to create tournament";
    console.error("[api/tournaments POST] error:", error);
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
