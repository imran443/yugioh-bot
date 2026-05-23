import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { auth } from "@/lib/auth";
import { env } from "@/lib/env";
import { createTournamentService, createGuildSettingsService } from "@yugidraft/shared/services";
import { announcer } from "@/lib/notify";

export const runtime = "nodejs";

function resolveChannelId(db: ReturnType<typeof getDb>, guildId: string): string {
  const settings = createGuildSettingsService(db).get(guildId);
  return settings.announceChannelId ?? env.discordDefaultChannelId;
}

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

    const tournament = db
      .prepare("select id, guild_id, name, format, status, created_by_user_id, web_slug from tournaments where web_slug = ?")
      .get(slug) as
      | { id: number; guild_id: string; name: string; format: string; status: string; created_by_user_id: string; web_slug: string }
      | undefined;

    if (!tournament) {
      return NextResponse.json({ error: "Tournament not found" }, { status: 404 });
    }

    if (tournament.created_by_user_id !== session.user.id) {
      return NextResponse.json({ error: "Only the organizer can announce" }, { status: 403 });
    }

    if (tournament.status !== "pending") {
      return NextResponse.json({ error: "Can only announce pending tournaments" }, { status: 400 });
    }

    const channelId = resolveChannelId(db, tournament.guild_id);
    if (!channelId) {
      return NextResponse.json(
        { error: "Configure an announcement channel in guild settings first" },
        { status: 400 },
      );
    }

    const tournaments = createTournamentService(db);
    const participantCount = tournaments.participantCount(tournament.id);

    const result = await announcer.announce(
      {
        kind: "tournament-created",
        tournamentId: tournament.id,
        channelId,
        name: tournament.name,
        format: tournament.format,
        webSlug: tournament.web_slug,
        organizerUserId: tournament.created_by_user_id,
        participantCount,
      },
    );

    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: 502 });
    }

    return NextResponse.json({ success: true, channelId });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to announce";
    console.error("[api/tournaments/[slug]/announce] error:", error);
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
