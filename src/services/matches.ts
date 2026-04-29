import type Database from "better-sqlite3";
import { generateSingleElimFirstRound } from "../tournaments/formats.js";

export type MatchSource = "casual" | "tournament";
export type MatchStatus = "pending" | "approved" | "denied";

export type Match = {
  id: number;
  guildId: string;
  playerOneId: number;
  playerTwoId: number;
  winnerId: number | null;
  reporterId: number;
  approverId: number | null;
  status: MatchStatus;
  source: MatchSource;
  tournamentId: number | null;
};

export type MatchStats = {
  wins: number;
  losses: number;
};

export type LeaderboardRow = MatchStats & {
  playerId: number;
  displayName: string;
};

type ReportMatchInput = {
  guildId: string;
  reporterId: number;
  opponentId: number;
  winnerId: number;
  source: MatchSource;
  tournamentId?: number;
};

function mapMatch(row: any): Match {
  return {
    id: row.id,
    guildId: row.guild_id,
    playerOneId: row.player_one_id,
    playerTwoId: row.player_two_id,
    winnerId: row.winner_id,
    reporterId: row.reporter_id,
    approverId: row.approver_id,
    status: row.status,
    source: row.source,
    tournamentId: row.tournament_id,
  };
}

export function createMatchService(db: Database.Database) {
  const findById = (matchId: number): Match => {
    const row = db.prepare("select * from matches where id = ?").get(matchId);

    if (!row) {
      throw new Error("Match not found");
    }

    return mapMatch(row);
  };

  const ensureOpponentCanResolve = (match: Match, playerId: number) => {
    const opponentId =
      match.reporterId === match.playerOneId ? match.playerTwoId : match.playerOneId;

    if (match.status !== "pending") {
      throw new Error("Match is not pending");
    }

    if (playerId !== opponentId) {
      throw new Error("Only the opponent can approve this match");
    }
  };

  const completeTournamentMatch = (match: Match) => {
    if (match.tournamentId === null || match.winnerId === null) {
      return;
    }

    const tournamentMatch = db
      .prepare("select * from tournament_matches where match_id = ?")
      .get(match.id) as any;

    if (!tournamentMatch) {
      return;
    }

    db.prepare("update tournament_matches set status = 'completed' where id = ?").run(
      tournamentMatch.id,
    );

    const tournament = db
      .prepare("select * from tournaments where id = ?")
      .get(match.tournamentId) as any;

    if (!tournament || tournament.format !== "single_elim") {
      return;
    }

    const incomplete = db
      .prepare(
        `
        select count(*) as count
        from tournament_matches
        where tournament_id = ?
          and round_number = ?
          and status != 'completed'
      `,
      )
      .get(match.tournamentId, tournamentMatch.round_number) as { count: number };

    if (incomplete.count > 0) {
      return;
    }

    const nextRoundNumber = tournamentMatch.round_number + 1;
    const nextRound = db
      .prepare(
        `
        select count(*) as count
        from tournament_matches
        where tournament_id = ? and round_number = ?
      `,
      )
      .get(match.tournamentId, nextRoundNumber) as { count: number };

    if (nextRound.count > 0) {
      return;
    }

    const winners = db
      .prepare(
        `
        select tm.metadata_json, m.winner_id
        from tournament_matches tm
        left join matches m on m.id = tm.match_id
        where tm.tournament_id = ? and tm.round_number = ?
        order by tm.id asc
      `,
      )
      .all(match.tournamentId, tournamentMatch.round_number)
      .map((row: any) => row.winner_id ?? JSON.parse(row.metadata_json).winnerId)
      .filter((winnerId: unknown): winnerId is number => typeof winnerId === "number");

    if (winners.length <= 1) {
      db.prepare(
        "update tournaments set status = 'completed', ended_at = current_timestamp where id = ?",
      ).run(match.tournamentId);
      return;
    }

    const generatedRound = generateSingleElimFirstRound(winners);

    for (const byePlayerId of generatedRound.byes) {
      db.prepare(
        `
        insert into tournament_matches (
          tournament_id,
          player_one_id,
          player_two_id,
          round_number,
          status,
          metadata_json
        )
        values (?, ?, null, ?, 'completed', ?)
      `,
      ).run(
        match.tournamentId,
        byePlayerId,
        nextRoundNumber,
        JSON.stringify({ bye: true, winnerId: byePlayerId }),
      );
    }

    for (const pairing of generatedRound.pairings) {
      db.prepare(
        `
        insert into tournament_matches (
          tournament_id,
          player_one_id,
          player_two_id,
          round_number,
          status,
          metadata_json
        )
        values (?, ?, ?, ?, 'open', '{}')
      `,
      ).run(match.tournamentId, pairing.playerOneId, pairing.playerTwoId, nextRoundNumber);
    }
  };

  return {
    report(input: ReportMatchInput): Match {
      if (input.reporterId === input.opponentId) {
        throw new Error("Players cannot report matches against themselves");
      }

      if (input.winnerId !== input.reporterId && input.winnerId !== input.opponentId) {
        throw new Error("Winner must be one of the match players");
      }

      const result = db
        .prepare(
          `
          insert into matches (
            guild_id,
            player_one_id,
            player_two_id,
            winner_id,
            reporter_id,
            status,
            source,
            tournament_id
          )
          values (?, ?, ?, ?, ?, 'pending', ?, ?)
        `,
        )
        .run(
          input.guildId,
          input.reporterId,
          input.opponentId,
          input.winnerId,
          input.reporterId,
          input.source,
          input.tournamentId ?? null,
        );

      return findById(Number(result.lastInsertRowid));
    },

    approve(matchId: number, approverId: number): Match {
      const match = findById(matchId);
      ensureOpponentCanResolve(match, approverId);

      db.prepare(
        `
        update matches
        set status = 'approved', approver_id = ?, resolved_at = current_timestamp
        where id = ?
      `,
      ).run(approverId, matchId);

      const approvedMatch = findById(matchId);
      completeTournamentMatch(approvedMatch);

      return findById(matchId);
    },

    deny(matchId: number, denierId: number): Match {
      const match = findById(matchId);
      ensureOpponentCanResolve(match, denierId);

      db.prepare(
        `
        update matches
        set status = 'denied', approver_id = ?, resolved_at = current_timestamp
        where id = ?
      `,
      ).run(denierId, matchId);

      if (match.tournamentId !== null) {
        db.prepare(
          `
          update tournament_matches
          set status = 'open', match_id = null
          where match_id = ?
        `,
        ).run(matchId);
      }

      return findById(matchId);
    },

    stats(playerId: number): MatchStats {
      const wins = db
        .prepare(
          "select count(*) as count from matches where status = 'approved' and winner_id = ?",
        )
        .get(playerId) as { count: number };
      const losses = db
        .prepare(
          `
          select count(*) as count
          from matches
          where status = 'approved'
            and winner_id != ?
            and (player_one_id = ? or player_two_id = ?)
        `,
        )
        .get(playerId, playerId, playerId) as { count: number };

      return { wins: wins.count, losses: losses.count };
    },

    latestPendingForPlayer(playerId: number): Match | undefined {
      const row = db
        .prepare(
          `
          select * from matches
          where status = 'pending'
            and (player_one_id = ? or player_two_id = ?)
          order by id desc
          limit 1
        `,
        )
        .get(playerId, playerId);

      return row ? mapMatch(row) : undefined;
    },

    leaderboard(guildId: string): LeaderboardRow[] {
      return db
        .prepare(
          `
          select
            p.id as player_id,
            p.display_name,
            coalesce(
              sum(case when m.status = 'approved' and m.winner_id = p.id then 1 else 0 end),
              0
            ) as wins,
            coalesce(sum(case
              when m.status = 'approved'
                and m.winner_id != p.id
                and (m.player_one_id = p.id or m.player_two_id = p.id)
              then 1 else 0 end), 0) as losses
          from players p
          left join matches m
            on m.guild_id = p.guild_id
            and (m.player_one_id = p.id or m.player_two_id = p.id)
          where p.guild_id = ?
          group by p.id
          order by wins desc, losses asc, p.display_name asc
        `,
        )
        .all(guildId)
        .map((row: any) => ({
          playerId: row.player_id,
          displayName: row.display_name,
          wins: row.wins,
          losses: row.losses,
        }));
    },
  };
}

export type MatchService = ReturnType<typeof createMatchService>;
