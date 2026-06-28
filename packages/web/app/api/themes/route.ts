import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { env } from "@/lib/env";
import { createCardCatalogService, createThemesService } from "@yugidraft/shared/services";

export const runtime = "nodejs";

type ThemeRow = {
  id: number;
  guild_id: string;
  name: string;
  archetype: string | null;
  banlist: string | null;
};

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!env.discordGuildId) {
    return NextResponse.json({ error: "Server not configured for themes" }, { status: 500 });
  }

  const db = getDb();
  const rows = db
    .prepare("select id, guild_id, name, archetype, banlist from themes where guild_id = ? order by name asc")
    .all(env.discordGuildId) as ThemeRow[];

  const counts = db.prepare(
    "select pool, count(*) as n from theme_cards where theme_id = ? group by pool",
  );

  const themes = rows.map((row) => {
    const poolCounts = counts.all(row.id) as Array<{ pool: string; n: number }>;
    return {
      id: row.id,
      name: row.name,
      archetype: row.archetype,
      banlist: row.banlist,
      mainCount: poolCounts.find((p) => p.pool === "main")?.n ?? 0,
      extraCount: poolCounts.find((p) => p.pool === "extra")?.n ?? 0,
    };
  });

  return NextResponse.json({ themes });
}

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!env.discordGuildId) {
    return NextResponse.json({ error: "Server not configured for themes" }, { status: 500 });
  }

  const body = (await request.json().catch(() => ({}))) as {
    kind?: "blank" | "archetype";
    name?: string;
    archetype?: string;
    banlist?: string;
    includeStaples?: boolean;
    extraTarget?: number;
  };

  const db = getDb();
  const catalog = createCardCatalogService(db);
  const themes = createThemesService(db, catalog);
  const guildId = env.discordGuildId;

  try {
    if (body.kind === "archetype") {
      const archetype = body.archetype?.trim();
      if (!archetype) {
        return NextResponse.json({ error: "archetype is required" }, { status: 400 });
      }
      const theme = await themes.createFromArchetype(guildId, archetype, session.user.id, {
        name: body.name?.trim() || archetype,
        banlist: body.banlist,
        includeStaples: body.includeStaples ?? false,
        extraTarget: typeof body.extraTarget === "number" ? body.extraTarget : undefined,
      });
      return NextResponse.json({ theme }, { status: 201 });
    }

    const name = body.name?.trim();
    if (!name) {
      return NextResponse.json({ error: "name is required" }, { status: 400 });
    }
    const theme = themes.createBlank(guildId, name, session.user.id);
    return NextResponse.json({ theme }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to create theme";
    return NextResponse.json({ error: message }, { status: 409 });
  }
}
