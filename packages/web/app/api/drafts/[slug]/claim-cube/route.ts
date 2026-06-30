import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { env } from "@/lib/env";
import { createDraftService } from "@yugidraft/shared/services";

export const runtime = "nodejs";

export async function POST(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { slug } = await params;
  const db = getDb();
  const guildId = env.discordGuildId;

  const draftRow = db
    .prepare("select id, status from drafts where web_slug = ? and guild_id = ?")
    .get(slug, guildId) as { id: number; status: string } | undefined;
  if (!draftRow) {
    return NextResponse.json({ error: "Draft not found" }, { status: 404 });
  }
  if (draftRow.status !== "pending") {
    return NextResponse.json({ error: "Draft is no longer accepting cube picks" }, { status: 400 });
  }

  const draft = createDraftService(db).findById(draftRow.id);
  if (draft.config.mode !== "theme" || (draft.config.themeSelection ?? "player_pick") !== "player_pick") {
    return NextResponse.json({ error: "This draft does not allow player cube picks" }, { status: 400 });
  }

  const player = db
    .prepare("select id from players where guild_id = ? and discord_user_id = ?")
    .get(guildId, session.user.id) as { id: number } | undefined;
  if (!player) {
    return NextResponse.json({ error: "Join the draft first" }, { status: 400 });
  }

  const body = (await request.json().catch(() => ({}))) as { cubeId?: number };
  const cubeId = body.cubeId;
  if (!Number.isInteger(cubeId) || !(draft.config.allowedCubeIds ?? []).includes(cubeId as number)) {
    return NextResponse.json({ error: "Cube is not allowed for this draft" }, { status: 400 });
  }

  if (draft.config.uniqueThemes ?? true) {
    const taken = db
      .prepare("select 1 from draft_player_cube where draft_id = ? and cube_id = ? and player_id != ?")
      .get(draftRow.id, cubeId, player.id);
    if (taken) {
      return NextResponse.json({ error: "That cube is already taken" }, { status: 409 });
    }
  }

  db.prepare(
    `insert into draft_player_cube (draft_id, player_id, cube_id) values (?, ?, ?)
     on conflict (draft_id, player_id) do update set cube_id = excluded.cube_id`,
  ).run(draftRow.id, player.id, cubeId);

  return NextResponse.json({ ok: true, cubeId });
}
