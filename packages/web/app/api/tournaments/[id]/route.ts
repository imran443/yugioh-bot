import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { auth } from "@/lib/auth";
import { generateRoundRobin, generateSingleElimFirstRound } from "@yugidraft/shared/tournaments";

export const runtime = "nodejs";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const tournamentId = Number(id);
    const db = getDb();

    const tournament = db
      .prepare("select * from tournaments where id = ?")
      .get(tournamentId) as
      | {
          id: number;
          guild_id: string;
          name: string;
          format: string;
          status: string;
          created_by_user_id: string;
          web_slug: string | null;
        }
      | undefined;

    if (!tournament) {
      return NextResponse.json({ error: "Tournament not found" }, { status: 404 });
    }

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
    if (session?.user?.id) {
      const currentPlayer = db
        .prepare("select id from players where guild_id = ? and discord_user_id = ?")
        .get(tournament.guild_id, session.user.id) as { id: number } | undefined;
      isParticipant = currentPlayer
        ? participants.some((p) => p.playerId === currentPlayer.id)
        : false;
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
    });
  } catch (error) {
    console.error("[api/tournaments/id] error:", error);
    return NextResponse.json(
      { error: "Failed to load tournament" },
      { status: 500 }
    );
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { id } = await params;
    const tournamentId = Number(id);
    const db = getDb();

    const tournament = db
      .prepare("select id, created_by_user_id, status from tournaments where id = ?")
      .get(tournamentId) as { id: number; created_by_user_id: string; status: string } | undefined;

    if (!tournament) {
      return NextResponse.json({ error: "Tournament not found" }, { status: 404 });
    }

    if (tournament.created_by_user_id !== session.user.id) {
      return NextResponse.json({ error: "Only the tournament creator can cancel it" }, { status: 403 });
    }

    if (tournament.status === "completed" || tournament.status === "cancelled") {
      return NextResponse.json({ error: `Tournament is already ${tournament.status}` }, { status: 400 });
    }

    db.prepare("update tournaments set status = 'cancelled', ended_at = current_timestamp where id = ?").run(tournamentId);

    return NextResponse.json({ id: tournamentId, status: "cancelled" });
  } catch (error) {
    console.error("[api/tournaments/[id] DELETE] error:", error);
    return NextResponse.json({ error: "Failed to cancel tournament" }, { status: 500 });
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { id } = await params;
    const tournamentId = Number(id);
    const db = getDb();

    const tournament = db
      .prepare("select id, created_by_user_id, status from tournaments where id = ?")
      .get(tournamentId) as { id: number; created_by_user_id: string; status: string } | undefined;

    if (!tournament) {
      return NextResponse.json({ error: "Tournament not found" }, { status: 404 });
    }

    if (tournament.created_by_user_id !== session.user.id) {
      return NextResponse.json({ error: "Only the tournament creator can modify it" }, { status: 403 });
    }

    if (tournament.status !== "pending") {
      return NextResponse.json({ error: "Can only modify pending tournaments" }, { status: 400 });
    }

    const body = await request.json();
    const { name } = body as { name?: string };

    if (name !== undefined) {
      if (!name.trim()) {
        return NextResponse.json({ error: "Name cannot be empty" }, { status: 400 });
      }

      const existing = db
        .prepare(
          "select id from tournaments where guild_id = (select guild_id from tournaments where id = ?) and name = ? and status in ('pending', 'active') and id != ?"
        )
        .get(tournamentId, name) as { id: number } | undefined;

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
    console.error("[api/tournaments/[id] PUT] error:", error);
    return NextResponse.json({ error: "Failed to update tournament" }, { status: 500 });
  }
}

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
    const tournamentId = Number(id);
    const db = getDb();

    const tournament = db
      .prepare("select id, created_by_user_id, status, format from tournaments where id = ?")
      .get(tournamentId) as { id: number; created_by_user_id: string; status: string; format: string } | undefined;

    if (!tournament) {
      return NextResponse.json({ error: "Tournament not found" }, { status: 404 });
    }

    if (tournament.created_by_user_id !== session.user.id) {
      return NextResponse.json({ error: "Only the tournament creator can start it" }, { status: 403 });
    }

    if (tournament.status !== "pending") {
      return NextResponse.json({ error: "Tournament must be pending to start" }, { status: 400 });
    }

    const participantCount = db
      .prepare("select count(*) as count from tournament_participants where tournament_id = ?")
      .get(tournamentId) as { count: number };

    if (participantCount.count < 2) {
      return NextResponse.json({ error: "Tournament requires at least 2 participants to start" }, { status: 400 });
    }

    const playerIds = db
      .prepare("select player_id from tournament_participants where tournament_id = ? order by joined_at asc, rowid asc")
      .all(tournamentId)
      .map((row: any) => row.player_id);

    const insertPairing = db.prepare(
      `insert into tournament_matches (tournament_id, player_one_id, player_two_id, round_number, status, metadata_json) values (?, ?, ?, ?, ?, ?)`
    );

    if (tournament.format === "round_robin") {
      for (const pairing of generateRoundRobin(playerIds)) {
        insertPairing.run(tournamentId, pairing.playerOneId, pairing.playerTwoId, pairing.roundNumber, "open", "{}");
      }
    }

    if (tournament.format === "single_elim") {
      const firstRound = generateSingleElimFirstRound(playerIds);

      for (const byePlayerId of firstRound.byes) {
        insertPairing.run(tournamentId, byePlayerId, null, 1, "completed", JSON.stringify({ bye: true, winnerId: byePlayerId }));
      }

      for (const pairing of firstRound.pairings) {
        insertPairing.run(tournamentId, pairing.playerOneId, pairing.playerTwoId, pairing.roundNumber, "open", "{}");
      }
    }

    db.prepare("update tournaments set status = 'active', started_at = current_timestamp where id = ?").run(tournamentId);

    return NextResponse.json({
      id: tournamentId,
      status: "active",
    });
  } catch (error) {
    console.error("[api/tournaments/[id] POST] error:", error);
    return NextResponse.json({ error: "Failed to start tournament" }, { status: 500 });
  }
}
