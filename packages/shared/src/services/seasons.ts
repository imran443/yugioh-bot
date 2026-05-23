import type Database from "better-sqlite3";

export type Season = {
  id: number;
  guildId: string;
  number: number;
  name: string | null;
  status: "active" | "ended";
  startedAt: string;
  endedAt: string | null;
};

function mapSeason(row: any): Season {
  return {
    id: row.id,
    guildId: row.guild_id,
    number: row.number,
    name: row.name,
    status: row.status,
    startedAt: row.started_at,
    endedAt: row.ended_at,
  };
}

export function createSeasonService(db: Database.Database) {
  const getActive = (guildId: string): Season | undefined => {
    const row = db
      .prepare("select * from seasons where guild_id = ? and status = 'active'")
      .get(guildId);
    return row ? mapSeason(row) : undefined;
  };

  const nextNumber = (guildId: string): number => {
    const row = db
      .prepare("select coalesce(max(number), 0) as n from seasons where guild_id = ?")
      .get(guildId) as { n: number };
    return row.n + 1;
  };

  const start = (guildId: string, userId?: string, name?: string): Season => {
    if (getActive(guildId)) {
      throw new Error("A season is already active");
    }
    const number = nextNumber(guildId);
    const result = db
      .prepare(
        `insert into seasons (guild_id, number, name, status, created_by_user_id)
         values (?, ?, ?, 'active', ?)`,
      )
      .run(guildId, number, name ?? null, userId ?? null);
    return mapSeason(
      db.prepare("select * from seasons where id = ?").get(Number(result.lastInsertRowid)),
    );
  };

  return {
    getActive,
    ensureActive(guildId: string, userId?: string): Season {
      return getActive(guildId) ?? start(guildId, userId);
    },
    start,
    end(guildId: string, _userId?: string): Season | undefined {
      const active = getActive(guildId);
      if (!active) return undefined;
      db.prepare(
        "update seasons set status = 'ended', ended_at = current_timestamp where id = ?",
      ).run(active.id);
      return mapSeason(db.prepare("select * from seasons where id = ?").get(active.id));
    },
  };
}

export type SeasonService = ReturnType<typeof createSeasonService>;
