import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { auth } from "@/lib/auth";
import { env } from "@/lib/env";
import { createDraftService, createPlayerService } from "@yugidraft/shared/services";
import { broadcaster } from "@/lib/notify";

export const runtime = "nodejs";

const BOT_DISCORD_ID = "bot_player_dev_1";
const BOT_DISPLAY_NAME = "Bot (Dev)";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ slug: string }> }
) {
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { slug } = await params;
    const db = getDb();
    const guildId = env.discordGuildId;

    const draft = db
      .prepare("select id, guild_id, status from drafts where web_slug = ? and guild_id = ?")
      .get(slug, guildId) as { id: number; guild_id: string; status: string } | undefined;

    if (!draft) {
      return NextResponse.json({ error: "Draft not found" }, { status: 404 });
    }

    if (draft.status !== "pending") {
      return NextResponse.json({ error: "Draft is no longer accepting players" }, { status: 400 });
    }

    const players = createPlayerService(db);
    const bot = players.findOrCreate(guildId, BOT_DISCORD_ID, BOT_DISPLAY_NAME);

    const drafts = createDraftService(db);
    drafts.join(draft.id, bot.id);

    void broadcaster.draft(
      { kind: "seats", slug },
    );

    return NextResponse.json({ success: true, playerId: bot.id, displayName: bot.displayName });
  } catch (error) {
    if (error instanceof Error && error.message === "You have already joined this draft") {
      return NextResponse.json({ error: "Bot has already joined this draft" }, { status: 400 });
    }
    console.error("[api/drafts/[slug]/join-bot] error:", error);
    return NextResponse.json({ error: "Failed to add bot to draft" }, { status: 500 });
  }
}
