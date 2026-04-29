import type Database from "better-sqlite3";

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
    },

    start(tournamentId: number): Tournament {
      const tournament = findById(tournamentId);

      if (tournament.status !== "pending") {
        throw new Error("Tournament has already started");
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
  };
}
