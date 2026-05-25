import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { migrate } from "../../src/db/schema.js";

function getTableInfo(db: Database.Database, tableName: string) {
  return db.prepare(`pragma table_info(${tableName})`).all() as Array<{
    name: string;
    notnull: number;
    pk: number;
  }>;
}

describe("shared database schema", () => {
  it("creates all shared tables", () => {
    const db = new Database(":memory:");

    migrate(db);

    const tables = db
      .prepare(
        "select name from sqlite_master where type = 'table' and name not like 'sqlite_%' order by name",
      )
      .all()
      .map((row: any) => row.name);

    expect(tables).toEqual([
      "card_catalog",
      "card_sets",
      "draft_cards",
      "draft_deal",
      "draft_packs",
      "draft_picks",
      "draft_players",
      "draft_templates",
      "drafts",
      "guild_settings",
      "matches",
      "player_achievements",
      "player_ratings",
      "players",
      "point_awards",
      "season_standings",
      "seasons",
      "tournament_matches",
      "tournament_participants",
      "tournaments",
    ]);
  });

  it("creates draft tables with the approved column shapes", () => {
    const db = new Database(":memory:");

    migrate(db);

    expect(getTableInfo(db, "drafts").map((column) => column.name)).toEqual([
      "id",
      "guild_id",
      "channel_id",
      "name",
      "status",
      "created_by_user_id",
      "config_json",
      "current_wave_number",
      "current_pick_step",
      "pick_deadline_at",
      "status_message_id",
      "created_at",
      "started_at",
      "ended_at",
      "web_slug",
      "tournament_id",
      "complete_message_id",
    ]);
    expect(getTableInfo(db, "draft_players").map((column) => column.name)).toEqual([
      "draft_id",
      "player_id",
      "pick_count",
      "finished_at",
      "seat_index",
      "joined_at",
    ]);
    expect(getTableInfo(db, "draft_cards").map((column) => column.name)).toEqual([
      "id",
      "draft_id",
      "wave_number",
      "draft_pack_id",
      "catalog_card_id",
      "position",
      "picked_by_player_id",
      "picked_at",
      "created_at",
    ]);
    expect(getTableInfo(db, "draft_packs").map((column) => column.name)).toEqual([
      "id",
      "draft_id",
      "wave_number",
      "origin_seat_index",
      "current_holder_seat_index",
      "pass_direction",
      "created_at",
    ]);
    expect(getTableInfo(db, "draft_picks").map((column) => column.name)).toEqual([
      "id",
      "draft_id",
      "player_id",
      "draft_card_id",
      "wave_number",
      "pick_step",
      "pick_method",
      "picked_at",
    ]);
    expect(getTableInfo(db, "card_catalog").map((column) => column.name)).toEqual([
      "ygoprodeck_id",
      "name",
      "type",
      "frame_type",
      "effect_text",
      "atk",
      "def",
      "attribute",
      "level",
      "image_url",
      "image_url_small",
      "card_sets_json",
      "cached_at",
    ]);
  });

  it("adds the card_sets table when migrating an older database", () => {
    const db = new Database(":memory:");

    db.exec(`
      create table players (
        id integer primary key autoincrement,
        guild_id text not null,
        discord_user_id text not null,
        display_name text not null,
        created_at text not null default current_timestamp,
        unique (guild_id, discord_user_id)
      );

      create table tournaments (
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

      create table tournament_participants (
        tournament_id integer not null references tournaments(id),
        player_id integer not null references players(id),
        joined_at text not null default current_timestamp,
        primary key (tournament_id, player_id)
      );

      create table card_catalog (
        ygoprodeck_id integer primary key not null,
        name text not null,
        type text not null,
        frame_type text not null,
        image_url text not null,
        image_url_small text not null,
        card_sets_json text not null,
        cached_at text not null
      );

      create table drafts (
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

      create table draft_players (
        draft_id integer not null references drafts(id),
        player_id integer not null references players(id),
        pick_count integer not null default 0,
        finished_at text,
        seat_index integer,
        joined_at text not null default current_timestamp,
        primary key (draft_id, player_id)
      );

      create table draft_packs (
        id integer primary key autoincrement,
        draft_id integer not null references drafts(id),
        pack_round integer not null,
        origin_seat_index integer not null,
        current_holder_seat_index integer not null,
        pass_direction integer not null,
        created_at text not null default current_timestamp,
        unique (draft_id, pack_round, origin_seat_index)
      );

      create table draft_cards (
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

      create table draft_picks (
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

      create table matches (
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

      create table tournament_matches (
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

    migrate(db);

    const cardSetsRow = db
      .prepare("select name from sqlite_master where type = 'table' and name = 'card_sets'")
      .get() as { name: string } | undefined;

    expect(cardSetsRow?.name).toBe("card_sets");
    expect(getTableInfo(db, "card_sets").map((column) => column.name)).toEqual([
      "set_name",
      "synced_at",
      "card_count",
      "set_code",
    ]);
    expect(getTableInfo(db, "card_catalog").map((column) => column.name)).toEqual([
      "ygoprodeck_id",
      "name",
      "type",
      "frame_type",
      "image_url",
      "image_url_small",
      "card_sets_json",
      "cached_at",
      "effect_text",
      "atk",
      "def",
      "attribute",
      "level",
    ]);
  });

  it("creates tournaments table with completed_announced_at column", () => {
    const db = new Database(":memory:");

    migrate(db);

    expect(getTableInfo(db, "tournaments").map((column) => column.name)).toContain(
      "completed_announced_at",
    );
  });

  it("adds tournament timing columns", () => {
    const db = new Database(":memory:");

    migrate(db);

    const cols = getTableInfo(db, "tournaments").map((column) => column.name);
    expect(cols).toContain("deadline_at");
    expect(cols).toContain("report_confirm_window_hours");

    db.close();
  });

  it("migrates a legacy draft_cube table to draft_deal, preserving rows", () => {
    const db = new Database(":memory:");
    // minimal legacy shape
    db.exec(`
      create table draft_cube (draft_id integer not null, position integer not null,
        catalog_card_id integer not null, primary key (draft_id, position));
      insert into draft_cube (draft_id, position, catalog_card_id) values (1, 0, 1001), (1, 1, 1002);
    `);
    migrate(db);
    const rows = db.prepare("select position, catalog_card_id from draft_deal where draft_id = 1 order by position").all();
    expect(rows).toEqual([
      { position: 0, catalog_card_id: 1001 },
      { position: 1, catalog_card_id: 1002 },
    ]);
    const oldGone = db.prepare("select 1 from sqlite_master where type='table' and name='draft_cube'").get();
    expect(oldGone).toBeUndefined();
  });

  it("renames legacy draft_packs.pack_round to wave_number, preserving rows", () => {
    const db = new Database(":memory:");
    db.exec(`
      create table draft_packs (id integer primary key autoincrement, draft_id integer not null,
        pack_round integer not null, origin_seat_index integer not null,
        current_holder_seat_index integer not null, pass_direction integer not null);
      insert into draft_packs (draft_id, pack_round, origin_seat_index, current_holder_seat_index, pass_direction)
        values (1, 2, 0, 0, 1);
    `);
    migrate(db);
    const row = db.prepare("select wave_number from draft_packs where draft_id = 1").get();
    expect(row).toEqual({ wave_number: 2 });
  });

  it("backfills web_slug for tournaments that pre-date the column", () => {
    const db = new Database(":memory:");
    // Simulate legacy schema without web_slug
    db.exec(`
      create table tournaments (
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
    `);
    db.prepare(
      "insert into tournaments (guild_id, name, format, status, created_by_user_id) values (?, ?, ?, ?, ?)",
    ).run("g1", "old-event", "round_robin", "completed", "u1");

    migrate(db);

    const row = db
      .prepare("select web_slug from tournaments where name = ?")
      .get("old-event") as { web_slug: string | null };
    expect(row.web_slug).toMatch(/^[a-z0-9]{8}$/);
  });
});

describe("migrate backfills match-win tournament_id", () => {
  it("sets tournament_id on legacy match_win awards that belong to a tournament match", () => {
    const db = new Database(":memory:");
    migrate(db);
    const guild = "g1";
    const seasonId = Number(
      db.prepare("insert into seasons (guild_id, number, status) values (?, 1, 'active')").run(guild).lastInsertRowid,
    );
    const p1 = Number(
      db.prepare("insert into players (guild_id, discord_user_id, display_name) values (?, 'u1', 'A')").run(guild).lastInsertRowid,
    );
    const p2 = Number(
      db.prepare("insert into players (guild_id, discord_user_id, display_name) values (?, 'u2', 'B')").run(guild).lastInsertRowid,
    );
    const matchId = Number(
      db
        .prepare(
          "insert into matches (guild_id, player_one_id, player_two_id, winner_id, reporter_id, status, source) values (?, ?, ?, ?, ?, 'approved', 'tournament')",
        )
        .run(guild, p1, p2, p1, p1).lastInsertRowid,
    );
    const tournamentId = Number(
      db
        .prepare("insert into tournaments (guild_id, name, format, status, created_by_user_id) values (?, 'Cup', 'round_robin', 'completed', 'host')")
        .run(guild).lastInsertRowid,
    );
    db.prepare(
      "insert into tournament_matches (tournament_id, match_id, player_one_id, player_two_id, round_number, status) values (?, ?, ?, ?, 1, 'completed')",
    ).run(tournamentId, matchId, p1, p2);
    // Legacy award written before tournament_id was stamped.
    db.prepare(
      "insert into point_awards (guild_id, season_id, player_id, kind, match_id, points) values (?, ?, ?, 'match_win', ?, 5)",
    ).run(guild, seasonId, p1, matchId);

    migrate(db); // re-run: the idempotent backfill runs every startup

    const award = db.prepare("select tournament_id from point_awards where match_id = ?").get(matchId) as {
      tournament_id: number | null;
    };
    expect(award.tournament_id).toBe(tournamentId);
  });
});
