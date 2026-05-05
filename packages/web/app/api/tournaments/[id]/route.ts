import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";

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
    });
  } catch (error) {
    console.error("[api/tournaments/id] error:", error);
    return NextResponse.json(
      { error: "Failed to load tournament" },
      { status: 500 }
    );
  }
}
