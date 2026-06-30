import type Database from "better-sqlite3";
import type { Card, Cube, CubeCard, CubePool, CubePools, DraftConfig } from "../types/index.js";
import { isExtraDeckFrame, type CardCatalogService } from "./card-catalog.js";
import type { CubeAnalysis } from "./deal.js";

export interface AnalyzeCubePoolsConfig {
  themePackSize: number;
  cardsPerPlayer: number;
  extraDeckSize: number;
  burnUnpicked: boolean;
  extraDeckEnabled: boolean;
}

function requiredPoolSize(rounds: number, themePackSize: number, burnUnpicked: boolean): number {
  return burnUnpicked ? rounds * themePackSize : rounds + (themePackSize - 1);
}

function mapCube(row: any): Cube {
  return {
    id: row.id,
    guildId: row.guild_id,
    name: row.name,
    archetype: row.archetype ?? null,
    banlist: row.banlist ?? null,
    config: JSON.parse(row.config_json ?? "{}") as DraftConfig,
    createdByUserId: row.created_by_user_id,
  };
}

function mapCubeCard(row: any): CubeCard {
  return {
    catalogCardId: row.catalog_card_id,
    pool: row.pool as CubePool,
    maxCopies: row.max_copies,
    source: row.source ?? undefined,
  };
}

export function createCubeService(db: Database.Database, catalog: CardCatalogService) {
  const touch = db.prepare("update cubes set updated_at = ? where id = ?");
  const bump = (cubeId: number) => touch.run(new Date().toISOString(), cubeId);

  const findCube = (cubeId: number): Cube => {
    const row = db.prepare("select * from cubes where id = ?").get(cubeId);
    if (!row) {
      throw new Error(`Cube ${cubeId} not found`);
    }
    return mapCube(row);
  };

  const insertCubeRow = (
    guildId: string,
    name: string,
    createdByUserId: string,
    archetype: string | null,
    banlist: string | null,
  ): number => {
    const now = new Date().toISOString();
    const result = db
      .prepare(
        `insert into cubes (guild_id, name, archetype, banlist, created_by_user_id, created_at, updated_at)
         values (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(guildId, name, archetype, banlist, createdByUserId, now, now);
    return Number(result.lastInsertRowid);
  };

  const upsertCard = db.prepare(
    `
      insert into cube_cards (cube_id, catalog_card_id, pool, max_copies, source)
      values (?, ?, ?, ?, ?)
      on conflict (cube_id, catalog_card_id) do update set
        pool = excluded.pool,
        max_copies = excluded.max_copies,
        source = excluded.source
    `,
  );

  const existingCardIds = (cubeId: number): Set<number> =>
    new Set(
      (db.prepare("select catalog_card_id from cube_cards where cube_id = ?").all(cubeId) as Array<{
        catalog_card_id: number;
      }>).map((r) => r.catalog_card_id),
    );

  const getCubePools = (cubeId: number): CubePools => {
    const rows = db
      .prepare(
        "select catalog_card_id, pool, max_copies, source from cube_cards where cube_id = ? order by rowid asc",
      )
      .all(cubeId)
      .map(mapCubeCard);
    return {
      main: rows.filter((c) => c.pool === "main"),
      extra: rows.filter((c) => c.pool === "extra"),
    };
  };

  return {
    createBlank(guildId: string, name: string, createdByUserId: string): Cube {
      return findCube(insertCubeRow(guildId, name, createdByUserId, null, null));
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
    ): Promise<Cube> {
      const {
        name = archetype,
        banlist,
        includeStaples = false,
        topUpExtraWithGenerics = true,
        extraTarget = 15,
        maxCopies = 3,
      } = opts;

      const { main, extra } = await catalog.syncByArchetype(archetype, { banlist });
      const cubeId = insertCubeRow(guildId, name, createdByUserId, archetype, banlist ?? null);

      for (const card of main) {
        upsertCard.run(cubeId, card.ygoprodeckId, "main", maxCopies, null);
      }
      for (const card of extra) {
        upsertCard.run(cubeId, card.ygoprodeckId, "extra", maxCopies, null);
      }

      if (includeStaples) {
        const staples = await catalog.syncStaples({ banlist });
        const present = existingCardIds(cubeId);
        for (const card of staples) {
          if (!present.has(card.ygoprodeckId)) {
            upsertCard.run(cubeId, card.ygoprodeckId, "main", maxCopies, "staple");
          }
        }
      }

      if (topUpExtraWithGenerics && extra.length < extraTarget) {
        const generics = await catalog.syncGenericExtra({ banlist });
        const present = existingCardIds(cubeId);
        let added = extra.length;
        for (const card of generics) {
          if (added >= extraTarget) {
            break;
          }
          if (!present.has(card.ygoprodeckId)) {
            upsertCard.run(cubeId, card.ygoprodeckId, "extra", maxCopies, "generic-extra");
            present.add(card.ygoprodeckId);
            added += 1;
          }
        }
      }

      bump(cubeId);
      return findCube(cubeId);
    },

    addCard(cubeId: number, catalogCardId: number, pool: CubePool, maxCopies = 3, source: string | null = null): void {
      upsertCard.run(cubeId, catalogCardId, pool, maxCopies, source);
      bump(cubeId);
    },

    removeCard(cubeId: number, catalogCardId: number): void {
      db.prepare("delete from cube_cards where cube_id = ? and catalog_card_id = ?").run(cubeId, catalogCardId);
      bump(cubeId);
    },

    setMaxCopies(cubeId: number, catalogCardId: number, maxCopies: number): void {
      db.prepare("update cube_cards set max_copies = ? where cube_id = ? and catalog_card_id = ?").run(
        maxCopies,
        cubeId,
        catalogCardId,
      );
      bump(cubeId);
    },

    async importPasscodes(
      cubeId: number,
      codes: number[],
      opts: { pool?: CubePool } = {},
    ): Promise<{ added: number; unknown: number[] }> {
      const counts = new Map<number, number>();
      for (const id of codes) {
        counts.set(id, (counts.get(id) ?? 0) + 1);
      }

      const unknown: number[] = [];
      let added = 0;
      for (const [id, count] of counts) {
        let card: Card | undefined = catalog.findByIds([id])[0];
        if (!card) {
          card = await catalog.syncCardById(id);
        }
        if (!card) {
          unknown.push(id);
          continue;
        }
        const pool: CubePool = opts.pool ?? (isExtraDeckFrame(card) ? "extra" : "main");
        upsertCard.run(cubeId, id, pool, Math.min(count, 3), null);
        added += 1;
      }

      bump(cubeId);
      return { added, unknown };
    },

    async seedArchetypeInto(
      cubeId: number,
      archetype: string,
      opts: { banlist?: string; maxCopies?: number } = {},
    ): Promise<{ added: number }> {
      const { main, extra } = await catalog.syncByArchetype(archetype, { banlist: opts.banlist });
      const present = existingCardIds(cubeId);
      const maxCopies = opts.maxCopies ?? 3;
      let added = 0;
      for (const card of main) {
        if (!present.has(card.ygoprodeckId)) {
          upsertCard.run(cubeId, card.ygoprodeckId, "main", maxCopies, null);
          present.add(card.ygoprodeckId);
          added += 1;
        }
      }
      for (const card of extra) {
        if (!present.has(card.ygoprodeckId)) {
          upsertCard.run(cubeId, card.ygoprodeckId, "extra", maxCopies, null);
          present.add(card.ygoprodeckId);
          added += 1;
        }
      }
      bump(cubeId);
      return { added };
    },

    analyzeCubePools(cubeId: number, config: AnalyzeCubePoolsConfig): CubeAnalysis {
      const pools = getCubePools(cubeId);
      const errors: string[] = [];
      const warnings: string[] = [];

      const mainSize = pools.main.reduce((sum, c) => sum + c.maxCopies, 0);
      const mainNeeded = requiredPoolSize(config.cardsPerPlayer, config.themePackSize, config.burnUnpicked);
      if (mainSize < mainNeeded) {
        errors.push(
          `Main pool has ${mainSize} cards but needs at least ${mainNeeded} for a ${config.cardsPerPlayer}-card main deck (${config.themePackSize} choices/pick${config.burnUnpicked ? ", burn on" : ""}).`,
        );
      }

      if (config.extraDeckEnabled) {
        const extraSize = pools.extra.reduce((sum, c) => sum + c.maxCopies, 0);
        const extraNeeded = requiredPoolSize(config.extraDeckSize, config.themePackSize, config.burnUnpicked);
        if (extraSize < extraNeeded) {
          warnings.push(
            `Extra pool has ${extraSize} cards but needs ${extraNeeded} for a full ${config.extraDeckSize}-card Extra Deck; players may end with fewer Extra cards.`,
          );
        }
      }

      return { ok: errors.length === 0, errors, warnings };
    },

    /** Rename a cube. Centralizes what used to be inline SQL in the web theme route. */
    renameCube(cubeId: number, name: string): { ok: true } | { error: string } {
      const trimmed = name.trim();
      if (!trimmed) {
        return { error: "name is required" };
      }
      const dupe = db
        .prepare(
          "select id from cubes where guild_id = (select guild_id from cubes where id = ?) and name = ? and id != ?",
        )
        .get(cubeId, trimmed, cubeId) as { id: number } | undefined;
      if (dupe) {
        return { error: `A cube named "${trimmed}" already exists` };
      }
      const result = db
        .prepare("update cubes set name = ?, updated_at = ? where id = ?")
        .run(trimmed, new Date().toISOString(), cubeId);
      return result.changes === 0 ? { error: "Cube not found" } : { ok: true };
    },

    /** Delete a cube and its cards. */
    deleteCube(cubeId: number): void {
      db.prepare("delete from cube_cards where cube_id = ?").run(cubeId);
      db.prepare("delete from cubes where id = ?").run(cubeId);
    },

    getCubePools,

    findCube,

    listCubes(guildId: string): Cube[] {
      return db
        .prepare("select * from cubes where guild_id = ? order by name asc")
        .all(guildId)
        .map(mapCube);
    },

    // ----- Discord draft-template-compatible ops (ported from the bot's
    // draft-template service; identical signatures so bot call sites are unchanged) -----

    save(guildId: string, name: string, config: DraftConfig, createdByUserId: string): Cube {
      const trimmed = name.trim();
      db.prepare(
        `
          insert into cubes (guild_id, name, config_json, created_by_user_id)
          values (?, ?, ?, ?)
          on conflict(guild_id, name) do update set
            config_json = excluded.config_json,
            created_by_user_id = excluded.created_by_user_id,
            updated_at = current_timestamp
        `,
      ).run(guildId, trimmed, JSON.stringify(config), createdByUserId);
      const row = db.prepare("select * from cubes where guild_id = ? and name = ?").get(guildId, trimmed);
      return mapCube(row);
    },

    findByName(guildId: string, name: string): Cube | undefined {
      const row = db.prepare("select * from cubes where guild_id = ? and name = ?").get(guildId, name);
      return row ? mapCube(row) : undefined;
    },

    list(guildId: string): Cube[] {
      return db
        .prepare("select * from cubes where guild_id = ? order by name asc")
        .all(guildId)
        .map(mapCube);
    },

    delete(guildId: string, name: string): void {
      db.prepare(
        "delete from cube_cards where cube_id in (select id from cubes where guild_id = ? and name = ?)",
      ).run(guildId, name);
      db.prepare("delete from cubes where guild_id = ? and name = ?").run(guildId, name);
    },
  };
}

export type CubeService = ReturnType<typeof createCubeService>;
