import type Database from "better-sqlite3";

export function migrate(db: Database.Database) {
  db.exec("drop table if exists tournaments_without_name_unique");

  db.exec(`
    create table if not exists players (
      id integer primary key autoincrement,
      guild_id text not null,
      discord_user_id text not null,
      display_name text not null,
      created_at text not null default current_timestamp,
      unique (guild_id, discord_user_id)
    );

    create table if not exists tournaments (
      id integer primary key autoincrement,
      guild_id text not null,
      name text not null,
      format text not null,
      status text not null,
      created_by_user_id text not null,
      created_at text not null default current_timestamp,
      started_at text,
      ended_at text
    );

    create table if not exists tournament_participants (
      tournament_id integer not null references tournaments(id),
      player_id integer not null references players(id),
      joined_at text not null default current_timestamp,
      primary key (tournament_id, player_id)
    );

    create table if not exists matches (
      id integer primary key autoincrement,
      guild_id text not null,
      player_one_id integer not null references players(id),
      player_two_id integer not null references players(id),
      winner_id integer references players(id),
      reporter_id integer not null references players(id),
      approver_id integer references players(id),
      status text not null,
      source text not null,
      tournament_id integer references tournaments(id),
      created_at text not null default current_timestamp,
      resolved_at text
    );

    create table if not exists tournament_matches (
      id integer primary key autoincrement,
      tournament_id integer not null references tournaments(id),
      match_id integer references matches(id),
      player_one_id integer not null references players(id),
      player_two_id integer references players(id),
      round_number integer not null,
      status text not null,
      metadata_json text not null default '{}'
    );
  `);

  const tournamentSchema = db
    .prepare("select sql from sqlite_master where type = 'table' and name = 'tournaments'")
    .get() as { sql: string } | undefined;

  if (tournamentSchema?.sql.includes("unique (guild_id, name)")) {
    const foreignKeys = db.pragma("foreign_keys", { simple: true }) as number;

    try {
      db.pragma("foreign_keys = off");
      db.exec(`
        begin;

        create table tournaments_without_name_unique (
          id integer primary key autoincrement,
          guild_id text not null,
          name text not null,
          format text not null,
          status text not null,
          created_by_user_id text not null,
          created_at text not null default current_timestamp,
          started_at text,
          ended_at text
        );

        insert into tournaments_without_name_unique (
          id,
          guild_id,
          name,
          format,
          status,
          created_by_user_id,
          created_at,
          started_at,
          ended_at
        )
        select
          id,
          guild_id,
          name,
          format,
          status,
          created_by_user_id,
          created_at,
          started_at,
          ended_at
        from tournaments;

        drop table tournaments;
        alter table tournaments_without_name_unique rename to tournaments;

        commit;
      `);
    } catch (error) {
      db.exec("rollback;");
      throw error;
    } finally {
      db.pragma(`foreign_keys = ${foreignKeys ? "on" : "off"}`);
    }
  }

  db.exec(`
    create unique index if not exists tournaments_current_name_unique
    on tournaments (guild_id, name)
    where status in ('pending', 'active');
  `);
}
