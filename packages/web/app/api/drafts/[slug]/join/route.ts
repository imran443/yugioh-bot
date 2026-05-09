import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { auth } from "@/lib/auth";
import { env } from "@/lib/env";
import { createDraftService, createPlayerService } from "@yugidraft/shared/services";
import { notifyWs } from "@/lib/notify-ws";

export const runtime = "nodejs";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ slug: string }> }
) {
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

    const draftGuildId = draft.guild_id || env.discordGuildId;
    if (!draftGuildId) {
      return NextResponse.json({ error: "Server not configured" }, { status: 500 });
    }

    const players = createPlayerService(db);
    const player = players.findOrCreate(draftGuildId, session.user.id, session.user.name ?? "Unknown");

    const drafts = createDraftService(db);
    drafts.join(draft.id, player.id);

    void notifyWs(
      { url: env.wsInternalUrl, secret: env.wsInternalSecret },
      { kind: "seats", slug },
    );

    return NextResponse.json({ success: true, playerId: player.id, displayName: player.displayName });
  } catch (error) {
    if (error instanceof Error) {
      if (error.message === "You have already joined this draft") {
        return NextResponse.json({ error: "You have already joined this draft" }, { status: 400 });
      }
      if (error.message === "Player must belong to the same guild as the draft") {
        return NextResponse.json({ error: "You must belong to this server to join" }, { status: 403 });
      }
    }
    console.error("[api/drafts/[slug]/join] error:", error);
    return NextResponse.json(
      { error: "Failed to join draft" },
      { status: 500 }
    );
  }
}
