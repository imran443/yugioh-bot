import type Database from "better-sqlite3";
import type { Theme, ThemeCard, ThemePool, ThemePools } from "../types/index.js";
import { isExtraDeckFrame, type CardCatalogService } from "./card-catalog.js";

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

export function createThemesService(db: Database.Database, catalog: CardCatalogService) {
  const touch = db.prepare("update themes set updated_at = ? where id = ?");
  const bump = (themeId: number) => touch.run(new Date().toISOString(), themeId);

  const findTheme = (themeId: number): Theme => {
    const row = db.prepare("select * from themes where id = ?").get(themeId);
    if (!row) {
      throw new Error(`Theme ${themeId} not found`);
    }
    return mapTheme(row);
  };

  const insertThemeRow = (
    guildId: string,
    name: string,
    createdByUserId: string,
    archetype: string | null,
    banlist: string | null,
  ): number => {
    const now = new Date().toISOString();
    const result = db
      .prepare(
        `insert into themes (guild_id, name, archetype, banlist, created_by_user_id, created_at, updated_at)
         values (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(guildId, name, archetype, banlist, createdByUserId, now, now);
    return Number(result.lastInsertRowid);
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

  const existingCardIds = (themeId: number): Set<number> =>
    new Set(
      (db.prepare("select catalog_card_id from theme_cards where theme_id = ?").all(themeId) as Array<{
        catalog_card_id: number;
      }>).map((r) => r.catalog_card_id),
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
      return findTheme(insertThemeRow(guildId, name, createdByUserId, null, null));
    },

    async createFromArchetype(
      guildId: string,
      archetype: string,
      createdByUserId: string,
      opts: {
        name?: string;
        banlist?: string;
        includeStaples?: boolean;
        topUpExtraWithGenerics?: boolean;
        extraTarget?: number;
        maxCopies?: number;
      } = {},
    ): Promise<Theme> {
      const {
        name = archetype,
        banlist,
        includeStaples = false,
        topUpExtraWithGenerics = true,
        extraTarget = 15,
        maxCopies = 3,
      } = opts;

      const { main, extra } = await catalog.syncByArchetype(archetype, { banlist });
      const themeId = insertThemeRow(guildId, name, createdByUserId, archetype, banlist ?? null);

      for (const card of main) {
        upsertCard.run(themeId, card.ygoprodeckId, "main", maxCopies, null);
      }
      for (const card of extra) {
        upsertCard.run(themeId, card.ygoprodeckId, "extra", maxCopies, null);
      }

      if (includeStaples) {
        const staples = await catalog.syncStaples({ banlist });
        const present = existingCardIds(themeId);
        for (const card of staples) {
          if (!present.has(card.ygoprodeckId)) {
            upsertCard.run(themeId, card.ygoprodeckId, "main", maxCopies, "staple");
          }
        }
      }

      if (topUpExtraWithGenerics && extra.length < extraTarget) {
        const generics = await catalog.syncGenericExtra({ banlist });
        const present = existingCardIds(themeId);
        let added = extra.length;
        for (const card of generics) {
          if (added >= extraTarget) {
            break;
          }
          if (!present.has(card.ygoprodeckId)) {
            upsertCard.run(themeId, card.ygoprodeckId, "extra", maxCopies, "generic-extra");
            present.add(card.ygoprodeckId);
            added += 1;
          }
        }
      }

      bump(themeId);
      return findTheme(themeId);
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

    async importPasscodes(
      themeId: number,
      codes: number[],
      opts: { pool?: ThemePool } = {},
    ): Promise<{ added: number; unknown: number[] }> {
      const counts = new Map<number, number>();
      for (const id of codes) {
        counts.set(id, (counts.get(id) ?? 0) + 1);
      }

      const unknown: number[] = [];
      let added = 0;
      for (const [id, count] of counts) {
        let card = catalog.findByIds([id])[0];
        if (!card) {
          card = await catalog.syncCardById(id);
        }
        if (!card) {
          unknown.push(id);
          continue;
        }
        const pool: ThemePool = opts.pool ?? (isExtraDeckFrame(card) ? "extra" : "main");
        upsertCard.run(themeId, id, pool, Math.min(count, 3), null);
        added += 1;
      }

      bump(themeId);
      return { added, unknown };
    },

    async seedArchetypeInto(
      themeId: number,
      archetype: string,
      opts: { banlist?: string; maxCopies?: number } = {},
    ): Promise<{ added: number }> {
      const { main, extra } = await catalog.syncByArchetype(archetype, { banlist: opts.banlist });
      const present = existingCardIds(themeId);
      const maxCopies = opts.maxCopies ?? 3;
      let added = 0;
      for (const card of main) {
        if (!present.has(card.ygoprodeckId)) {
          upsertCard.run(themeId, card.ygoprodeckId, "main", maxCopies, null);
          present.add(card.ygoprodeckId);
          added += 1;
        }
      }
      for (const card of extra) {
        if (!present.has(card.ygoprodeckId)) {
          upsertCard.run(themeId, card.ygoprodeckId, "extra", maxCopies, null);
          present.add(card.ygoprodeckId);
          added += 1;
        }
      }
      bump(themeId);
      return { added };
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
