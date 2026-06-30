import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { env } from "@/lib/env";
import { createCardCatalogService, createCubeService } from "@yugidraft/shared/services";
import { cubeDetail } from "@/lib/cube-detail";

export const runtime = "nodejs";

async function authCubeId(
  params: Promise<{ id: string }>,
): Promise<{ cubeId: number; guildId: string } | NextResponse> {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!env.discordGuildId) {
    return NextResponse.json({ error: "Server not configured for cubes" }, { status: 500 });
  }
  const { id } = await params;
  const cubeId = Number(id);
  if (!Number.isInteger(cubeId)) {
    return NextResponse.json({ error: "Invalid cube id" }, { status: 400 });
  }
  return { cubeId, guildId: env.discordGuildId };
}

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await authCubeId(params);
  if (ctx instanceof NextResponse) return ctx;

  const db = getDb();
  const catalog = createCardCatalogService(db);
  const cubes = createCubeService(db, catalog);
  const cube = db
    .prepare("select id, guild_id, name, archetype, banlist, created_by_user_id from cubes where id = ? and guild_id = ?")
    .get(ctx.cubeId, ctx.guildId) as
    | { id: number; guild_id: string; name: string; archetype: string | null; banlist: string | null; created_by_user_id: string }
    | undefined;
  if (!cube) {
    return NextResponse.json({ error: "Cube not found" }, { status: 404 });
  }

  return NextResponse.json({
    cube: {
      id: cube.id,
      guildId: cube.guild_id,
      name: cube.name,
      archetype: cube.archetype,
      banlist: cube.banlist,
      createdByUserId: cube.created_by_user_id,
    },
    ...cubeDetail(ctx.cubeId, cubes, catalog),
  });
}

export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await authCubeId(params);
  if (ctx instanceof NextResponse) return ctx;

  const body = (await request.json().catch(() => ({}))) as { name?: string };

  const db = getDb();
  const cubes = createCubeService(db, createCardCatalogService(db));
  const result = cubes.renameCube(ctx.cubeId, body.name ?? "");
  if ("error" in result) {
    const status = result.error === "Cube not found" ? 404 : result.error === "name is required" ? 400 : 409;
    return NextResponse.json({ error: result.error }, { status });
  }
  return NextResponse.json({ ok: true });
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await authCubeId(params);
  if (ctx instanceof NextResponse) return ctx;

  const db = getDb();
  const exists = db.prepare("select id from cubes where id = ? and guild_id = ?").get(ctx.cubeId, ctx.guildId);
  if (!exists) {
    return NextResponse.json({ error: "Cube not found" }, { status: 404 });
  }
  createCubeService(db, createCardCatalogService(db)).deleteCube(ctx.cubeId);
  return NextResponse.json({ ok: true });
}
