import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { env } from "@/lib/env";
import { createCardCatalogService, createDraftService, createCubeService } from "@yugidraft/shared/services";

export const runtime = "nodejs";

async function loadDraft(slug: string) {
  const db = getDb();
  const guildId = env.discordGuildId;
  const row = db
    .prepare("select id, status, created_by_user_id from drafts where web_slug = ? and guild_id = ?")
    .get(slug, guildId) as { id: number; status: string; created_by_user_id: string } | undefined;
  return { db, guildId, row };
}

function persistAllowedCubeIds(db: ReturnType<typeof getDb>, draftId: number, allowedCubeIds: number[]) {
  const drafts = createDraftService(db);
  const draft = drafts.findById(draftId);
  const nextConfig = { ...draft.config, allowedCubeIds };
  db.prepare("update drafts set config_json = ? where id = ?").run(JSON.stringify(nextConfig), draftId);
}

export async function POST(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { slug } = await params;
  const { db, row } = await loadDraft(slug);
  if (!row) {
    return NextResponse.json({ error: "Draft not found" }, { status: 404 });
  }
  if (row.created_by_user_id !== session.user.id) {
    return NextResponse.json({ error: "Only the host can edit cubes" }, { status: 403 });
  }
  if (row.status !== "pending") {
    return NextResponse.json({ error: "Cubes can only be edited before the draft starts" }, { status: 400 });
  }

  const guildId = env.discordGuildId!;
  const drafts = createDraftService(db);
  const draft = drafts.findById(row.id);
  const catalog = createCardCatalogService(db);
  const cubes = createCubeService(db, catalog);

  const body = (await request.json().catch(() => ({}))) as {
    kind?: "archetype" | "blank" | "existing";
    archetype?: string;
    name?: string;
    cubeId?: number;
  };

  try {
    let cube;
    if (body.kind === "archetype") {
      const archetype = body.archetype?.trim();
      if (!archetype) {
        return NextResponse.json({ error: "archetype is required" }, { status: 400 });
      }
      cube = await cubes.createFromArchetype(guildId, archetype, session.user.id, {
        name: archetype,
        includeStaples: true,
      });
    } else if (body.kind === "existing") {
      // Attach an existing library cube to this draft (does not create a new one).
      if (!Number.isInteger(body.cubeId)) {
        return NextResponse.json({ error: "cubeId is required" }, { status: 400 });
      }
      const owned = db
        .prepare("select id from cubes where id = ? and guild_id = ?")
        .get(body.cubeId, guildId) as { id: number } | undefined;
      if (!owned) {
        return NextResponse.json({ error: "Cube not found" }, { status: 404 });
      }
      if ((draft.config.allowedCubeIds ?? []).includes(owned.id)) {
        return NextResponse.json({ error: "That cube is already in this draft" }, { status: 409 });
      }
      cube = cubes.findCube(owned.id);
    } else {
      const name = body.name?.trim();
      if (!name) {
        return NextResponse.json({ error: "name is required" }, { status: 400 });
      }
      cube = cubes.createBlank(guildId, name, session.user.id);
    }

    const allowedCubeIds = [...(draft.config.allowedCubeIds ?? []), cube.id];
    persistAllowedCubeIds(db, row.id, allowedCubeIds);

    const pools = cubes.getCubePools(cube.id);
    return NextResponse.json(
      {
        cube: {
          id: cube.id,
          name: cube.name,
          archetype: cube.archetype,
          mainCount: pools.main.length,
          extraCount: pools.extra.length,
        },
        allowedCubeIds,
      },
      { status: 201 },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to add cube";
    // Network/API failures (unreachable card DB) surface as 502 so the UI can suggest passcode import.
    const status = /reach the card database|YGOPRODeck/i.test(message) ? 502 : 400;
    return NextResponse.json({ error: message }, { status });
  }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { slug } = await params;
  const { db, row } = await loadDraft(slug);
  if (!row) {
    return NextResponse.json({ error: "Draft not found" }, { status: 404 });
  }
  if (row.created_by_user_id !== session.user.id) {
    return NextResponse.json({ error: "Only the host can edit cubes" }, { status: 403 });
  }
  if (row.status !== "pending") {
    return NextResponse.json({ error: "Cubes can only be edited before the draft starts" }, { status: 400 });
  }

  const body = (await request.json().catch(() => ({}))) as { cubeId?: number };
  const cubeId = body.cubeId;
  if (!Number.isInteger(cubeId)) {
    return NextResponse.json({ error: "cubeId is required" }, { status: 400 });
  }

  const drafts = createDraftService(db);
  const draft = drafts.findById(row.id);
  const allowedCubeIds = (draft.config.allowedCubeIds ?? []).filter((id) => id !== cubeId);
  persistAllowedCubeIds(db, row.id, allowedCubeIds);

  // Detach only — the cube stays in the library (delete it from its editor instead).
  db.prepare("delete from draft_player_cube where draft_id = ? and cube_id = ?").run(row.id, cubeId);

  return NextResponse.json({ ok: true, allowedCubeIds });
}
