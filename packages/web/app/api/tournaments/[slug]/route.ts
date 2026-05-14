import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { auth } from "@/lib/auth";
import { env } from "@/lib/env";
import { createTournamentService } from "@yugidraft/shared/services";
import { announceToBot } from "@/lib/announce-bot";
import { notifyWsTournament } from "@/lib/notify-ws-tournament";

export const runtime = "nodejs";

type TournamentRow = {
  id: number;
  guild_id: string;
  name: string;
  format: string;
  status: string;
  created_by_user_id: string;
  web_slug: string | null;
};

function resolveTournamentBySlug(db: ReturnType<typeof getDb>, slug: string): TournamentRow | undefined {
  return db.prepare("select * from tournaments where web_slug = ?").get(slug) as TournamentRow | undefined;
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ slug: string }> }
) {
  try {
    const { slug } = await params;
    const db = getDb();

    const tournament = resolveTournamentBySlug(db, slug);

    if (!tournament) {
      return NextResponse.json({ error: "Tournament not found" }, { status: 404 });
    }

    const tournamentId = tournament.id;

    const participants = db
      .prepare(
        `
        select p.id as player_id, p.display_name
        from tournament_participants tp
        inner join players p on p.id = tp.player_id
        where tp.tournament_id = ?
        order by tp.joined_at asc, tp.rowid asc
      `
      )
      .all(tournamentId)
      .map((row: any) => ({
        playerId: row.player_id,
        displayName: row.display_name,
      }));

    const matches = db
      .prepare(
        `
        select
          tm.id,
          tm.tournament_id,
          tm.match_id,
          tm.player_one_id,
          tm.player_two_id,
          tm.round_number,
          tm.status,
          tm.metadata_json,
          m.winner_id,
          m.reporter_id,
          m.approver_id
        from tournament_matches tm
        left join matches m on m.id = tm.match_id
        where tm.tournament_id = ?
        order by tm.round_number asc, tm.id asc
      `
      )
      .all(tournamentId)
      .map((row: any) => ({
        id: row.id,
        tournamentId: row.tournament_id,
        matchId: row.match_id,
        playerOneId: row.player_one_id,
        playerTwoId: row.player_two_id,
        roundNumber: row.round_number,
        status: row.status,
        metadata: JSON.parse(row.metadata_json),
        winnerId: row.winner_id,
        reporterId: row.reporter_id,
        approverId: row.approver_id,
      }));

    const playerMap = new Map(participants.map((p) => [p.playerId, p.displayName]));

    const matchesWithNames = matches.map((match) => ({
      ...match,
      playerOneName: playerMap.get(match.playerOneId) ?? `Player ${match.playerOneId}`,
      playerTwoName: match.playerTwoId ? (playerMap.get(match.playerTwoId) ?? `Player ${match.playerTwoId}`) : null,
    }));

    const session = await auth();
    let isParticipant = false;
    let currentUserPlayerId: number | null = null;
    if (session?.user?.id) {
      const currentPlayer = db
        .prepare("select id from players where guild_id = ? and discord_user_id = ?")
        .get(tournament.guild_id, session.user.id) as { id: number } | undefined;
      if (currentPlayer) {
        currentUserPlayerId = currentPlayer.id;
        isParticipant = participants.some((p) => p.playerId === currentPlayer.id);
      }
    }

    return NextResponse.json({
      id: tournament.id,
      guildId: tournament.guild_id,
      name: tournament.name,
      format: tournament.format,
      status: tournament.status,
      createdByUserId: tournament.created_by_user_id,
      webSlug: tournament.web_slug ?? undefined,
      participants,
      matches: matchesWithNames,
      isParticipant,
      currentUserPlayerId,
    });
  } catch (error) {
    console.error("[api/tournaments/[slug] GET] error:", error);
    return NextResponse.json(
      { error: "Failed to load tournament" },
      { status: 500 }
    );
  }
}

export async function DELETE(
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

    const tournament = resolveTournamentBySlug(db, slug);

    if (!tournament) {
      return NextResponse.json({ error: "Tournament not found" }, { status: 404 });
    }

    if (tournament.created_by_user_id !== session.user.id) {
      return NextResponse.json({ error: "Only the tournament creator can cancel it" }, { status: 403 });
    }

    if (tournament.status === "completed" || tournament.status === "cancelled") {
      return NextResponse.json({ error: `Tournament is already ${tournament.status}` }, { status: 400 });
    }

    db.prepare("update tournaments set status = 'cancelled', ended_at = current_timestamp where id = ?").run(tournament.id);

    void notifyWsTournament(
      { url: env.wsInternalUrl, secret: env.wsInternalSecret },
      { kind: "cancelled", slug },
    );

    return NextResponse.json({ id: tournament.id, status: "cancelled" });
  } catch (error) {
    console.error("[api/tournaments/[slug] DELETE] error:", error);
    return NextResponse.json({ error: "Failed to cancel tournament" }, { status: 500 });
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { slug } = await params;
    const db = getDb();

    const tournament = resolveTournamentBySlug(db, slug);

    if (!tournament) {
      return NextResponse.json({ error: "Tournament not found" }, { status: 404 });
    }

    if (tournament.created_by_user_id !== session.user.id) {
      return NextResponse.json({ error: "Only the tournament creator can modify it" }, { status: 403 });
    }

    if (tournament.status !== "pending") {
      return NextResponse.json({ error: "Can only modify pending tournaments" }, { status: 400 });
    }

    const tournamentId = tournament.id;
    const body = await request.json();
    const { name } = body as { name?: string };

    if (name !== undefined) {
      if (!name.trim()) {
        return NextResponse.json({ error: "Name cannot be empty" }, { status: 400 });
      }

      const existing = db
        .prepare(
          "select id from tournaments where guild_id = ? and name = ? and status in ('pending', 'active') and id != ?"
        )
        .get(tournament.guild_id, name, tournamentId) as { id: number } | undefined;

      if (existing) {
        return NextResponse.json({ error: "A tournament with that name already exists" }, { status: 400 });
      }

      db.prepare("update tournaments set name = ? where id = ?").run(name, tournamentId);
    }

    const updated = db.prepare("select id, name, format, status, web_slug from tournaments where id = ?").get(tournamentId) as any;

    return NextResponse.json({
      id: updated.id,
      name: updated.name,
      format: updated.format,
      status: updated.status,
      webSlug: updated.web_slug ?? undefined,
    });
  } catch (error) {
    console.error("[api/tournaments/[slug] PUT] error:", error);
    return NextResponse.json({ error: "Failed to update tournament" }, { status: 500 });
  }
}

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

    const tournament = resolveTournamentBySlug(db, slug);

    if (!tournament) {
      return NextResponse.json({ error: "Tournament not found" }, { status: 404 });
    }

    if (tournament.created_by_user_id !== session.user.id) {
      return NextResponse.json({ error: "Only the tournament creator can start it" }, { status: 403 });
    }

    const tournaments = createTournamentService(db);
    const started = tournaments.start(tournament.id);

    void announceToBot(
      { url: env.botAnnounceUrl, secret: env.botAnnounceSecret },
      {
        kind: "tournament-started",
        tournamentId: started.id,
        channelId: env.discordDefaultChannelId,
        name: started.name,
        format: started.format,
        webSlug: started.webSlug ?? "",
      },
    );

    void notifyWsTournament(
      { url: env.wsInternalUrl, secret: env.wsInternalSecret },
      { kind: "started", slug },
    );

    return NextResponse.json({
      id: started.id,
      status: started.status,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to start tournament";
    console.error("[api/tournaments/[slug] POST] error:", error);
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
