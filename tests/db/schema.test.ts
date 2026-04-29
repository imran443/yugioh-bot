import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { migrate } from "../../src/db/schema.js";

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
      "matches",
      "players",
      "tournament_matches",
      "tournament_participants",
      "tournaments",
    ]);
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
