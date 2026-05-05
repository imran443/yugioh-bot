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
      "draft_packs",
      "draft_picks",
      "draft_players",
      "draft_templates",
      "drafts",
      "matches",
      "players",
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
      "pack_round",
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
  });
});
