import type Database from "better-sqlite3";
import type { Theme, ThemeCard, ThemePool, ThemePools } from "../types/index.js";
import type { CardCatalogService } from "./card-catalog.js";

function mapTheme(row: any): Theme {
  return {
    id: row.id,
    guildId: row.guild_id,
    name: row.name,
    archetype: row.archetype ?? null,
    banlist: row.banlist ?? null,
    createdByUserId: row.created_by_user_id,
  };
}

function mapThemeCard(row: any): ThemeCard {
  return {
    catalogCardId: row.catalog_card_id,
    pool: row.pool as ThemePool,
    maxCopies: row.max_copies,
    source: row.source ?? undefined,
  };
}

export function createThemesService(db: Database.Database, _catalog: CardCatalogService) {
  const touch = db.prepare("update themes set updated_at = ? where id = ?");
  const bump = (themeId: number) => touch.run(new Date().toISOString(), themeId);

  const findTheme = (themeId: number): Theme => {
    const row = db.prepare("select * from themes where id = ?").get(themeId);
    if (!row) {
      throw new Error(`Theme ${themeId} not found`);
    }
    return mapTheme(row);
  };

  const upsertCard = db.prepare(
    `
      insert into theme_cards (theme_id, catalog_card_id, pool, max_copies, source)
      values (?, ?, ?, ?, ?)
      on conflict (theme_id, catalog_card_id) do update set
        pool = excluded.pool,
        max_copies = excluded.max_copies,
        source = excluded.source
    `,
  );

  const getThemePools = (themeId: number): ThemePools => {
    const rows = db
      .prepare(
        "select catalog_card_id, pool, max_copies, source from theme_cards where theme_id = ? order by rowid asc",
      )
      .all(themeId)
      .map(mapThemeCard);
    return {
      main: rows.filter((c) => c.pool === "main"),
      extra: rows.filter((c) => c.pool === "extra"),
    };
  };

  return {
    createBlank(guildId: string, name: string, createdByUserId: string): Theme {
      const now = new Date().toISOString();
      const result = db
        .prepare(
          `insert into themes (guild_id, name, archetype, banlist, created_by_user_id, created_at, updated_at)
           values (?, ?, null, null, ?, ?, ?)`,
        )
        .run(guildId, name, createdByUserId, now, now);
      return findTheme(Number(result.lastInsertRowid));
    },

    addCard(themeId: number, catalogCardId: number, pool: ThemePool, maxCopies = 3, source: string | null = null): void {
      upsertCard.run(themeId, catalogCardId, pool, maxCopies, source);
      bump(themeId);
    },

    removeCard(themeId: number, catalogCardId: number): void {
      db.prepare("delete from theme_cards where theme_id = ? and catalog_card_id = ?").run(themeId, catalogCardId);
      bump(themeId);
    },

    setMaxCopies(themeId: number, catalogCardId: number, maxCopies: number): void {
      db.prepare("update theme_cards set max_copies = ? where theme_id = ? and catalog_card_id = ?").run(
        maxCopies,
        themeId,
        catalogCardId,
      );
      bump(themeId);
    },

    getThemePools,

    findTheme,

    listThemes(guildId: string): Theme[] {
      return db
        .prepare("select * from themes where guild_id = ? order by name asc")
        .all(guildId)
        .map(mapTheme);
    },
  };
}

export type ThemesService = ReturnType<typeof createThemesService>;
