import type Database from "better-sqlite3";

export function migrate(db: Database.Database) {
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
      ended_at text,
      unique (guild_id, name)
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
}
