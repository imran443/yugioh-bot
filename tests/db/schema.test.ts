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
});
