import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { auth } from "@/lib/auth";
import { env } from "@/lib/env";
import { createDraftService, createPlayerService } from "@yugidraft/shared/services";
import { broadcaster } from "@/lib/notify";

export const runtime = "nodejs";

const BOT_DISCORD_PREFIX = "bot_player_dev_";

function nextBotSlot(
  db: ReturnType<typeof getDb>,
  draftId: number,
): { discordId: string; displayName: string } {
  const rows = db
    .prepare(
      `select p.discord_user_id as discordId
         from draft_players dp
         join players p on p.id = dp.player_id
        where dp.draft_id = ? and p.discord_user_id like ?`,
    )
    .all(draftId, `${BOT_DISCORD_PREFIX}%`) as { discordId: string }[];

  const taken = new Set(rows.map((r) => r.discordId));
  let index = 1;
  while (taken.has(`${BOT_DISCORD_PREFIX}${index}`)) {
    index += 1;
  }

  return {
    discordId: `${BOT_DISCORD_PREFIX}${index}`,
    displayName: `Bot ${index}`,
  };
}

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

    const slot = nextBotSlot(db, draft.id);
    const players = createPlayerService(db);
    const bot = players.findOrCreate(guildId, slot.discordId, slot.displayName);

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
