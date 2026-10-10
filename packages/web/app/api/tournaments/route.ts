import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { requireWebAccess } from "@/lib/web-access";
import { env } from "@/lib/env";
import { findTournamentListPage, InvalidListCursorError, createPlayerService, createTournamentService, TournamentDuelError, isTournamentVisibility } from "@yugidraft/shared/services";

const VALID_FORMATS = ["round_robin", "single_elim"] as const;

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const actor = await requireWebAccess();
    if (!actor.ok) return actor.response;
    const cursor = new URL(request.url).searchParams.get("cursor");
    return NextResponse.json(findTournamentListPage(getDb(), env.discordGuildId, actor.userId, cursor));
  } catch (error) {
    if (error instanceof InvalidListCursorError) return NextResponse.json({ error: error.message }, { status: 400 });
    console.error("[api/tournaments] error:", error);
    return NextResponse.json({ error: "Failed to load tournaments" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const actor = await requireWebAccess();
  if (!actor.ok) return actor.response;

  const body = await request.json();
  const { name, format } = body as { name: string; format: string };
  const visibility = body.visibility === undefined ? "private" : body.visibility;
  if (!isTournamentVisibility(visibility)) return NextResponse.json({ error: "visibility must be open or private" }, { status: 400 });

  if (!name || !format) {
    return NextResponse.json(
      { error: "name and format are required" },
      { status: 400 }
    );
  }

  if (!VALID_FORMATS.includes(format as any)) {
    return NextResponse.json(
      { error: "format must be round_robin or single_elim" },
      { status: 400 }
    );
  }

  const { deadlineAt, reportConfirmWindowHours, bestOf, duelRules } = body as {
    deadlineAt?: string | null;
    reportConfirmWindowHours?: number | null;
    bestOf?: 1 | 3;
    duelRules?: { mode?: unknown; masterRule?: unknown; settings?: unknown } | null;
  };

  if (bestOf != null && bestOf !== 1 && bestOf !== 3) {
    return NextResponse.json({ error: "bestOf must be 1 or 3" }, { status: 400 });
  }
  if (duelRules != null && (typeof duelRules !== "object" || Array.isArray(duelRules))) {
    return NextResponse.json({ error: "duelRules must be an object" }, { status: 400 });
  }

  if (deadlineAt != null) {
    const ts = Date.parse(deadlineAt);
    if (Number.isNaN(ts) || ts <= Date.now()) {
      return NextResponse.json({ error: "deadline must be a valid future date" }, { status: 400 });
    }
  }

  if (reportConfirmWindowHours != null) {
    if (
      !Number.isInteger(reportConfirmWindowHours) ||
      reportConfirmWindowHours < 1 ||
      reportConfirmWindowHours > 720
    ) {
      return NextResponse.json(
        { error: "confirm window must be an integer between 1 and 720 hours" },
        { status: 400 }
      );
    }
  }

  const guildId = env.discordGuildId;
  if (!guildId) {
    return NextResponse.json(
      { error: "Server not configured for tournament creation" },
      { status: 500 }
    );
  }

  try {
    const db = getDb();
    const players = createPlayerService(db);
    const organizerPlayer = players.findOrCreate(guildId, actor.userId, actor.userName);

    const tournaments = createTournamentService(db);
    const tournament = tournaments.create(
      guildId,
      name,
      format as "round_robin" | "single_elim",
      actor.userId,
      {
        visibility,
        deadlineAt: deadlineAt ?? null,
        reportConfirmWindowHours: reportConfirmWindowHours ?? null,
        bestOf: bestOf ?? undefined,
        duelRules: duelRules ?? null,
      },
    );
    tournaments.join(tournament.id, organizerPlayer.id);

    return NextResponse.json(
      {
        id: tournament.id,
        name: tournament.name,
        format: tournament.format,
        status: tournament.status,
        visibility: tournament.visibility,
        webSlug: tournament.webSlug,
      },
      { status: 201 }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to create tournament";
    console.error("[api/tournaments POST] error:", error);
    return NextResponse.json({ error: message }, { status: error instanceof TournamentDuelError ? error.status : 400 });
  }
}
