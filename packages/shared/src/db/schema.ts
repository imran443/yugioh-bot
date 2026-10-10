import type Database from "better-sqlite3";
import { backfillMainArtworkRows } from "../services/card-artworks.js";
import { generateWebSlug } from "../util/web-slug.js";
import { isExtraDeckFrame } from "../services/card-catalog.js";

function hasColumn(db: Database.Database, table: string, column: string) {
  return (db.pragma(`table_info(${table})`) as Array<{ name: string }>).some((info) => info.name === column);
}

function addColumnIfMissing(db: Database.Database, table: string, column: string, definition: string) {
  db.transaction(() => {
    if (!hasColumn(db, table, column)) {
      db.exec(`alter table ${table} add column ${column} ${definition}`);
    }
  }).immediate();
}

const rebuildLegacyTournamentSql = `

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

      `;

const IDENTITY_TABLE_SQL = `
create table if not exists users (
  id integer primary key autoincrement,
  clerk_user_id text unique,
  email text check (email is null or email = lower(trim(email))),
  email_verified integer not null default 0 check (email_verified in (0, 1)),
  username text not null,
  display_name text not null,
  discord_user_id text unique,
  created_at text not null default current_timestamp,
  updated_at text not null default current_timestamp,
  synced_at text,
  check (email_verified = 0 or email is not null)
);
create index if not exists users_email_idx on users(email) where email is not null;

create table players_identity_new (
  id integer primary key autoincrement,
  guild_id text not null,
  user_id integer not null references users(id),
  discord_user_id text,
  display_name text not null,
  created_at text not null default current_timestamp,
  unique (guild_id, user_id),
  unique (guild_id, discord_user_id)
);
create table tournaments_identity_new (
  id integer primary key autoincrement,
  guild_id text not null, name text not null, format text not null, status text not null,
  created_by_user_id integer not null references users(id),
  created_at text not null default current_timestamp, started_at text, ended_at text,
  web_slug text, completed_announced_at text, deadline_at text,
  report_confirm_window_hours integer, best_of integer not null default 3, duel_rules_json text
);
create table cubes_identity_new (
  id integer primary key autoincrement,
  guild_id text not null, name text not null, archetype text, banlist text,
  config_json text not null default '{}',
  created_by_user_id integer not null references users(id),
  created_at text not null default current_timestamp,
  updated_at text not null default current_timestamp,
  unique (guild_id, name)
);
create table drafts_identity_new (
  id integer primary key autoincrement,
  guild_id text not null, channel_id text, name text not null, status text not null,
  created_by_user_id integer not null references users(id),
  config_json text not null default '{}',
  current_wave_number integer not null default 0, current_pick_step integer not null default 0,
  pick_deadline_at text, status_message_id text,
  created_at text not null default current_timestamp, started_at text, ended_at text,
  web_slug text, tournament_id integer references tournaments(id), complete_message_id text,
  lobby_revision integer not null default 0, lobby_auto_start integer not null default 0,
  lobby_auto_held integer not null default 0, lobby_start_at text, lobby_start_kind text,
  lobby_start_token text, lobby_start_revision integer, lobby_start_setup_hash text,
  lobby_start_force integer not null default 0, lobby_start_error text, lobby_nudged_at text
);
create table seasons_identity_new (
  id integer primary key autoincrement,
  guild_id text not null, number integer not null, name text, status text not null,
  started_at text not null default current_timestamp, ended_at text,
  created_by_user_id integer references users(id)
);
create table saved_decks_identity_new (
  id integer primary key autoincrement,
  guild_id text not null,
  owner_user_id integer not null references users(id),
  name text not null, mode text not null, deck_json text not null,
  created_at text not null default current_timestamp,
  updated_at text not null default current_timestamp,
  draft_id integer references drafts(id) on delete set null
);
`;

const IDENTITY_COPY_SQL = `
insert into players_identity_new
  select id, guild_id, (select user_id from identity_key_map where legacy_key = p.discord_user_id),
    discord_user_id, display_name, created_at from players p;
insert into tournaments_identity_new
  select id, guild_id, name, format, status,
    (select user_id from identity_key_map where legacy_key = t.created_by_user_id),
    created_at, started_at, ended_at, web_slug, completed_announced_at, deadline_at,
    report_confirm_window_hours, best_of, duel_rules_json from tournaments t;
insert into cubes_identity_new
  select id, guild_id, name, archetype, banlist, config_json,
    (select user_id from identity_key_map where legacy_key = c.created_by_user_id),
    created_at, updated_at from cubes c;
insert into drafts_identity_new
  select id, guild_id, channel_id, name, status,
    (select user_id from identity_key_map where legacy_key = d.created_by_user_id),
    config_json, current_wave_number, current_pick_step, pick_deadline_at, status_message_id,
    created_at, started_at, ended_at, web_slug, tournament_id, complete_message_id,
    lobby_revision, lobby_auto_start, lobby_auto_held, lobby_start_at, lobby_start_kind,
    lobby_start_token, lobby_start_revision, lobby_start_setup_hash, lobby_start_force,
    lobby_start_error, lobby_nudged_at from drafts d;
insert into seasons_identity_new
  select id, guild_id, number, name, status, started_at, ended_at,
    (select user_id from identity_key_map where legacy_key = s.created_by_user_id) from seasons s;
insert into saved_decks_identity_new
  select id, guild_id, (select user_id from identity_key_map where legacy_key = s.owner_user_id),
    name, mode, deck_json, created_at, updated_at, draft_id from saved_decks s;
`;

const IDENTITY_INDEX_SQL = `
create index if not exists players_user_idx on players(user_id);
create unique index if not exists tournaments_web_slug_unique
  on tournaments(web_slug) where web_slug is not null;
create index if not exists tournaments_creator_idx on tournaments(created_by_user_id);
create index if not exists cubes_creator_idx on cubes(created_by_user_id);
create index if not exists drafts_creator_idx on drafts(created_by_user_id);
create unique index if not exists seasons_one_active on seasons(guild_id) where status = 'active';
create index if not exists seasons_creator_idx on seasons(created_by_user_id);
create index if not exists saved_decks_owner_list_idx on saved_decks(guild_id, owner_user_id, updated_at);
create unique index if not exists saved_decks_owner_draft_idx
  on saved_decks(guild_id, owner_user_id, draft_id) where draft_id is not null;
`;

const identityTables = ["players", "tournaments", "cubes", "drafts", "seasons", "saved_decks"] as const;
const ownerColumns = { tournaments: "created_by_user_id", cubes: "created_by_user_id", drafts: "created_by_user_id", seasons: "created_by_user_id", saved_decks: "owner_user_id" } as const;
type Column = { name: string; type: string; notnull: number };
function tableExists(db: Database.Database, name: string): boolean {
  return Boolean(db.prepare("select 1 from sqlite_master where type='table' and name=?").get(name));
}
function assertS1Empty(db: Database.Database): void {
  for (const name of ["alpha_invites", "access_events", "app_users"]) {
    if (tableExists(db, name) && (db.prepare(`select count(*) as n from ${name}`).get() as { n: number }).n !== 0) {
      throw new Error(`S1 table ${name} is not empty; reconcile a backup before migration`);
    }
  }
}
function identityShape(db: Database.Database): "old" | "new" {
  const playerCols = db.pragma("table_info(players)") as Column[];
  const userCol = playerCols.find(c => c.name === "user_id");
  const owners = Object.entries(ownerColumns).map(([table, name]) =>
    (db.pragma(`table_info(${table})`) as Column[]).find(c => c.name === name));
  const replacements = identityTables.filter(table => tableExists(db, `${table}_identity_new`));
  if (replacements.length) throw new Error(`Partial identity schema: stranded replacement tables ${replacements.join(", ")}`);
  const marked = Boolean(userCol) || tableExists(db, "users")
    || owners.some(c => c?.type.toUpperCase() === "INTEGER");
  if (!marked) return "old";
  const complete = userCol?.type.toUpperCase() === "INTEGER" && userCol.notnull === 1
    && owners.every(c => c?.type.toUpperCase() === "INTEGER") && tableExists(db, "users");
  if (!complete) throw new Error("Partial identity schema; reconcile before startup");
  for (const table of identityTables) {
    const column = table === "players" ? "user_id" : ownerColumns[table];
    const fks = db.pragma(`foreign_key_list(${table})`) as Array<{ table: string; from: string; to: string }>;
    if (!fks.some(fk => fk.table === "users" && fk.from === column && fk.to === "id")) {
      throw new Error(`Partial identity schema: ${table}.${column} has no users FK`);
    }
  }
  return "new";
}
function legacyKind(key: string): "discord" | "local" {
  if (/^[0-9]{1,25}$/.test(key)) return "discord";
  if (/^bot_player_dev_[1-9][0-9]*$/.test(key) || /^tournament_bot_dev_[1-3]$/.test(key)
    || new Set(["fake_yugi", "fake_kaiba", "fake_joey", "fake_pegasus", "seed", "system"]).has(key)) return "local";
  throw new Error(`Unknown synthetic identity format: ${key}; reconcile before migration`);
}
function importedUsername(name: string, id: number): string {
  const stem = name.trim().toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
  return stem ? `${stem}_${id}` : `duelist_${id}`;
}
function assertIdentitySourceShape(db: Database.Database): void {
  const expected: Record<string, string[]> = {
    players: ["id","guild_id","discord_user_id","display_name","created_at"],
    tournaments: ["id","guild_id","name","format","status","created_by_user_id","created_at","started_at","ended_at","web_slug","completed_announced_at","deadline_at","report_confirm_window_hours","best_of","duel_rules_json"],
    cubes: ["id","guild_id","name","archetype","banlist","config_json","created_by_user_id","created_at","updated_at"],
    drafts: ["id","guild_id","channel_id","name","status","created_by_user_id","config_json","current_wave_number","current_pick_step","pick_deadline_at","status_message_id","created_at","started_at","ended_at","web_slug","tournament_id","complete_message_id","lobby_revision","lobby_auto_start","lobby_auto_held","lobby_start_at","lobby_start_kind","lobby_start_token","lobby_start_revision","lobby_start_setup_hash","lobby_start_force","lobby_start_error","lobby_nudged_at"],
    seasons: ["id","guild_id","number","name","status","started_at","ended_at","created_by_user_id"],
    saved_decks: ["id","guild_id","owner_user_id","name","mode","deck_json","created_at","updated_at","draft_id"],
  };
  const indexes = new Set([
    "tournaments_current_name_unique", "tournaments_web_slug_unique", "drafts_current_name_unique",
    "tournaments_current_host_name_unique", "drafts_current_host_name_unique",
    "seasons_one_active", "saved_decks_owner_list_idx", "saved_decks_owner_draft_idx",
    "drafts_web_slug_unique", "drafts_web_slug_idx", "draft_players_player_idx",
    "tournament_participants_player_idx", "drafts_guild_status_created_idx",
    "tournaments_guild_status_created_idx", "players_user_idx",
  ]);
  for (const table of identityTables) {
    const columns = (db.pragma(`table_info(${table})`) as Column[]).map(c => c.name).sort();
    if (JSON.stringify(columns) !== JSON.stringify([...expected[table]].sort())) {
      const unexpected = columns.filter(column => !expected[table].includes(column));
      const missing = expected[table].filter(column => !columns.includes(column));
      throw new Error(`Unexpected columns on ${table} (${unexpected.join(", ")}); missing (${missing.join(", ")}); preserve explicitly before rebuild`);
    }
    const objects = db.prepare("select name,type,sql from sqlite_master where tbl_name=? and type in ('index','trigger') and sql is not null").all(table) as Array<{ name: string; type: string; sql: string }>;
    for (const object of objects) if (object.type === "trigger" || !indexes.has(object.name)) {
      throw new Error(`Unexpected ${object.type} ${object.name}; preserve explicitly before rebuild`);
    }
  }
}
function migrateIdentity(db: Database.Database): void {
  if (db.inTransaction) throw new Error("Identity migration requires an outer connection");
  assertS1Empty(db);
  identityShape(db);
  const foreignKeys = Number(db.pragma("foreign_keys", { simple: true }));
  try {
    db.pragma("foreign_keys = off");
    db.exec("begin immediate");
    assertS1Empty(db);
    if (identityShape(db) === "new") {
      db.exec("drop table if exists alpha_invites; drop table if exists access_events; drop table if exists app_users;");
      db.exec("commit");
      return;
    }
    assertIdentitySourceShape(db);
    if ((db.pragma("foreign_key_check") as unknown[]).length) throw new Error("Invalid source foreign keys");
    const counts = new Map(identityTables.map(table => [table, (db.prepare(`select count(*) as n from ${table}`).get() as { n: number }).n]));
    const highWater = new Map(identityTables.map(table => [table, (db.prepare("select seq from sqlite_sequence where name=?").get(table) as { seq: number } | undefined)?.seq ?? 0]));
    // Read guild counts before rebuilding; compare again before COMMIT.
    const guilds = new Map(identityTables.map(table => [table, JSON.stringify(db.prepare(`select guild_id,count(*) n from ${table} group by guild_id order by guild_id`).all())]));
    const keys = db.prepare(`select discord_user_id as legacy_key from players
      union select created_by_user_id from tournaments
      union select created_by_user_id from cubes
      union select created_by_user_id from drafts
      union select created_by_user_id from seasons where created_by_user_id is not null
      union select owner_user_id from saved_decks order by legacy_key`).all() as Array<{ legacy_key: string }>;
    for (const { legacy_key } of keys) legacyKind(legacy_key);
    db.exec(IDENTITY_TABLE_SQL);
    db.exec("create temp table identity_key_map (legacy_key text primary key, user_id integer not null)");
    for (const { legacy_key } of keys) {
      const kind = legacyKind(legacy_key);
      const first = db.prepare("select display_name,created_at from players where discord_user_id=? order by created_at asc,id asc,guild_id asc limit 1").get(legacy_key) as { display_name: string; created_at: string } | undefined;
      const name = first?.display_name ?? (kind === "discord" ? `Duelist ${legacy_key}` : legacy_key);
      const existing = kind === "discord" ? db.prepare("select id from users where discord_user_id=?").get(legacy_key) as { id: number } | undefined : undefined;
      const id = existing?.id ?? Number(db.prepare(`insert into users(username,display_name,discord_user_id,created_at,updated_at)
        values('',?,?,coalesce(?,current_timestamp),coalesce(?,current_timestamp))`).run(name, kind === "discord" ? legacy_key : null, first?.created_at ?? null, first?.created_at ?? null).lastInsertRowid);
      if (!existing) db.prepare("update users set username=? where id=?").run(importedUsername(name, id), id);
      db.prepare("insert into identity_key_map(legacy_key,user_id) values(?,?)").run(legacy_key, id);
    }
    db.exec(IDENTITY_COPY_SQL);
    for (const table of identityTables) {
      const copied = (db.prepare(`select count(*) as n from ${table}_identity_new`).get() as { n: number }).n;
      if (copied !== counts.get(table)) throw new Error(`Identity count mismatch: ${table}`);
    }
    for (const table of identityTables) db.exec(`drop table ${table}; alter table ${table}_identity_new rename to ${table};`);
    db.exec(IDENTITY_INDEX_SQL);
    for (const table of identityTables) {
      const maximum = (db.prepare(`select coalesce(max(id),0) as n from ${table}`).get() as { n: number }).n;
      const sequence = Math.max(highWater.get(table)!, maximum);
      db.prepare("delete from sqlite_sequence where name=?").run(table);
      db.prepare("insert into sqlite_sequence(name,seq) values(?,?)").run(table, sequence);
      if (JSON.stringify(db.prepare(`select guild_id,count(*) n from ${table} group by guild_id order by guild_id`).all()) !== guilds.get(table)) throw new Error(`Identity guild mismatch: ${table}`);
    }
    db.exec("drop table identity_key_map; drop table if exists alpha_invites; drop table if exists access_events; drop table if exists app_users;");
    if ((db.pragma("foreign_key_check") as unknown[]).length) throw new Error("Invalid migrated foreign keys");
    if (db.pragma("integrity_check", { simple: true }) !== "ok") throw new Error("Identity integrity check failed");
    db.exec("commit");
  } catch (error) {
    if (db.inTransaction) db.exec("rollback");
    throw error;
  } finally {
    db.pragma(`foreign_keys = ${foreignKeys ? "on" : "off"}`);
    if (Number(db.pragma("foreign_keys", { simple: true })) !== foreignKeys) throw new Error("Failed to restore foreign_keys");
  }
}

export function migrate(db: Database.Database) {
  assertS1Empty(db);
  identityShape(db);
  db.exec("drop table if exists tournaments_without_name_unique");

  // Cube/theme unification: the legacy theme tables and the draft_templates
  // store are replaced by the unified cubes/cube_cards/draft_player_cube tables
  // below. Data was throwaway test data, so we drop rather than migrate. Drop
  // children before parents. Idempotent: no-op on a fresh database.
  db.exec(`
    drop table if exists draft_player_theme;
    drop table if exists theme_cards;
    drop table if exists themes;
    drop table if exists draft_templates;
  `);

  db.exec(`
    create table if not exists engine_card_remap_runs (
      bundle_version text primary key,
      applied_at text not null default current_timestamp
    );

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
      effect_text text,
      atk integer,
      def integer,
      attribute text,
      level integer,
      image_url text not null,
      image_url_small text not null,
      card_sets_json text not null,
      cached_at text not null
    );

    create index if not exists card_catalog_normalized_name_type_idx
      on card_catalog (lower(trim(name)), type);

    -- Old catalog rows remain untouched and refresh on their next sync. Their
    -- single image is not evidence of a complete artwork family.
    create table if not exists card_artworks (
      card_id integer not null references card_catalog(ygoprodeck_id),
      artwork_id integer primary key references card_catalog(ygoprodeck_id),
      image_url text not null,
      image_url_small text not null,
      image_url_cropped text,
      is_main integer not null check (is_main in (0, 1)),
      source text not null default 'api' check (source in ('api', 'engine'))
    );
    create index if not exists card_artworks_card_idx on card_artworks (card_id);
    create unique index if not exists card_artworks_main_idx
      on card_artworks (card_id) where is_main = 1;

    create table if not exists cubes (
      id integer primary key autoincrement,
      guild_id text not null,
      name text not null,
      archetype text,
      banlist text,
      config_json text not null default '{}',
      created_by_user_id text not null,
      created_at text not null default current_timestamp,
      updated_at text not null default current_timestamp,
      unique (guild_id, name)
    );

    create table if not exists cube_cards (
      cube_id integer not null references cubes(id) on delete cascade,
      catalog_card_id integer not null references card_catalog(ygoprodeck_id),
      pool text not null,
      max_copies integer not null default 3,
      source text,
      primary key (cube_id, catalog_card_id)
    );

    create table if not exists draft_player_cube (
      draft_id integer not null references drafts(id),
      player_id integer not null references players(id),
      cube_id integer not null references cubes(id),
      primary key (draft_id, player_id)
    );

    create table if not exists archetypes (
      name text primary key,
      synced_at text not null
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
      wave_number integer not null,
      origin_seat_index integer not null,
      current_holder_seat_index integer not null,
      pass_direction integer not null,
      created_at text not null default current_timestamp,
      unique (draft_id, wave_number, origin_seat_index)
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

    create table if not exists draft_deal (
      draft_id integer not null references drafts(id),
      position integer not null,
      catalog_card_id integer not null references card_catalog(ygoprodeck_id),
      primary key (draft_id, position)
    );

    -- Undealt booster copies, in their original deal order. Old drafts have no rows.
    create table if not exists draft_undealt (
      draft_id integer not null references drafts(id) on delete cascade,
      position integer not null,
      catalog_card_id integer not null references card_catalog(ygoprodeck_id),
      primary key (draft_id, position)
    );

    create table if not exists draft_picks (
      id integer primary key autoincrement,
      draft_id integer not null references drafts(id),
      player_id integer not null,
      draft_card_id integer not null references draft_cards(id),
      wave_number integer not null,
      pick_step integer not null,
      pick_method text not null default 'manual',
      forced integer not null default 0 check (forced in (0, 1)),
      picked_at text not null,
      foreign key (draft_id, player_id) references draft_players(draft_id, player_id),
      foreign key (draft_card_id, draft_id, wave_number) references draft_cards(id, draft_id, wave_number),
      unique (draft_id, player_id, wave_number, pick_step),
      unique (draft_card_id)
    );

    -- A booster pick the player could not make (every card in the pack was capped for them, or
    -- the pack was empty). It counts toward step completion but adds no card.
    create table if not exists draft_passes (
      id integer primary key autoincrement,
      draft_id integer not null references drafts(id),
      player_id integer not null,
      wave_number integer not null,
      pick_step integer not null,
      passed_at text not null,
      foreign key (draft_id, player_id) references draft_players(draft_id, player_id),
      unique (draft_id, player_id, wave_number, pick_step)
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

    create table if not exists card_sets (
      set_name text primary key not null,
      synced_at text not null
    );
  `);

  const tournamentSchema = db
    .prepare("select sql from sqlite_master where type = 'table' and name = 'tournaments'")
    .get() as { sql: string } | undefined;

  if (tournamentSchema?.sql.includes("unique (guild_id, name)")) {
    const foreignKeys = db.pragma("foreign_keys", { simple: true }) as number;

    try {
      db.pragma("foreign_keys = off");
      db.exec("begin immediate");
      const current = db.prepare("select sql from sqlite_master where type='table' and name='tournaments'").get() as { sql: string };
      if (current.sql.includes("unique (guild_id, name)")) db.exec(rebuildLegacyTournamentSql);
      db.exec("commit");
    } catch (error) {
      if (db.inTransaction) db.exec("rollback;");
      throw error;
    } finally {
      db.pragma(`foreign_keys = ${foreignKeys ? "on" : "off"}`);
    }
  }

  addColumnIfMissing(db, "drafts", "pick_deadline_at", "text");
  addColumnIfMissing(db, "drafts", "status_message_id", "text");
  addColumnIfMissing(db, "drafts", "web_slug", "text");
  addColumnIfMissing(db, "tournaments", "web_slug", "text");
  const slugless = db
    .prepare("select id from tournaments where web_slug is null")
    .all() as Array<{ id: number }>;
  if (slugless.length > 0) {
    const update = db.prepare("update tournaments set web_slug = ? where id = ?");
    for (const { id } of slugless) {
      update.run(generateWebSlug(), id);
    }
  }
  addColumnIfMissing(db, "draft_players", "seat_index", "integer");
  // Set when the player's draft deck was saved. A player who deletes that deck does not get it back.
  addColumnIfMissing(db, "draft_players", "deck_saved_at", "text");
  // Pending lobby acknowledgements and server-owned start deadlines. Keep old
  // records unready/unscheduled; a seat target remains optional in config_json.
  addColumnIfMissing(db, "draft_players", "ready_at", "text");
  addColumnIfMissing(db, "draft_players", "ready_setup_hash", "text");
  addColumnIfMissing(db, "drafts", "lobby_revision", "integer not null default 0");
  addColumnIfMissing(db, "drafts", "lobby_auto_start", "integer not null default 0");
  addColumnIfMissing(db, "drafts", "lobby_auto_held", "integer not null default 0");
  addColumnIfMissing(db, "drafts", "lobby_start_at", "text");
  addColumnIfMissing(db, "drafts", "lobby_start_kind", "text");
  addColumnIfMissing(db, "drafts", "lobby_start_token", "text");
  addColumnIfMissing(db, "drafts", "lobby_start_revision", "integer");
  addColumnIfMissing(db, "drafts", "lobby_start_setup_hash", "text");
  addColumnIfMissing(db, "drafts", "lobby_start_force", "integer not null default 0");
  addColumnIfMissing(db, "drafts", "lobby_start_error", "text");
  addColumnIfMissing(db, "drafts", "lobby_nudged_at", "text");
  addColumnIfMissing(db, "draft_cards", "draft_pack_id", "integer references draft_packs(id)");
  addColumnIfMissing(db, "draft_cards", "position", "integer");
  addColumnIfMissing(db, "draft_picks", "pick_method", "text not null default 'manual'");
  // Only explicit copy-limit ON booster drafts can identify old forced picks reliably.
  // Older configs without the flag and copy-limit OFF/theme drafts retain the three-copy rule.
  // Add and backfill in one write transaction; later migrate calls preserve recorded flags.
  db.transaction(() => {
    if (hasColumn(db, "draft_picks", "forced")) return;
    addColumnIfMissing(db, "draft_picks", "forced", "integer not null default 0 check (forced in (0, 1))");
    db.exec(`
      with ordered_picks as (
        select pk.id, row_number() over (
          partition by pk.draft_id, pk.player_id, lower(trim(cc.name)), cc.type,
            case when cc.ygoprodeck_id is null then dc.catalog_card_id end
          order by pk.id
        ) as copy_number
        from draft_picks pk
        join drafts d on d.id = pk.draft_id
        join draft_cards dc on dc.id = pk.draft_card_id
        left join card_catalog cc on cc.ygoprodeck_id = dc.catalog_card_id
        where json_extract(d.config_json, '$.copyLimit') = 1
          and coalesce(json_extract(d.config_json, '$.mode'), 'booster') != 'theme'
      )
      update draft_picks set forced = 1
      where id in (select id from ordered_picks where copy_number > 3)
    `);
  }).immediate();
  addColumnIfMissing(db, "card_catalog", "effect_text", "text");
  addColumnIfMissing(db, "card_catalog", "atk", "integer");
  addColumnIfMissing(db, "card_catalog", "def", "integer");
  addColumnIfMissing(db, "card_catalog", "attribute", "text");
  addColumnIfMissing(db, "card_catalog", "level", "integer");
  addColumnIfMissing(db, "card_catalog", "archetype", "text");
  backfillMainArtworkRows(db);
  addColumnIfMissing(db, "card_sets", "card_count", "integer");
  addColumnIfMissing(db, "card_sets", "set_code", "text");
  addColumnIfMissing(db, "card_sets", "release_date", "text");

  // Independent of the on-demand catalog: compact released-set identities for
  // the operator gap report. Old released sets survive process restarts.
  db.exec(`create table if not exists card_data_set_cache (
    set_name text primary key not null,
    fetched_at text not null,
    cards_json text not null
  );`);

  // One persisted revision lets readers cache card status across processes without
  // rescanning the catalog on every request or invalidating it on duel writes.
  db.exec(`create table if not exists card_catalog_revision (
    id integer primary key check (id = 1), revision integer not null default 0
  ); insert or ignore into card_catalog_revision (id) values (1);`);
  for (const table of ["card_catalog", "card_artworks", "card_sets"]) {
    for (const event of ["insert", "update", "delete"]) {
      db.exec(`create trigger if not exists ${table}_status_${event}
        after ${event} on ${table} begin
          update card_catalog_revision set revision = revision + 1 where id = 1;
        end;`);
    }
  }
  addColumnIfMissing(db, "drafts", "tournament_id", "integer references tournaments(id)");
  addColumnIfMissing(db, "drafts", "complete_message_id", "text");
  addColumnIfMissing(db, "matches", "notify_channel_id", "text");
  addColumnIfMissing(db, "matches", "notify_message_id", "text");
  addColumnIfMissing(db, "tournaments", "completed_announced_at", "text");
  addColumnIfMissing(db, "tournaments", "deadline_at", "text");
  addColumnIfMissing(db, "tournaments", "report_confirm_window_hours", "integer");

  // Rename: draft_cube -> draft_deal (copy rows then drop; idempotent)
  const hasLegacyCube = db
    .prepare("select 1 from sqlite_master where type='table' and name='draft_cube'")
    .get();
  if (hasLegacyCube) {
    const foreignKeys = db.pragma("foreign_keys", { simple: true }) as number;
    try {
      db.pragma("foreign_keys = off");
      db.exec(`
        insert into draft_deal (draft_id, position, catalog_card_id)
          select draft_id, position, catalog_card_id from draft_cube;
        drop table draft_cube;
      `);
    } finally {
      db.pragma(`foreign_keys = ${foreignKeys ? "on" : "off"}`);
    }
  }

  // Rename: draft_packs.pack_round -> wave_number (idempotent)
  const packCols = db.prepare("pragma table_info(draft_packs)").all() as Array<{ name: string }>;
  const hasPackRound = packCols.some((c) => c.name === "pack_round");
  const hasWaveNumber = packCols.some((c) => c.name === "wave_number");
  if (hasPackRound && !hasWaveNumber) {
    db.exec("alter table draft_packs rename column pack_round to wave_number");
  }

  db.exec(`
    create unique index if not exists tournaments_web_slug_unique
    on tournaments (web_slug)
    where web_slug is not null;

    create index if not exists draft_cards_unpicked_by_draft_wave
    on draft_cards (draft_id, wave_number)
    where picked_by_player_id is null;

    create index if not exists draft_packs_holder_idx
    on draft_packs (draft_id, wave_number, current_holder_seat_index);

    create index if not exists draft_cards_pack_idx
    on draft_cards (draft_pack_id, picked_by_player_id, position);
  `);

  db.exec(`
    create table if not exists guild_settings (
      guild_id text primary key not null,
      announce_draft_created integer not null default 1,
      announce_draft_started integer not null default 1,
      announce_draft_completed integer not null default 1,
      announce_tournament_created integer not null default 1,
      announce_tournament_completed integer not null default 1,
      announce_channel_id text
    );
  `);

  db.exec(`
    create table if not exists seasons (
      id integer primary key autoincrement,
      guild_id text not null,
      number integer not null,
      name text,
      status text not null,
      started_at text not null default current_timestamp,
      ended_at text,
      created_by_user_id text
    );

    create unique index if not exists seasons_one_active
      on seasons (guild_id) where status = 'active';

    create table if not exists player_ratings (
      guild_id text not null,
      player_id integer not null references players(id),
      elo integer not null default 1000,
      career_winnings integer not null default 0,
      best_streak_alltime integer not null default 0,
      primary key (guild_id, player_id)
    );

    create table if not exists point_awards (
      id integer primary key autoincrement,
      guild_id text not null,
      season_id integer not null references seasons(id),
      player_id integer not null references players(id),
      kind text not null,                 -- 'match_win' | 'placement'
      placement text,                     -- 'champion' | 'runnerUp' | 'top4' (placement awards only)
      match_id integer references matches(id),
      tournament_id integer references tournaments(id),
      points integer not null,
      opponent_elo integer,
      size_multiplier real,
      created_at text not null default current_timestamp
    );

    create unique index if not exists point_awards_match_unique
      on point_awards (match_id, kind) where match_id is not null;

    create unique index if not exists point_awards_placement_unique
      on point_awards (tournament_id, player_id, kind) where kind = 'placement';

    create table if not exists season_standings (
      guild_id text not null,
      season_id integer not null references seasons(id),
      player_id integer not null references players(id),
      winnings integer not null default 0,
      wins integer not null default 0,
      losses integer not null default 0,
      current_streak integer not null default 0,
      best_streak integer not null default 0,
      primary key (season_id, player_id)
    );

    create table if not exists player_achievements (
      guild_id text not null,
      player_id integer not null references players(id),
      achievement_key text not null,
      unlocked_at text not null default current_timestamp,
      primary key (guild_id, player_id, achievement_key)
    );
  `);

  // Backfill tournament_id on match-win awards whose match belongs to a
  // tournament. Idempotent: the `tournament_id is null` guard means already
  // stamped rows are skipped, so this is safe to run on every startup.
  db.exec(`
    update point_awards
    set tournament_id = (
      select tm.tournament_id from tournament_matches tm where tm.match_id = point_awards.match_id
    )
    where kind = 'match_win'
      and tournament_id is null
      and match_id is not null
      and exists (select 1 from tournament_matches tm where tm.match_id = point_awards.match_id);
  `);

  db.exec(`
    -- Runtime card failures are independent of engine bundle identity and duel snapshots.
    create table if not exists card_script_errors (
      code integer primary key,
      count integer not null default 0,
      last_message text not null,
      last_script_file text not null,
      last_line integer not null,
      last_mode text not null,
      last_duel_id integer not null,
      last_seen text not null default current_timestamp
    );
    -- Operational admission state; it never participates in bundle or journal identity.
    create table if not exists card_script_auto_blocks (
      code integer not null,
      reason text not null,
      blocked_at text not null,
      distinct_duels integer not null,
      error_count integer not null,
      threshold integer not null,
      window_days integer not null,
      bundle_version text not null,
      script_hash text not null,
      card_script_hash text,
      cleared_at text,
      engine_kind text not null default 'all',
      helper_scripts text not null default '[]',
      primary key (code, engine_kind)
    );
    -- Occurrence keys and revision metadata only; no private duel snapshot is stored here.
    create table if not exists card_script_error_occurrences (
      duel_id integer not null,
      command_hash text not null,
      error_index integer not null,
      code integer not null default 0,
      created_at text not null default current_timestamp,
      primary key (duel_id, command_hash, error_index)
    );

    create table if not exists duels (
      id integer primary key autoincrement,
      guild_id text not null,
      web_slug text not null unique,
      name text not null,
      organizer_player_id integer not null references players(id),
      mode text not null,
      master_rule integer not null default 5,
      status text not null,
      seed_json text,
      bundle_version text,
      created_at text not null default current_timestamp,
      ended_at text,
      archived_at text,
      last_activity_at text,
      winner_player_id integer references players(id),
      winner_seat integer,
      result_reason text,
      snapshot_public_json text,
      snapshot_seat0_json text,
      snapshot_seat1_json text
    );

    create table if not exists duel_seats (
      duel_id integer not null references duels(id) on delete cascade,
      seat integer not null,
      player_id integer references players(id),
      is_bot integer not null default 0,
      ready integer not null default 0,
      deck_json text,
      primary key (duel_id, seat),
      unique (duel_id, player_id),
      check ((is_bot = 0 and player_id is not null) or (is_bot = 1 and player_id is null))
    );

    create table if not exists duel_commands (
      id integer primary key autoincrement,
      duel_id integer not null references duels(id) on delete cascade,
      seq integer not null,
      seat integer not null,
      command_json text not null,
      created_at text not null default current_timestamp,
      unique (duel_id, seq)
    );

    create index if not exists duels_guild_status_idx on duels (guild_id, status);
  `);

  addColumnIfMissing(db, "duels", "winner_seat", "integer");
  addColumnIfMissing(db, "duels", "archived_at", "text");
  addColumnIfMissing(db, "duels", "last_activity_at", "text");
  addColumnIfMissing(db, "duels", "snapshot_public_json", "text");
  addColumnIfMissing(db, "duels", "snapshot_seat0_json", "text");
  addColumnIfMissing(db, "duels", "snapshot_seat1_json", "text");
  addColumnIfMissing(db, "duels", "master_rule", "integer not null default 5");
  addColumnIfMissing(db, "duels", "settings_json", "text");
  addColumnIfMissing(db, "duels", "clock_json", "text");
  addColumnIfMissing(db, "duels", "invite_code", "text");
  addColumnIfMissing(db, "duels", "format", "text not null default '1v1'");
  addColumnIfMissing(db, "duels", "snapshot_seats_json", "text");
  addColumnIfMissing(db, "duels", "setup_json", "text");
  addColumnIfMissing(db, "duels", "kind", "text not null default 'play' check (kind in ('play', 'replay-fork'))");
  db.exec(`
    create trigger if not exists duels_kind_immutable
    before update of kind on duels
    when new.kind is not old.kind
    begin
      select raise(abort, 'Duel kind is immutable');
    end;
    create table if not exists replay_fork_requests (
      owner_user_id integer not null references users(id) on delete cascade,
      request_id text not null,
      source_slug text not null,
      source_version text not null,
      cursor_digest text not null,
      fork_duel_id integer not null references duels(id) on delete cascade,
      created_at text not null default current_timestamp,
      primary key (owner_user_id, request_id)
    );
  `);

  db.transaction(() => {
    const seatInfo = db.prepare<[], { name: string; notnull: number }>("pragma table_info(duel_seats)").all();
    const playerCol = seatInfo.find((column) => column.name === "player_id");
    const hasBotCol = seatInfo.some((column) => column.name === "is_bot");
    if (playerCol && (!hasBotCol || playerCol.notnull === 1)) {
      db.exec(`
        create table duel_seats_bot (
          duel_id integer not null references duels(id) on delete cascade,
          seat integer not null,
          player_id integer references players(id),
          is_bot integer not null default 0,
          ready integer not null default 0,
          deck_json text,
          primary key (duel_id, seat),
          unique (duel_id, player_id),
          check ((is_bot = 0 and player_id is not null) or (is_bot = 1 and player_id is null))
        );
        insert into duel_seats_bot (duel_id, seat, player_id, is_bot, ready, deck_json)
          select duel_id, seat, player_id, 0, ready, deck_json from duel_seats;
        drop table duel_seats;
        alter table duel_seats_bot rename to duel_seats;
      `);
    }
  }).immediate();

  db.exec(`
    create index if not exists duels_guild_archived_created_idx on duels (guild_id, archived_at, created_at);
    create index if not exists duels_archive_due_idx on duels (ended_at) where archived_at is null;
    create table if not exists duel_invite_grants (
      duel_id integer not null references duels(id) on delete cascade,
      player_id integer not null references players(id),
      created_at text not null default current_timestamp,
      primary key (duel_id, player_id)
    );
    create index if not exists duel_invite_grants_player_idx on duel_invite_grants (player_id);
    create unique index if not exists duels_invite_code_idx on duels (invite_code) where invite_code is not null;

    update duels
    set winner_seat = (
      select s.seat from duel_seats s
      where s.duel_id = duels.id and s.player_id = duels.winner_player_id
    )
    where winner_player_id is not null and winner_seat is null;
  `);

  db.exec(`
    create table if not exists saved_decks (
      id integer primary key autoincrement,
      guild_id text not null,
      owner_user_id text not null,
      name text not null,
      mode text not null,
      deck_json text not null,
      created_at text not null default current_timestamp,
      updated_at text not null default current_timestamp
    );
    create index if not exists saved_decks_owner_list_idx on saved_decks (guild_id, owner_user_id, updated_at);
  `);

  // Duel series: a match of 1 or 3 games between two players. Every game is a
  // duels row with series_id. When the series has a winner it writes one
  // approved matches row (tournament or ranked casual) in the same transaction
  // that finishes the last game.
  db.exec(`
    create table if not exists duel_series (
      id integer primary key autoincrement,
      guild_id text not null,
      best_of integer not null default 1,
      ranked integer not null default 0,
      player0_id integer not null references players(id),
      player1_id integer not null references players(id),
      wins0 integer not null default 0,
      wins1 integer not null default 0,
      status text not null default 'active',
      winner_player_id integer references players(id),
      tournament_match_id integer references tournament_matches(id),
      match_id integer references matches(id),
      mode text not null,
      master_rule integer not null default 5,
      settings_json text not null,
      base_deck0_json text,
      base_deck1_json text,
      deck0_json text,
      deck1_json text,
      side_ready0 integer not null default 0,
      side_ready1 integer not null default 0,
      next_game_at text,
      created_by_player_id integer not null references players(id),
      created_at text not null default current_timestamp,
      ended_at text,
      check (best_of in (1, 3)),
      check (status in ('active', 'between_games', 'completed', 'cancelled'))
    );
    create unique index if not exists duel_series_open_tournament_match_idx
      on duel_series (tournament_match_id)
      where tournament_match_id is not null and status in ('active', 'between_games');
    create index if not exists duel_series_between_games_idx on duel_series (next_game_at) where status = 'between_games';
  `);
  addColumnIfMissing(db, "duels", "series_id", "integer references duel_series(id)");
  addColumnIfMissing(db, "duels", "game_number", "integer");
  // Match options chosen at create time. A series game copies its series.
  addColumnIfMissing(db, "duels", "best_of", "integer not null default 1");
  addColumnIfMissing(db, "duels", "ranked", "integer not null default 0");
  db.exec("create index if not exists duels_series_idx on duels (series_id, game_number) where series_id is not null");
  // Rock-paper-scissors before game 1: the opening state (JSON) while it runs, null otherwise.
  addColumnIfMissing(db, "duels", "opening_json", "text");
  // Between games the loser chooses to go first or second (index into the series players, and 'first' | 'second').
  addColumnIfMissing(db, "duel_series", "first_chooser", "integer");
  addColumnIfMissing(db, "duel_series", "first_choice", "text");
  // A best of 3 against the practice bot: index 0 is the human, index 1 the bot (player1_id repeats the human).
  addColumnIfMissing(db, "duel_series", "vs_bot", "integer not null default 0");

  // Tournament duel rules and match length. duel_rules_json holds
  // { mode, masterRule, settings }; null means the defaults for a normal duel.
  addColumnIfMissing(db, "tournaments", "best_of", "integer not null default 3");
  addColumnIfMissing(db, "tournaments", "duel_rules_json", "text");

  // One registered deck per participant. deck_json is a copy taken at
  // registration; deck_locked_at is set when the player's first tournament
  // game starts.
  addColumnIfMissing(db, "tournament_participants", "saved_deck_id", "integer references saved_decks(id) on delete set null");
  addColumnIfMissing(db, "tournament_participants", "deck_json", "text");
  addColumnIfMissing(db, "tournament_participants", "deck_registered_at", "text");
  addColumnIfMissing(db, "tournament_participants", "deck_locked_at", "text");

  // A deck built from a player's draft pool. One per owner per draft.
  addColumnIfMissing(db, "saved_decks", "draft_id", "integer references drafts(id) on delete set null");
  // Decks saved before deck_saved_at existed count as saved.
  const deckOwnerColumn = hasColumn(db, "players", "user_id") ? "user_id" : "discord_user_id";
  db.exec(`
    update draft_players set deck_saved_at = current_timestamp
    where deck_saved_at is null and exists (
      select 1 from saved_decks s
      inner join players p on p.id = draft_players.player_id
      where s.draft_id = draft_players.draft_id and s.owner_user_id = p.${deckOwnerColumn} and s.guild_id = p.guild_id
    )
  `);
  // The backfill covers only drafts with a tournament made from them or finished in the last 14 days
  // (see DRAFT_DECK_BACKFILL_DAYS in services/draft-decks.ts). Older finished drafts never backfill.
  db.exec(`
    update draft_players set deck_saved_at = current_timestamp
    where deck_saved_at is null and draft_id in (
      select d.id from drafts d
      where d.status = 'completed' and d.tournament_id is null
        and julianday(coalesce(d.ended_at, d.created_at)) < julianday('now') - 14
    )
  `);
  db.exec(`
    create unique index if not exists saved_decks_owner_draft_idx
      on saved_decks (guild_id, owner_user_id, draft_id)
      where draft_id is not null;
  `);

  // In-app bug reports. The full report (with the reporter's player id) stays here; the public GitHub issue
  // carries only the report id and the public context. github_* hold the issue the web server opened, or the
  // reason it could not (the report is kept either way).
  db.exec(`
    create table if not exists bug_reports (
      id integer primary key autoincrement,
      guild_id text not null,
      player_id integer not null references players(id),
      created_at text not null,
      path text not null,
      duel_slug text,
      description text not null,
      expected text,
      context_json text not null,
      github_issue_number integer,
      github_issue_url text,
      github_error text,
      -- The open from-app issue this report was added to instead of opening a new one (null for a report with its own issue).
      duplicate_of integer
    );
    create index if not exists bug_reports_player_idx on bug_reports (guild_id, player_id, created_at);
  `);
  db.exec("create index if not exists bug_reports_duel_idx on bug_reports (guild_id, duel_slug, created_at)");

  // Public, email-only signups are independent of Discord players and guilds.
  db.exec(`
    create table if not exists waitlist_signups (
      id integer primary key autoincrement,
      email text not null unique,
      created_at text not null,
      source text not null,
      user_agent text
    );
  `);

  addColumnIfMissing(db, "card_script_error_occurrences", "engine_kind", "text");
  addColumnIfMissing(db, "card_script_error_occurrences", "code", "integer not null default 0");
  // Historical samples have no reliable revision/policy; they cannot trigger automatic blocks.
  addColumnIfMissing(db, "card_script_error_occurrences", "resolved_code", "integer");
  addColumnIfMissing(db, "card_script_error_occurrences", "script_hash", "text");
  addColumnIfMissing(db, "card_script_error_occurrences", "script_error_mode", "text");
  addColumnIfMissing(db, "card_script_error_occurrences", "helper_scripts", "text not null default '[]'");
  addColumnIfMissing(db, "card_script_auto_blocks", "card_script_hash", "text");
  // SQLite cannot ALTER ADD COLUMN with CURRENT_TIMESTAMP. Unknown old ages are safely prunable
  // only for ended/deleted duels; active duel keys are retained by the recorder's cleanup.
  addColumnIfMissing(db, "card_script_error_occurrences", "created_at", "text not null default '1970-01-01 00:00:00'");
  db.exec("create index if not exists card_script_error_duel_code_idx on card_script_error_occurrences (duel_id, code)");
  db.exec("create index if not exists card_script_error_created_idx on card_script_error_occurrences (created_at)");
  db.exec("create index if not exists card_script_error_revision_idx on card_script_error_occurrences (resolved_code, script_hash, created_at)");
  migrateConfigPoolsToCubeCards(db);
  migrateIdentity(db);
  migrateAccessIndexes(db);

  // Draft privacy follows identity migration so grants reference application users.
  // Adding the default also makes every existing draft private; codes stay lazy.
  db.transaction(() => {
    addColumnIfMissing(db, "drafts", "visibility", "text not null default 'private' check (visibility in ('open', 'private'))");
    addColumnIfMissing(db, "drafts", "invite_code", "text");
    db.exec(`
      create unique index if not exists drafts_invite_code_unique
        on drafts(invite_code) where invite_code is not null;
      create table if not exists draft_invite_grants (
        draft_id integer not null references drafts(id) on delete cascade,
        user_id integer not null references users(id) on delete cascade,
        created_at text not null default current_timestamp,
        primary key (draft_id, user_id)
      );
    `);
  }).immediate();

  // Tournament privacy also follows identity migration. Existing entries become
  // private without changing their creators or participants; codes are generated lazily.
  db.transaction(() => {
    addColumnIfMissing(db, "tournaments", "visibility", "text not null default 'private' check (visibility in ('open', 'private'))");
    addColumnIfMissing(db, "tournaments", "invite_code", "text");
    db.exec(`
      create unique index if not exists tournaments_invite_code_unique
        on tournaments(invite_code) where invite_code is not null;
      create table if not exists tournament_invite_grants (
        tournament_id integer not null references tournaments(id) on delete cascade,
        user_id integer not null references users(id) on delete cascade,
        created_at text not null default current_timestamp,
        primary key (tournament_id, user_id)
      );
    `);
  }).immediate();

  // Names belong to their host. Never recreate the old guild-wide indexes on
  // startup: different hosts can already share names after this migration.
  db.transaction(() => {
    db.exec(`
      drop index if exists tournaments_current_name_unique;
      drop index if exists drafts_current_name_unique;
      create unique index if not exists tournaments_current_host_name_unique
        on tournaments(guild_id, created_by_user_id, name) where status in ('pending', 'active');
      create unique index if not exists drafts_current_host_name_unique
        on drafts(guild_id, created_by_user_id, name) where status in ('pending', 'active');
    `);
  }).immediate();
}

/**
 * Cubes saved from the create form kept their cards only in config_json.customCardIds, so the library and
 * editor (which read cube_cards) showed them empty. Move those ids into cube_cards. Only cubes with no
 * cube_cards rows are touched. cube_cards.catalog_card_id references card_catalog, so ids missing from the
 * catalog stay in customCardIds; everything else is removed from config. A cube with more than 99 copies of one card is left alone, since a split would leave
 * the overflow as the only dealt copies (the deal skips cube_cards rows whose id is listed in config). Idempotent.
 */
function migrateConfigPoolsToCubeCards(db: Database.Database) {
  const candidates = db.prepare(
    `select id, config_json from cubes
      where config_json like '%customCardIds%'
        and not exists (select 1 from cube_cards cc where cc.cube_id = cubes.id)`,
  );
  const findCard = db.prepare("select ygoprodeck_id, type, frame_type from card_catalog where ygoprodeck_id = ?");
  const insert = db.prepare(
    "insert or ignore into cube_cards (cube_id, catalog_card_id, pool, max_copies, source) values (?, ?, ?, ?, null)",
  );
  const update = db.prepare("update cubes set config_json = ? where id = ?");
  // The bot, web and duel-server each migrate at startup. The candidates are read inside an immediate
  // transaction (a write lock), so a second process waits and then finds the cubes already filled.
  db.transaction(() => {
    const cubes = candidates.all() as Array<{ id: number; config_json: string }>;
    for (const cube of cubes) {
      let config: Record<string, unknown>;
      try {
        const parsed = JSON.parse(cube.config_json || "{}");
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
        config = parsed as Record<string, unknown>;
      } catch {
        continue;
      }
      const ids = Array.isArray(config.customCardIds)
        ? config.customCardIds.filter((n): n is number => Number.isInteger(n))
        : [];
      if (ids.length === 0) continue;
      const counts = new Map<number, number>();
      for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1);
      if ([...counts.values()].some((count) => count > 99)) continue;
      const unmigrated: number[] = [];
      for (const [id, count] of counts) {
        const card = findCard.get(id) as { type: string; frame_type: string } | undefined;
        if (!card) {
          for (let n = 0; n < count; n += 1) unmigrated.push(id);
          continue;
        }
        insert.run(cube.id, id, isExtraDeckFrame({ frameType: card.frame_type, type: card.type }) ? "extra" : "main", count);
      }
      if (unmigrated.length > 0) config.customCardIds = unmigrated;
      else delete config.customCardIds;
      update.run(JSON.stringify(config), cube.id);
    }
  }).immediate();
}

/** Recreate lookup indexes after identity table rebuilds, including existing identity databases. */
function migrateAccessIndexes(db: Database.Database) {
  db.transaction(() => {
    const duplicate = db.prepare(`select 1 from drafts where web_slug is not null
      group by web_slug having count(*) > 1 limit 1`).get();
    if (duplicate) {
      db.exec("create index if not exists drafts_web_slug_idx on drafts(web_slug)");
      console.warn("[db] Duplicate draft web slugs detected; using a non-unique lookup index. Reconcile duplicates before enforcing uniqueness.");
    } else {
      db.exec("create unique index if not exists drafts_web_slug_unique on drafts(web_slug) where web_slug is not null; drop index if exists drafts_web_slug_idx;");
    }
    db.exec(`
      create index if not exists draft_players_player_idx on draft_players(player_id);
      create index if not exists tournament_participants_player_idx on tournament_participants(player_id);
      create index if not exists drafts_guild_status_created_idx on drafts(guild_id, status, created_at);
      create index if not exists tournaments_guild_status_created_idx on tournaments(guild_id, status, created_at);
      create index if not exists players_user_idx on players(user_id);
    `);
    // players already has a UNIQUE (guild_id, user_id) autoindex from the identity schema.
  }).immediate();
}
