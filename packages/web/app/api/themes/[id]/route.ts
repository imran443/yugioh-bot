import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { env } from "@/lib/env";
import { createCardCatalogService, createThemesService } from "@yugidraft/shared/services";
import { themeDetail } from "@/lib/theme-detail";

export const runtime = "nodejs";

async function authThemeId(
  params: Promise<{ id: string }>,
): Promise<{ themeId: number; guildId: string } | NextResponse> {
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
  return { themeId, guildId: env.discordGuildId };
}

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await authThemeId(params);
  if (ctx instanceof NextResponse) return ctx;

  const db = getDb();
  const catalog = createCardCatalogService(db);
  const themes = createThemesService(db, catalog);
  const theme = db
    .prepare("select id, guild_id, name, archetype, banlist, created_by_user_id from themes where id = ? and guild_id = ?")
    .get(ctx.themeId, ctx.guildId) as
    | { id: number; guild_id: string; name: string; archetype: string | null; banlist: string | null; created_by_user_id: string }
    | undefined;
  if (!theme) {
    return NextResponse.json({ error: "Theme not found" }, { status: 404 });
  }

  return NextResponse.json({
    theme: {
      id: theme.id,
      guildId: theme.guild_id,
      name: theme.name,
      archetype: theme.archetype,
      banlist: theme.banlist,
      createdByUserId: theme.created_by_user_id,
    },
    ...themeDetail(ctx.themeId, themes, catalog),
  });
}

export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await authThemeId(params);
  if (ctx instanceof NextResponse) return ctx;

  const body = (await request.json().catch(() => ({}))) as { name?: string };
  const name = body.name?.trim();
  if (!name) {
    return NextResponse.json({ error: "name is required" }, { status: 400 });
  }

  const db = getDb();
  const dupe = db
    .prepare("select id from themes where guild_id = ? and name = ? and id != ?")
    .get(ctx.guildId, name, ctx.themeId) as { id: number } | undefined;
  if (dupe) {
    return NextResponse.json({ error: `A theme named "${name}" already exists` }, { status: 409 });
  }

  const result = db
    .prepare("update themes set name = ?, updated_at = ? where id = ? and guild_id = ?")
    .run(name, new Date().toISOString(), ctx.themeId, ctx.guildId);
  if (result.changes === 0) {
    return NextResponse.json({ error: "Theme not found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await authThemeId(params);
  if (ctx instanceof NextResponse) return ctx;

  const db = getDb();
  db.prepare("delete from theme_cards where theme_id = ?").run(ctx.themeId);
  const result = db
    .prepare("delete from themes where id = ? and guild_id = ?")
    .run(ctx.themeId, ctx.guildId);
  if (result.changes === 0) {
    return NextResponse.json({ error: "Theme not found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
