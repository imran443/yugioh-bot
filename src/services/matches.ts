import type Database from "better-sqlite3";

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
    const opponentId = match.reporterId === match.playerOneId ? match.playerTwoId : match.playerOneId;

    if (match.status !== "pending") {
      throw new Error("Match is not pending");
    }

    if (playerId !== opponentId) {
      throw new Error("Only the opponent can approve this match");
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

      return findById(matchId);
    },

    stats(playerId: number): MatchStats {
      const wins = db
        .prepare("select count(*) as count from matches where status = 'approved' and winner_id = ?")
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
  };
}
