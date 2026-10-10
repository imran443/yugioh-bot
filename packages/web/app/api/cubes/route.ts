import { cardFetchErrorResponse } from "@/lib/card-fetch-errors";
import { NextResponse } from "next/server";
import { requireWebAccess } from "@/lib/web-access";
import { getDb } from "@/lib/db";
import { env } from "@/lib/env";
import { boosterDraftConfigError, createCardLookupBudget, createCardCatalogService, createCubeService, CubeNameTakenError } from "@yugidraft/shared/services";
import type { DraftConfig } from "@yugidraft/shared/types";
import { cubeDraftTypeOf, parseCubeDraftType, setCubeDraftType } from "@/lib/cube-type";
import { ensureCatalogCards, parsePoolEntries } from "@/lib/cube-pool";
import { prepareCubeListImport } from "@/lib/cube-list-import";
import { themeDraftsEnabled } from "@/lib/theme-drafts";

export const runtime = "nodejs";

type CubeRow = {
  id: number;
  guild_id: string;
  name: string;
  archetype: string | null;
  banlist: string | null;
  config_json: string;
  created_by_user_id: number;
  created_by_name: string | null;
};

/** The created cube as the client reads it: the stored row plus its draft type. */
function withDraftType<T extends object>(db: ReturnType<typeof getDb>, cubeId: number, cube: T) {
  const row = db.prepare("select config_json from cubes where id = ?").get(cubeId) as { config_json: string } | undefined;
  return { ...cube, draftType: cubeDraftTypeOf(row?.config_json) };
}

export async function GET() {
  const actor = await requireWebAccess();
  if (!actor.ok) return actor.response;
  if (!env.discordGuildId) {
    return NextResponse.json({ error: "Server not configured for cubes" }, { status: 500 });
  }

  const db = getDb();
  const rows = db
    .prepare(`select c.id, c.guild_id, c.name, c.archetype, c.banlist, c.config_json, c.created_by_user_id,
              (select u.display_name from users u where u.id = c.created_by_user_id) as created_by_name
         from cubes c where c.guild_id = ? order by c.name asc`)
    .all(env.discordGuildId) as CubeRow[];

  // One query for every card of every cube in the guild, instead of two per cube.
  const cardRows = db
    .prepare(
      `select cc.cube_id, cc.pool, cc.catalog_card_id, cc.max_copies
         from cube_cards cc
         join cubes c on c.id = cc.cube_id
        where c.guild_id = ?
        order by cc.cube_id asc, cc.rowid asc`,
    )
    .all(env.discordGuildId) as Array<{ cube_id: number; pool: string; catalog_card_id: number; max_copies: number }>;
  const mainByCube = new Map<number, Array<{ id: number; copies: number }>>();
  const extraCountByCube = new Map<number, number>();
  for (const card of cardRows) {
    if (card.pool === "main") {
      const list = mainByCube.get(card.cube_id) ?? [];
      list.push({ id: card.catalog_card_id, copies: card.max_copies });
      mainByCube.set(card.cube_id, list);
    } else if (card.pool === "extra") {
      extraCountByCube.set(card.cube_id, (extraCountByCube.get(card.cube_id) ?? 0) + 1);
    }
  }

  // One shape serves both the Cubes library (main/extra counts) and the saved-pool
  // loaders in the cube-draft create form / settings (setNames + customCardIds). A cube
  // built in the editor keeps its cards in cube_cards, not in config, so mainCards
  // carries those passcodes and their copies for the loaders.
  const cubes = rows.map((row) => {
    const config = JSON.parse(row.config_json || "{}") as { setNames?: string[]; customCardIds?: number[] };
    const mainCards = mainByCube.get(row.id) ?? [];
    return {
      id: row.id,
      name: row.name,
      archetype: row.archetype,
      banlist: row.banlist,
      draftType: cubeDraftTypeOf(row.config_json),
      createdByUserId: row.created_by_user_id,
      createdByName: row.created_by_name ?? null,
      canEdit: row.created_by_user_id === actor.userId,
      mainCount: mainCards.length,
      extraCount: extraCountByCube.get(row.id) ?? 0,
      setNames: Array.isArray(config.setNames) ? config.setNames : [],
      customCardIds: Array.isArray(config.customCardIds) ? config.customCardIds : [],
      mainCards,
    };
  });

  return NextResponse.json({ cubes, themeDraftsEnabled: themeDraftsEnabled() });
}

export async function POST(request: Request) {
  const actor = await requireWebAccess();
  if (!actor.ok) return actor.response;
  if (!env.discordGuildId) {
    return NextResponse.json({ error: "Server not configured for cubes" }, { status: 500 });
  }

  const body = (await request.json().catch(() => ({}))) as {
    kind?: "blank" | "archetype" | "pool" | "list";
    importText?: unknown;
    cards?: unknown;
    extraCards?: unknown;
    copyExtraFromCubeId?: unknown;
    name?: string;
    archetype?: string;
    banlist?: string;
    config?: DraftConfig;
    draftType?: string;
  };
  const draftType = body.draftType === undefined ? null : parseCubeDraftType(body.draftType);
  if (body.draftType !== undefined && !draftType) {
    return NextResponse.json({ error: "draftType must be theme, booster or any" }, { status: 400 });
  }

  const db = getDb();
  const catalog = createCardCatalogService(db);
  const cubes = createCubeService(db, catalog);
  const guildId = env.discordGuildId;
  const isListImport = body.importText !== undefined || body.kind === "list";

  try {
    if (isListImport) {
      if ((body.kind !== undefined && body.kind !== "list" && body.kind !== "blank")
        || body.config !== undefined || body.cards !== undefined || body.extraCards !== undefined || body.copyExtraFromCubeId !== undefined
        || body.archetype !== undefined || body.banlist !== undefined) {
        return NextResponse.json({ error: "importText cannot be combined with another cube source." }, { status: 400 });
      }
      const name = typeof body.name === "string" ? body.name.trim() : "";
      if (!name) return NextResponse.json({ error: "name is required" }, { status: 400 });
      if (db.prepare("select 1 from cubes where guild_id = ? and lower(name) = lower(?)").get(guildId, name)) {
        throw new CubeNameTakenError(name);
      }
      const { entries, unknown, corrected, lookupLimited } = await prepareCubeListImport(catalog, body.importText);
      if (entries.length === 0) {
        return NextResponse.json({ error: "No cards found in that list.", added: 0, copies: 0, unknown, corrected, ...(lookupLimited ? { lookupLimited } : {}) }, { status: 400 });
      }
      const result = db.transaction(() => {
        const created = cubes.createWithCards(guildId, name, actor.userId, []);
        const result = cubes.importResolvedCards(created.id, entries);
        if (draftType) setCubeDraftType(db, created.id, draftType);
        return { cube: withDraftType(db, created.id, cubes.findCube(created.id)), ...result };
      })();
      return NextResponse.json({ ...result, unknown, corrected, ...(lookupLimited ? { lookupLimited } : {}) }, { status: 201 });
    }
    if (body.kind === "archetype") {
      const archetype = body.archetype?.trim();
      if (!archetype) {
        return NextResponse.json({ error: "archetype is required" }, { status: 400 });
      }
      const cube = await cubes.createFromArchetype(guildId, archetype, actor.userId, {
        name: body.name?.trim() || archetype,
        banlist: body.banlist,
      });
      if (draftType) setCubeDraftType(db, cube.id, draftType);
      return NextResponse.json({ cube: withDraftType(db, cube.id, cube) }, { status: 201 });
    }

    const name = body.name?.trim();
    if (!name) {
      return NextResponse.json({ error: "name is required" }, { status: 400 });
    }

    if (body.kind === "pool") {
      const parsed = parsePoolEntries(body.cards);
      if ("error" in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 });
      const extra = body.extraCards === undefined ? undefined : parsePoolEntries(body.extraCards);
      if (extra && "error" in extra) return NextResponse.json({ error: extra.error }, { status: 400 });
      const entries = [...parsed.entries, ...(extra?.entries ?? []).map((e) => ({ ...e, pool: "extra" as const }))];
      const taken = db
        .prepare("select id from cubes where guild_id = ? and lower(name) = lower(?)")
        .get(guildId, name);
      if (taken) {
        return NextResponse.json({ error: `A cube named "${name}" already exists` }, { status: 409 });
      }
      const lookupBudget = createCardLookupBudget();
      const unknownIds = await ensureCatalogCards(catalog, entries.map((e) => e.id), lookupBudget);
      const unknown = new Set(unknownIds);
      const copyFrom =
        extra === undefined && typeof body.copyExtraFromCubeId === "number" && Number.isSafeInteger(body.copyExtraFromCubeId)
          ? body.copyExtraFromCubeId
          : undefined;
      const cube = cubes.createWithCards(
        guildId,
        name,
        actor.userId,
        entries.filter((e) => !unknown.has(e.id)),
        { copyExtraFromCubeId: copyFrom },
      );
      if (draftType) setCubeDraftType(db, cube.id, draftType);
      return NextResponse.json({ cube: withDraftType(db, cube.id, cube), unknownIds, ...(lookupBudget.lookupLimited ? { lookupLimited: true } : {}) }, { status: 201 });
    }

    // Saving a pool (setNames / customCardIds) from the cube-draft create form or
    // settings: store it as a config-backed cube. Reject duplicates by name.
    if (body.config && body.kind !== "blank") {
      const existing = db
        .prepare("select id from cubes where guild_id = ? and name = ?")
        .get(guildId, name) as { id: number } | undefined;
      if (existing) {
        return NextResponse.json({ error: `A cube named "${name}" already exists` }, { status: 409 });
      }
      const incoming = body.config as { setNames?: unknown; customCardIds?: unknown };
      const setNames = Array.isArray(incoming.setNames)
        ? incoming.setNames.filter((s): s is string => typeof s === "string")
        : [];
      const customCardIds = Array.isArray(incoming.customCardIds)
        ? incoming.customCardIds.filter((n): n is number => Number.isInteger(n))
        : [];
      if (body.config.customExtraCardIds !== undefined) {
        const invalid = boosterDraftConfigError({ customExtraCardIds: body.config.customExtraCardIds });
        if (invalid) return NextResponse.json({ error: invalid }, { status: 400 });
        const counts = new Map<number, number>();
        for (const id of body.config.customExtraCardIds) counts.set(id, (counts.get(id) ?? 0) + 1);
        const parsed = parsePoolEntries([...counts].map(([id, copies]) => ({ id, copies })));
        if ("error" in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 });
        const lookupBudget = createCardLookupBudget();
        const unknownIds = await ensureCatalogCards(catalog, parsed.entries.map((e) => e.id), lookupBudget);
        const unknown = new Set(unknownIds);
        const createdByUserId = actor.userId;
        const cube = db.transaction(() => {
          const created = cubes.createWithCards(guildId, name, createdByUserId,
            parsed.entries.filter((e) => !unknown.has(e.id)).map((e) => ({ ...e, pool: "extra" })));
          const config = { setNames, customCardIds };
          db.prepare("update cubes set config_json = ? where id = ?").run(JSON.stringify(config), created.id);
          if (draftType) setCubeDraftType(db, created.id, draftType);
          return { ...created, config };
        })();
        return NextResponse.json({ cube: withDraftType(db, cube.id, cube), unknownIds, ...(lookupBudget.lookupLimited ? { lookupLimited: true } : {}) }, { status: 201 });
      }
      const cube = cubes.save(guildId, name, { setNames, customCardIds }, actor.userId);
      if (draftType) setCubeDraftType(db, cube.id, draftType);
      return NextResponse.json({ cube: withDraftType(db, cube.id, cube) }, { status: 201 });
    }

    const cube = cubes.createBlank(guildId, name, actor.userId);
    if (draftType) setCubeDraftType(db, cube.id, draftType);
    return NextResponse.json({ cube: withDraftType(db, cube.id, cube) }, { status: 201 });
  } catch (error) {
    const fetchFailure = cardFetchErrorResponse(error);
    if (fetchFailure) return fetchFailure;
    // CubeNameTakenError: another save took the name after the early check above.
    const message = error instanceof Error ? error.message : "Failed to create cube";
    return NextResponse.json({ error: message }, { status: isListImport && !(error instanceof CubeNameTakenError) ? 400 : 409 });
  }
}
