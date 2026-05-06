import Database from "better-sqlite3";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = "/home/imran/yugioh-discord-bot";
const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("seed script", () => {
  it("stores the Discord user id as created_by_user_id for seeded tournaments and drafts", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "yugioh-seed-"));
    const dbPath = join(tempDir, "seed.sqlite");
    const discordUserId = "seed-user-123";
    const guildId = "seed-guild-456";

    tempDirs.push(tempDir);

    execFileSync(process.execPath, ["--import", "tsx", "scripts/seed.ts"], {
      cwd: repoRoot,
      env: {
        ...process.env,
        DATABASE_PATH: dbPath,
        DISCORD_USER_ID: discordUserId,
        DISCORD_GUILD_ID: guildId,
      },
      stdio: "pipe",
    });

    const db = new Database(dbPath, { readonly: true });

    const tournamentOwners = db
      .prepare(
        "select distinct created_by_user_id from tournaments where guild_id = ? and name in ('Friday Night Fights', 'Weekend Championship') order by created_by_user_id"
      )
      .all(guildId) as Array<{ created_by_user_id: string }>;

    const draftOwners = db
      .prepare(
        "select distinct created_by_user_id from drafts where guild_id = ? and name in ('Legendary Draft', 'Retro Draft') order by created_by_user_id"
      )
      .all(guildId) as Array<{ created_by_user_id: string }>;

    const draftConfigs = db
      .prepare(
        "select name, config_json from drafts where guild_id = ? and name in ('Legendary Draft', 'Retro Draft') order by name"
      )
      .all(guildId) as Array<{ name: string; config_json: string }>;

    expect(tournamentOwners).toEqual([{ created_by_user_id: discordUserId }]);
    expect(draftOwners).toEqual([{ created_by_user_id: discordUserId }]);
    expect(draftConfigs.map((draft) => ({
      name: draft.name,
      setNames: JSON.parse(draft.config_json).setNames,
    }))).toEqual([
      {
        name: "Legendary Draft",
        setNames: [
          "Legend of Blue Eyes White Dragon",
          "Metal Raiders",
          "Spell Ruler",
        ],
      },
      {
        name: "Retro Draft",
        setNames: [
          "Legend of Blue Eyes White Dragon",
          "Metal Raiders",
          "Spell Ruler",
        ],
      },
    ]);
  });
});
