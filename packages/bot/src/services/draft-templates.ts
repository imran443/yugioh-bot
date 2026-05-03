import type Database from "better-sqlite3";
import type { DraftConfig } from "./drafts.js";

export type DraftTemplate = {
  id: number;
  guildId: string;
  name: string;
  config: DraftConfig;
  createdByUserId: string;
};

function mapTemplate(row: any): DraftTemplate {
  return {
    id: row.id,
    guildId: row.guild_id,
    name: row.name,
    config: JSON.parse(row.config_json),
    createdByUserId: row.created_by_user_id,
  };
}

export function createDraftTemplateService(db: Database.Database) {
  return {
    save(guildId: string, name: string, config: DraftConfig, createdByUserId: string): DraftTemplate {
      const result = db
        .prepare(
          `
            insert into draft_templates (guild_id, name, config_json, created_by_user_id)
            values (?, ?, ?, ?)
            on conflict(guild_id, name) do update set
              config_json = excluded.config_json,
              created_by_user_id = excluded.created_by_user_id
          `,
        )
        .run(guildId, name.trim(), JSON.stringify(config), createdByUserId);

      return mapTemplate(db.prepare("select * from draft_templates where id = ?").get(result.lastInsertRowid));
    },

    list(guildId: string): DraftTemplate[] {
      return db
        .prepare("select * from draft_templates where guild_id = ? order by name asc")
        .all(guildId)
        .map(mapTemplate);
    },

    findByName(guildId: string, name: string): DraftTemplate | undefined {
      const row = db.prepare("select * from draft_templates where guild_id = ? and name = ?").get(guildId, name);

      return row ? mapTemplate(row) : undefined;
    },

    delete(guildId: string, name: string): void {
      db.prepare("delete from draft_templates where guild_id = ? and name = ?").run(guildId, name);
    },
  };
}

export type DraftTemplateService = ReturnType<typeof createDraftTemplateService>;
