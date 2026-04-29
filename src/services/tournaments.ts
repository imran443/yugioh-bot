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

export type TournamentParticipant = {
  playerId: number;
  displayName: string;
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

type AutocompleteInput = {
  guildId: string;
  query: string;
  statuses?: TournamentStatus[];
  createdByUserId?: string;
  participantPlayerId?: number;
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

      const existingCurrent = db
        .prepare(
          `
          select id from tournaments
          where guild_id = ?
            and name = ?
            and status in ('pending', 'active')
          limit 1
        `,
        )
        .get(guildId, name);

      if (existingCurrent) {
        throw new Error("An active or pending tournament already uses that name");
      }

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
        .prepare(
          `
          select * from tournaments
          where guild_id = ? and name = ?
          order by
            case status when 'active' then 0 when 'pending' then 1 else 2 end,
            id desc
          limit 1
        `,
        )
        .get(guildId, name);

      return row ? mapTournament(row) : undefined;
    },

    listByStatus(guildId: string, statuses: TournamentStatus[]): Tournament[] {
      if (statuses.length === 0) {
        return [];
      }

      return db
        .prepare(
          `
          select * from tournaments
          where guild_id = ?
            and status in (${statuses.map(() => "?").join(", ")})
          order by created_at asc, id asc
        `,
        )
        .all(guildId, ...statuses)
        .map(mapTournament);
    },

    activeForPlayer(guildId: string, playerId: number): Tournament[] {
      return db
        .prepare(
          `
          select t.* from tournaments t
          inner join tournament_participants tp on tp.tournament_id = t.id
          where t.guild_id = ?
            and t.status = 'active'
            and tp.player_id = ?
          order by t.created_at asc, t.id asc
        `,
        )
        .all(guildId, playerId)
        .map(mapTournament);
    },

    autocomplete(input: AutocompleteInput): Tournament[] {
      const conditions = ["t.guild_id = ?", "lower(t.name) like lower(?)"];
      const params: Array<string | number> = [input.guildId, `%${input.query}%`];

      if (input.statuses && input.statuses.length > 0) {
        conditions.push(`t.status in (${input.statuses.map(() => "?").join(", ")})`);
        params.push(...input.statuses);
      }

      if (input.createdByUserId) {
        conditions.push("t.created_by_user_id = ?");
        params.push(input.createdByUserId);
      }

      if (input.participantPlayerId !== undefined) {
        conditions.push(
          `exists (
            select 1 from tournament_participants tp
            where tp.tournament_id = t.id and tp.player_id = ?
          )`,
        );
        params.push(input.participantPlayerId);
      }

      return db
        .prepare(
          `
          select t.* from tournaments t
          where ${conditions.join(" and ")}
          order by t.created_at asc, t.id asc
          limit 25
        `,
        )
        .all(...params)
        .map(mapTournament);
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

    participantRecords(tournamentId: number): TournamentParticipant[] {
      return db
        .prepare(
          `
          select p.id as player_id, p.display_name
          from tournament_participants tp
          inner join players p on p.id = tp.player_id
          where tp.tournament_id = ?
          order by tp.joined_at asc, tp.rowid asc
        `,
        )
        .all(tournamentId)
        .map((row: any) => ({ playerId: row.player_id, displayName: row.display_name }));
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

    stats(tournamentId: number, playerId: number): { wins: number; losses: number } {
      const wins = db
        .prepare(
          `
          select count(*) as count
          from matches
          where tournament_id = ?
            and status = 'approved'
            and winner_id = ?
        `,
        )
        .get(tournamentId, playerId) as { count: number };
      const losses = db
        .prepare(
          `
          select count(*) as count
          from matches
          where tournament_id = ?
            and status = 'approved'
            and winner_id != ?
            and (player_one_id = ? or player_two_id = ?)
        `,
        )
        .get(tournamentId, playerId, playerId, playerId) as { count: number };

      return { wins: wins.count, losses: losses.count };
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

    cancel(tournamentId: number): Tournament {
      findById(tournamentId);

      db.prepare(
        "update tournaments set status = 'cancelled', ended_at = current_timestamp where id = ?",
      ).run(tournamentId);

      return findById(tournamentId);
    },
  };
}

export type TournamentService = ReturnType<typeof createTournamentService>;
