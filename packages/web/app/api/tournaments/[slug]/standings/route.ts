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
      .get(tournamentId) as { id: number } | undefined;

    if (!tournament) {
      return NextResponse.json({ error: "Tournament not found" }, { status: 404 });
    }

    // Get all participants
    const participants = db
      .prepare(
        `
        select p.id as player_id, p.display_name
        from tournament_participants tp
        inner join players p on p.id = tp.player_id
        where tp.tournament_id = ?
        order by tp.joined_at asc
      `
      )
      .all(tournamentId)
      .map((row: any) => ({ playerId: row.player_id, displayName: row.display_name }));

    // Count wins per player from completed tournament matches
    const wins = db
      .prepare(
        `
        select m.winner_id, count(*) as win_count
        from tournament_matches tm
        inner join matches m on m.id = tm.match_id
        where tm.tournament_id = ? and tm.status = 'completed' and m.winner_id is not null
        group by m.winner_id
      `
      )
      .all(tournamentId)
      .reduce((acc: Record<number, number>, row: any) => {
        acc[row.winner_id] = row.win_count;
        return acc;
      }, {});

    // Count losses per player (player was in match but not winner)
    const losses = db
      .prepare(
        `
        select
          case
            when m.player_one_id = m.winner_id then m.player_two_id
            else m.player_one_id
          end as loser_id,
          count(*) as loss_count
        from tournament_matches tm
        inner join matches m on m.id = tm.match_id
        where tm.tournament_id = ? and tm.status = 'completed' and m.winner_id is not null
        group by loser_id
      `
      )
      .all(tournamentId)
      .reduce((acc: Record<number, number>, row: any) => {
        acc[row.loser_id] = row.loss_count;
        return acc;
      }, {});

    const standings = participants.map((p) => ({
      ...p,
      wins: wins[p.playerId] ?? 0,
      losses: losses[p.playerId] ?? 0,
    }));

    // Sort by wins desc, then losses asc
    standings.sort((a, b) => {
      if (b.wins !== a.wins) return b.wins - a.wins;
      return a.losses - b.losses;
    });

    return NextResponse.json(standings);
  } catch (error) {
    console.error("[api/tournaments/id/standings] error:", error);
    return NextResponse.json(
      { error: "Failed to load standings" },
      { status: 500 }
    );
  }
}
