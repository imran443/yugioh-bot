import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { env } from "@/lib/env";
import { createCardCatalogService, createThemesService } from "@yugidraft/shared/services";
import { themeDetail } from "@/lib/theme-detail";

export const runtime = "nodejs";

type Op =
  | { op: "add"; catalogCardId: number; pool: "main" | "extra"; maxCopies?: number }
  | { op: "remove"; catalogCardId: number }
  | { op: "setMaxCopies"; catalogCardId: number; maxCopies: number }
  | { op: "import"; codes: number[]; pool?: "main" | "extra" }
  | { op: "seedArchetype"; archetype: string; banlist?: string };

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!env.discordGuildId) {
    return NextResponse.json({ error: "Server not configured for themes" }, { status: 500 });
  }

  const { id } = await params;
  const themeId = Number(id);
  if (!Number.isInteger(themeId)) {
    return NextResponse.json({ error: "Invalid theme id" }, { status: 400 });
  }

  const db = getDb();
  const owner = db
    .prepare("select guild_id from themes where id = ?")
    .get(themeId) as { guild_id: string } | undefined;
  if (!owner || owner.guild_id !== env.discordGuildId) {
    return NextResponse.json({ error: "Theme not found" }, { status: 404 });
  }

  const catalog = createCardCatalogService(db);
  const themes = createThemesService(db, catalog);
  const body = (await request.json().catch(() => ({}))) as Op;

  try {
    switch (body.op) {
      case "add":
        themes.addCard(themeId, body.catalogCardId, body.pool, body.maxCopies);
        break;
      case "remove":
        themes.removeCard(themeId, body.catalogCardId);
        break;
      case "setMaxCopies":
        themes.setMaxCopies(themeId, body.catalogCardId, body.maxCopies);
        break;
      case "import": {
        const codes = Array.isArray(body.codes)
          ? body.codes.filter((n): n is number => Number.isInteger(n))
          : [];
        const result = await themes.importPasscodes(themeId, codes, { pool: body.pool });
        return NextResponse.json({ ...themeDetail(themeId, themes, catalog), ...result });
      }
      case "seedArchetype": {
        const archetype = body.archetype?.trim();
        if (!archetype) {
          return NextResponse.json({ error: "archetype is required" }, { status: 400 });
        }
        const result = await themes.seedArchetypeInto(themeId, archetype, { banlist: body.banlist });
        return NextResponse.json({ ...themeDetail(themeId, themes, catalog), ...result });
      }
      default:
        return NextResponse.json({ error: "Unknown op" }, { status: 400 });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Theme update failed";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  return NextResponse.json(themeDetail(themeId, themes, catalog));
}
