import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { env } from "@/lib/env";
import { createCardCatalogService, createCubeService } from "@yugidraft/shared/services";
import type { DraftConfig } from "@yugidraft/shared/types";

export const runtime = "nodejs";

type CubeRow = {
  id: number;
  guild_id: string;
  name: string;
  archetype: string | null;
  banlist: string | null;
  config_json: string;
};

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!env.discordGuildId) {
    return NextResponse.json({ error: "Server not configured for cubes" }, { status: 500 });
  }

  const db = getDb();
  const rows = db
    .prepare("select id, guild_id, name, archetype, banlist, config_json from cubes where guild_id = ? order by name asc")
    .all(env.discordGuildId) as CubeRow[];

  const counts = db.prepare(
    "select pool, count(*) as n from cube_cards where cube_id = ? group by pool",
  );

  // One shape serves both the Cubes library (main/extra counts) and the saved-pool
  // loaders in the cube-draft create form / settings (setNames + customCardIds).
  const cubes = rows.map((row) => {
    const poolCounts = counts.all(row.id) as Array<{ pool: string; n: number }>;
    const config = JSON.parse(row.config_json || "{}") as { setNames?: string[]; customCardIds?: number[] };
    return {
      id: row.id,
      name: row.name,
      archetype: row.archetype,
      banlist: row.banlist,
      mainCount: poolCounts.find((p) => p.pool === "main")?.n ?? 0,
      extraCount: poolCounts.find((p) => p.pool === "extra")?.n ?? 0,
      setNames: Array.isArray(config.setNames) ? config.setNames : [],
      customCardIds: Array.isArray(config.customCardIds) ? config.customCardIds : [],
    };
  });

  return NextResponse.json({ cubes });
}

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!env.discordGuildId) {
    return NextResponse.json({ error: "Server not configured for cubes" }, { status: 500 });
  }

  const body = (await request.json().catch(() => ({}))) as {
    kind?: "blank" | "archetype";
    name?: string;
    archetype?: string;
    banlist?: string;
    includeStaples?: boolean;
    extraTarget?: number;
    config?: DraftConfig;
  };

  const db = getDb();
  const catalog = createCardCatalogService(db);
  const cubes = createCubeService(db, catalog);
  const guildId = env.discordGuildId;

  try {
    if (body.kind === "archetype") {
      const archetype = body.archetype?.trim();
      if (!archetype) {
        return NextResponse.json({ error: "archetype is required" }, { status: 400 });
      }
      const cube = await cubes.createFromArchetype(guildId, archetype, session.user.id, {
        name: body.name?.trim() || archetype,
        banlist: body.banlist,
        includeStaples: body.includeStaples ?? false,
        extraTarget: typeof body.extraTarget === "number" ? body.extraTarget : undefined,
      });
      return NextResponse.json({ cube }, { status: 201 });
    }

    const name = body.name?.trim();
    if (!name) {
      return NextResponse.json({ error: "name is required" }, { status: 400 });
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
      const cube = cubes.save(guildId, name, { setNames, customCardIds }, session.user.id);
      return NextResponse.json({ cube }, { status: 201 });
    }

    const cube = cubes.createBlank(guildId, name, session.user.id);
    return NextResponse.json({ cube }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to create cube";
    return NextResponse.json({ error: message }, { status: 409 });
  }
}
