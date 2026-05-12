import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { auth } from "@/lib/auth";
import { env } from "@/lib/env";
import { createDraftTournamentService } from "@yugidraft/shared/services";

export const runtime = "nodejs";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
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
      .prepare("select id, created_by_user_id, status, tournament_id from drafts where web_slug = ? and guild_id = ?")
      .get(slug, guildId) as {
        id: number;
        created_by_user_id: string;
        status: string;
        tournament_id: number | null;
      } | undefined;

    if (!draft) {
      return NextResponse.json({ error: "Draft not found" }, { status: 404 });
    }

    if (draft.tournament_id !== null) {
      const existing = db
        .prepare("select id, name, web_slug, format from tournaments where id = ?")
        .get(draft.tournament_id) as { id: number; name: string; web_slug: string | null; format: string } | undefined;
      if (existing) {
        return NextResponse.json(
          { id: existing.id, name: existing.name, webSlug: existing.web_slug, format: existing.format },
          { status: 409 },
        );
      }
    }

    const body = await request.json();
    const { format } = body as { format?: string };

    if (!format || (format !== "round_robin" && format !== "single_elim")) {
      return NextResponse.json({ error: "format must be round_robin or single_elim" }, { status: 400 });
    }

    const service = createDraftTournamentService(db);
    const result = service.createTournamentFromDraft({
      draftId: draft.id,
      format,
      createdByUserId: session.user.id,
    });

    const tournament = db
      .prepare("select id, name, web_slug, format from tournaments where id = ?")
      .get(result.tournamentId) as { id: number; name: string; web_slug: string | null; format: string };

    return NextResponse.json(
      { id: tournament.id, name: tournament.name, webSlug: tournament.web_slug, format: tournament.format },
      { status: 201 },
    );
  } catch (error) {
    if (error instanceof Error) {
      if (
        error.message.includes("Only the draft creator") ||
        error.message.includes("must be completed")
      ) {
        return NextResponse.json({ error: error.message }, { status: 403 });
      }
    }
    console.error("[api/drafts/[slug]/tournament POST] error:", error);
    return NextResponse.json({ error: "Failed to create tournament" }, { status: 500 });
  }
}
