import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { openDatabase } from "@yugidraft/shared/db";

describe("shared database package", () => {
  it("opens a migrated bot database from the bot package", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "yugidraft-bot-db-"));
    const dbPath = join(tempDir, "bot.sqlite");

    try {
      const db = openDatabase(dbPath);
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

      db.close();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
