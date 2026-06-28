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
    return NextResponse.json({ error: "Draft is no longer accepting theme picks" }, { status: 400 });
  }

  const draft = createDraftService(db).findById(draftRow.id);
  if (draft.config.mode !== "theme" || (draft.config.themeSelection ?? "player_pick") !== "player_pick") {
    return NextResponse.json({ error: "This draft does not allow player theme picks" }, { status: 400 });
  }

  const player = db
    .prepare("select id from players where guild_id = ? and discord_user_id = ?")
    .get(guildId, session.user.id) as { id: number } | undefined;
  if (!player) {
    return NextResponse.json({ error: "Join the draft first" }, { status: 400 });
  }

  const body = (await request.json().catch(() => ({}))) as { themeId?: number };
  const themeId = body.themeId;
  if (!Number.isInteger(themeId) || !(draft.config.allowedThemeIds ?? []).includes(themeId as number)) {
    return NextResponse.json({ error: "Theme is not allowed for this draft" }, { status: 400 });
  }

  if (draft.config.uniqueThemes ?? true) {
    const taken = db
      .prepare("select 1 from draft_player_theme where draft_id = ? and theme_id = ? and player_id != ?")
      .get(draftRow.id, themeId, player.id);
    if (taken) {
      return NextResponse.json({ error: "That theme is already taken" }, { status: 409 });
    }
  }

  db.prepare(
    `insert into draft_player_theme (draft_id, player_id, theme_id) values (?, ?, ?)
     on conflict (draft_id, player_id) do update set theme_id = excluded.theme_id`,
  ).run(draftRow.id, player.id, themeId);

  return NextResponse.json({ ok: true, themeId });
}
