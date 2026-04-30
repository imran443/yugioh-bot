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

describe("database schema", () => {
  it("creates all bot tables", () => {
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
      "draft_cards",
      "draft_picks",
      "draft_players",
      "drafts",
      "matches",
      "players",
      "tournament_matches",
      "tournament_participants",
      "tournaments",
    ]);
  });

  it("allows reused draft names for non-current drafts but rejects duplicate current names", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = on");

    migrate(db);

    db.prepare(
      `
      insert into drafts (
        guild_id,
        channel_id,
        name,
        status,
        created_by_user_id,
        config_json,
        current_wave_number,
        current_pick_step
      ) values ('guild-1', 'channel-1', 'cube night', 'completed', 'user-1', '{}', 0, 0)
    `,
    ).run();

    db.prepare(
      `
      insert into drafts (
        guild_id,
        channel_id,
        name,
        status,
        created_by_user_id,
        config_json,
        current_wave_number,
        current_pick_step
      ) values ('guild-1', 'channel-1', 'cube night', 'pending', 'user-1', '{}', 0, 0)
    `,
    ).run();

    expect(() =>
      db.prepare(
        `
        insert into drafts (
          guild_id,
          channel_id,
          name,
          status,
          created_by_user_id,
          config_json,
          current_wave_number,
          current_pick_step
        ) values ('guild-1', 'channel-1', 'cube night', 'active', 'user-1', '{}', 0, 0)
      `,
      ).run(),
    ).toThrow(/UNIQUE constraint failed/);
  });

  it("creates draft tables with the approved column shapes and uniqueness", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = on");

    migrate(db);

    expect(getTableInfo(db, "card_catalog").map((column) => column.name)).toEqual([
      "ygoprodeck_id",
      "name",
      "type",
      "frame_type",
      "image_url",
      "image_url_small",
      "card_sets_json",
      "cached_at",
    ]);
    expect(getTableInfo(db, "card_catalog").find((column) => column.name === "ygoprodeck_id")).toMatchObject({
      notnull: 1,
      pk: 1,
    });

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
      "created_at",
      "started_at",
      "ended_at",
    ]);

    expect(getTableInfo(db, "draft_players").map((column) => column.name)).toEqual([
      "draft_id",
      "player_id",
      "pick_count",
      "finished_at",
      "joined_at",
    ]);

    expect(getTableInfo(db, "draft_cards").map((column) => column.name)).toEqual([
      "id",
      "draft_id",
      "wave_number",
      "catalog_card_id",
      "picked_by_player_id",
      "picked_at",
      "created_at",
    ]);

    expect(getTableInfo(db, "draft_picks").map((column) => column.name)).toEqual([
      "id",
      "draft_id",
      "player_id",
      "draft_card_id",
      "wave_number",
      "pick_step",
      "picked_at",
    ]);

    db.prepare(
      `
      insert into players (id, guild_id, discord_user_id, display_name)
      values (1, 'guild-1', 'user-1', 'Yugi')
    `,
    ).run();
    db.prepare(
      `
      insert into players (id, guild_id, discord_user_id, display_name)
      values (2, 'guild-1', 'user-2', 'Kaiba')
    `,
    ).run();
    db.prepare(
      `
      insert into drafts (
        id,
        guild_id,
        channel_id,
        name,
        status,
        created_by_user_id,
        config_json,
        current_wave_number,
        current_pick_step
      ) values (1, 'guild-1', 'channel-1', 'cube night', 'active', 'user-1', '{}', 1, 1)
    `,
    ).run();
    db.prepare(
      `
      insert into draft_players (draft_id, player_id)
      values (1, 1)
    `,
    ).run();
    db.prepare(
      `
      insert into card_catalog (
        ygoprodeck_id,
        name,
        type,
        frame_type,
        image_url,
        image_url_small,
        card_sets_json,
        cached_at
      ) values (100, 'Dark Magician', 'Spellcaster', 'normal', 'https://img/full', 'https://img/small', '[]', '2026-01-01T00:00:00Z')
    `,
    ).run();
    db.prepare(
      `
      insert into draft_cards (
        id,
        draft_id,
        wave_number,
        catalog_card_id
      ) values (2, 1, 1, 100)
    `,
    ).run();

    expect(() =>
      db.prepare(
        `
        insert into draft_cards (
          draft_id,
          wave_number,
          catalog_card_id,
          picked_by_player_id,
          picked_at
        ) values (1, 1, 100, 2, '2026-01-01T00:00:00Z')
      `,
      ).run(),
    ).toThrow(/FOREIGN KEY constraint failed/);

    db.prepare(
      `
      insert into draft_cards (
        id,
        draft_id,
        wave_number,
        catalog_card_id,
        picked_by_player_id,
        picked_at
      ) values (1, 1, 1, 100, 1, '2026-01-01T00:00:00Z')
    `,
    ).run();
    db.prepare(
      `
      insert into draft_picks (
        draft_id,
        player_id,
        draft_card_id,
        wave_number,
        pick_step,
        picked_at
      ) values (1, 1, 1, 1, 1, '2026-01-01T00:00:00Z')
    `,
    ).run();

    expect(() =>
      db.prepare(
        `
        insert into draft_players (draft_id, player_id)
        values (999, 1)
      `,
      ).run(),
    ).toThrow(/FOREIGN KEY constraint failed/);

    expect(() =>
      db.prepare(
        `
        insert into draft_picks (
          draft_id,
          player_id,
          draft_card_id,
          wave_number,
          pick_step,
          picked_at
        ) values (1, 1, 2, 1, 1, '2026-01-01T00:05:00Z')
      `,
      ).run(),
    ).toThrow(/UNIQUE constraint failed/);

    expect(() =>
      db.prepare(
        `
        insert into draft_picks (
          draft_id,
          player_id,
          draft_card_id,
          wave_number,
          pick_step,
          picked_at
        ) values (1, 2, 2, 1, 2, '2026-01-01T00:06:00Z')
      `,
      ).run(),
    ).toThrow(/FOREIGN KEY constraint failed/);

    db.prepare(
      `
      insert into drafts (
        id,
        guild_id,
        channel_id,
        name,
        status,
        created_by_user_id,
        config_json,
        current_wave_number,
        current_pick_step
      ) values (2, 'guild-1', 'channel-2', 'side cube', 'active', 'user-1', '{}', 1, 1)
    `,
    ).run();
    db.prepare(
      `
      insert into draft_cards (
        id,
        draft_id,
        wave_number,
        catalog_card_id
      ) values (3, 2, 2, 100)
    `,
    ).run();

    expect(() =>
      db.prepare(
        `
        insert into draft_picks (
          draft_id,
          player_id,
          draft_card_id,
          wave_number,
          pick_step,
          picked_at
        ) values (1, 1, 3, 1, 3, '2026-01-01T00:15:00Z')
      `,
      ).run(),
    ).toThrow(/FOREIGN KEY constraint failed/);

    expect(() =>
      db.prepare(
        `
        insert into draft_picks (
          draft_id,
          player_id,
          draft_card_id,
          wave_number,
          pick_step,
          picked_at
        ) values (1, 1, 1, 1, 2, '2026-01-01T00:10:00Z')
      `,
      ).run(),
    ).toThrow(/UNIQUE constraint failed/);
  });

  it("migrates old tournament name uniqueness to current-event uniqueness", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = on");
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
        ended_at text,
        unique (guild_id, name)
      );

      insert into tournaments (guild_id, name, format, status, created_by_user_id)
      values ('guild-1', 'locals', 'round_robin', 'cancelled', 'user-1');
    `);

    migrate(db);

    db.prepare(
      `
      insert into tournaments (guild_id, name, format, status, created_by_user_id)
      values ('guild-1', 'locals', 'single_elim', 'pending', 'user-1')
    `,
    ).run();

    expect(() =>
      db.prepare(
        `
        insert into tournaments (guild_id, name, format, status, created_by_user_id)
        values ('guild-1', 'locals', 'round_robin', 'active', 'user-1')
      `,
      ).run(),
    ).toThrow(/UNIQUE constraint failed/);
  });

  it("migrates old tournament uniqueness when child tables reference tournaments", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = on");
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
        ended_at text,
        unique (guild_id, name)
      );

      create table tournament_participants (
        tournament_id integer not null references tournaments(id),
        player_id integer not null references players(id),
        joined_at text not null default current_timestamp,
        primary key (tournament_id, player_id)
      );

      insert into players (id, guild_id, discord_user_id, display_name)
      values (1, 'guild-1', 'user-1', 'Yugi');

      insert into tournaments (id, guild_id, name, format, status, created_by_user_id)
      values (1, 'guild-1', 'locals', 'round_robin', 'cancelled', 'user-1');

      insert into tournament_participants (tournament_id, player_id)
      values (1, 1);
    `);

    expect(() => migrate(db)).not.toThrow();
    expect(
      db.prepare("select count(*) as count from tournament_participants where tournament_id = 1").get(),
    ).toEqual({ count: 1 });
  });

  it("cleans up a leftover tournament migration temp table before retrying", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = on");
    db.exec(`
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
    `);

    expect(() => migrate(db)).not.toThrow();
    expect(
      db
        .prepare("select name from sqlite_master where type = 'table' and name = 'tournaments_without_name_unique'")
        .get(),
    ).toBeUndefined();
  });
});
