import type Database from "better-sqlite3";

function hasColumn(db: Database.Database, table: string, column: string) {
  return (db.pragma(`table_info(${table})`) as Array<{ name: string }>).some((info) => info.name === column);
}

function addColumnIfMissing(db: Database.Database, table: string, column: string, definition: string) {
  if (!hasColumn(db, table, column)) {
    db.exec(`alter table ${table} add column ${column} ${definition}`);
  }
}

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

    create table if not exists card_catalog (
      ygoprodeck_id integer primary key not null,
      name text not null,
      type text not null,
      frame_type text not null,
      image_url text not null,
      image_url_small text not null,
      card_sets_json text not null,
      cached_at text not null
    );

    create table if not exists drafts (
      id integer primary key autoincrement,
      guild_id text not null,
      channel_id text not null,
      name text not null,
      status text not null,
      created_by_user_id text not null,
      config_json text not null default '{}',
      current_wave_number integer not null default 0,
      current_pick_step integer not null default 0,
      pick_deadline_at text,
      status_message_id text,
      created_at text not null default current_timestamp,
      started_at text,
      ended_at text
    );

    create table if not exists draft_players (
      draft_id integer not null references drafts(id),
      player_id integer not null references players(id),
      pick_count integer not null default 0,
      finished_at text,
      seat_index integer,
      joined_at text not null default current_timestamp,
      primary key (draft_id, player_id)
    );

    create table if not exists draft_packs (
      id integer primary key autoincrement,
      draft_id integer not null references drafts(id),
      pack_round integer not null,
      origin_seat_index integer not null,
      current_holder_seat_index integer not null,
      pass_direction integer not null,
      created_at text not null default current_timestamp,
      unique (draft_id, pack_round, origin_seat_index)
    );

    create table if not exists draft_cards (
      id integer primary key autoincrement,
      draft_id integer not null references drafts(id),
      wave_number integer not null,
      draft_pack_id integer references draft_packs(id),
      catalog_card_id integer not null references card_catalog(ygoprodeck_id),
      position integer,
      picked_by_player_id integer,
      picked_at text,
      created_at text not null default current_timestamp,
      foreign key (draft_id, picked_by_player_id) references draft_players(draft_id, player_id),
      unique (id, draft_id, wave_number)
    );

    create table if not exists draft_picks (
      id integer primary key autoincrement,
      draft_id integer not null references drafts(id),
      player_id integer not null,
      draft_card_id integer not null references draft_cards(id),
      wave_number integer not null,
      pick_step integer not null,
      pick_method text not null default 'manual',
      picked_at text not null,
      foreign key (draft_id, player_id) references draft_players(draft_id, player_id),
      foreign key (draft_card_id, draft_id, wave_number) references draft_cards(id, draft_id, wave_number),
      unique (draft_id, player_id, wave_number, pick_step),
      unique (draft_card_id)
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

  addColumnIfMissing(db, "drafts", "pick_deadline_at", "text");
  addColumnIfMissing(db, "drafts", "status_message_id", "text");
  addColumnIfMissing(db, "draft_players", "seat_index", "integer");
  addColumnIfMissing(db, "draft_cards", "draft_pack_id", "integer references draft_packs(id)");
  addColumnIfMissing(db, "draft_cards", "position", "integer");
  addColumnIfMissing(db, "draft_picks", "pick_method", "text not null default 'manual'");

  db.exec(`
    create unique index if not exists tournaments_current_name_unique
    on tournaments (guild_id, name)
    where status in ('pending', 'active');

    create unique index if not exists drafts_current_name_unique
    on drafts (guild_id, name)
    where status in ('pending', 'active');

    create table if not exists draft_templates (
      id integer primary key autoincrement,
      guild_id text not null,
      name text not null,
      config_json text not null default '{}',
      created_by_user_id text not null,
      created_at text not null default current_timestamp,
      unique (guild_id, name)
    );

    create table if not exists card_sets (
      set_name text primary key not null,
      synced_at text not null
    );

    create index if not exists draft_cards_unpicked_by_draft_wave
    on draft_cards (draft_id, wave_number)
    where picked_by_player_id is null;

    create index if not exists draft_packs_holder_idx
    on draft_packs (draft_id, pack_round, current_holder_seat_index);

    create index if not exists draft_cards_pack_idx
    on draft_cards (draft_pack_id, picked_by_player_id, position);
  `);
}
