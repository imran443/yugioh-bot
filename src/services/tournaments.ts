import type Database from "better-sqlite3";
import type { Match } from "./matches.js";
import {
  generateRoundRobin,
  generateSingleElimFirstRound,
  type TournamentPairing,
} from "../tournaments/formats.js";

export type TournamentFormat = "round_robin" | "single_elim";
export type TournamentStatus = "pending" | "active" | "cancelled" | "completed";

export type Tournament = {
  id: number;
  guildId: string;
  name: string;
  format: TournamentFormat;
  status: TournamentStatus;
  createdByUserId: string;
};

export type TournamentMatchStatus = "open" | "pending_approval" | "completed";

export type TournamentMatch = {
  id: number;
  tournamentId: number;
  matchId: number | null;
  playerOneId: number;
  playerTwoId: number | null;
  roundNumber: number;
  status: TournamentMatchStatus;
  metadata: Record<string, unknown>;
};

function mapTournament(row: any): Tournament {
  return {
    id: row.id,
    guildId: row.guild_id,
    name: row.name,
    format: row.format,
    status: row.status,
    createdByUserId: row.created_by_user_id,
  };
}

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

function mapTournamentMatch(row: any): TournamentMatch {
  return {
    id: row.id,
    tournamentId: row.tournament_id,
    matchId: row.match_id,
    playerOneId: row.player_one_id,
    playerTwoId: row.player_two_id,
    roundNumber: row.round_number,
    status: row.status,
    metadata: JSON.parse(row.metadata_json),
  };
}

function assertFormat(format: string): asserts format is TournamentFormat {
  if (format !== "round_robin" && format !== "single_elim") {
    throw new Error("Unsupported tournament format");
  }
}

export function createTournamentService(db: Database.Database) {
  const findById = (tournamentId: number): Tournament => {
    const row = db.prepare("select * from tournaments where id = ?").get(tournamentId);

    if (!row) {
      throw new Error("Tournament not found");
    }

    return mapTournament(row);
  };

  const insertTournamentPairing = (
    tournamentId: number,
    pairing: TournamentPairing,
    status: TournamentMatchStatus = "open",
    metadata: Record<string, unknown> = {},
  ) => {
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
      values (?, ?, ?, ?, ?, ?)
    `,
    ).run(
      tournamentId,
      pairing.playerOneId,
      pairing.playerTwoId,
      pairing.roundNumber,
      status,
      JSON.stringify(metadata),
    );
  };

  const participantsFor = (tournamentId: number): number[] => {
    return db
      .prepare(
        `
        select player_id from tournament_participants
        where tournament_id = ?
        order by joined_at asc, player_id asc
      `,
      )
      .all(tournamentId)
      .map((row: any) => row.player_id);
  };

  return {
    create(
      guildId: string,
      name: string,
      format: TournamentFormat,
      createdByUserId: string,
    ): Tournament {
      assertFormat(format);

      const result = db
        .prepare(
          `
          insert into tournaments (guild_id, name, format, status, created_by_user_id)
          values (?, ?, ?, 'pending', ?)
        `,
        )
        .run(guildId, name, format, createdByUserId);

      return findById(Number(result.lastInsertRowid));
    },

    findById,

    findByName(guildId: string, name: string): Tournament | undefined {
      const row = db
        .prepare("select * from tournaments where guild_id = ? and name = ?")
        .get(guildId, name);

      return row ? mapTournament(row) : undefined;
    },

    join(tournamentId: number, playerId: number): void {
      const tournament = findById(tournamentId);

      if (tournament.status !== "pending") {
        throw new Error("Tournament has already started");
      }

      db.prepare(
        `
        insert or ignore into tournament_participants (tournament_id, player_id)
        values (?, ?)
      `,
      ).run(tournamentId, playerId);
    },

    participants(tournamentId: number): number[] {
      return participantsFor(tournamentId);
    },

    start(tournamentId: number): Tournament {
      const tournament = findById(tournamentId);
      const playerIds = participantsFor(tournamentId);

      if (tournament.status !== "pending") {
        throw new Error("Tournament has already started");
      }

      if (playerIds.length < 2) {
        throw new Error("Tournament needs at least two players");
      }

      if (tournament.format === "round_robin") {
        for (const pairing of generateRoundRobin(playerIds)) {
          insertTournamentPairing(tournamentId, pairing);
        }
      }

      if (tournament.format === "single_elim") {
        const firstRound = generateSingleElimFirstRound(playerIds);

        for (const byePlayerId of firstRound.byes) {
          insertTournamentPairing(
            tournamentId,
            { playerOneId: byePlayerId, playerTwoId: null, roundNumber: 1 },
            "completed",
            { bye: true, winnerId: byePlayerId },
          );
        }

        for (const pairing of firstRound.pairings) {
          insertTournamentPairing(tournamentId, pairing);
        }
      }

      db.prepare(
        `
        update tournaments
        set status = 'active', started_at = current_timestamp
        where id = ?
      `,
      ).run(tournamentId);

      return findById(tournamentId);
    },

    matches(tournamentId: number): TournamentMatch[] {
      return db
        .prepare(
          `
          select * from tournament_matches
          where tournament_id = ?
          order by round_number asc, id asc
        `,
        )
        .all(tournamentId)
        .map(mapTournamentMatch);
    },

    openMatches(tournamentId: number): TournamentMatch[] {
      return db
        .prepare(
          `
          select * from tournament_matches
          where tournament_id = ?
            and status in ('open', 'pending_approval')
          order by round_number asc, id asc
        `,
        )
        .all(tournamentId)
        .map(mapTournamentMatch);
    },

    report(tournamentId: number, reporterId: number, opponentId: number, winnerId: number): Match {
      const tournament = findById(tournamentId);

      if (tournament.status !== "active") {
        throw new Error("Tournament is not active");
      }

      if (winnerId !== reporterId && winnerId !== opponentId) {
        throw new Error("Winner must be one of the match players");
      }

      const tournamentMatch = db
        .prepare(
          `
          select * from tournament_matches
          where tournament_id = ?
            and status = 'open'
            and (
              (player_one_id = ? and player_two_id = ?)
              or (player_one_id = ? and player_two_id = ?)
            )
          order by round_number asc, id asc
          limit 1
        `,
        )
        .get(tournamentId, reporterId, opponentId, opponentId, reporterId);

      if (!tournamentMatch) {
        throw new Error("Open tournament match not found");
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
          values (?, ?, ?, ?, ?, 'pending', 'tournament', ?)
        `,
        )
        .run(tournament.guildId, reporterId, opponentId, winnerId, reporterId, tournamentId);

      const matchId = Number(result.lastInsertRowid);

      db.prepare(
        `
        update tournament_matches
        set match_id = ?, status = 'pending_approval'
        where id = ?
      `,
      ).run(matchId, (tournamentMatch as any).id);

      return mapMatch(db.prepare("select * from matches where id = ?").get(matchId));
    },
  };
}
