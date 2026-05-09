import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { auth } from "@/lib/auth";
import { env } from "@/lib/env";
import { createDraftService } from "@yugidraft/shared/services";
import { buildDraftResponse } from "../helpers";
import { notifyWs } from "@/lib/notify-ws";

export const runtime = "nodejs";

const DRAFT_STATUS = {
  completed: "completed",
} as const;

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json();
    const { cardId } = body as { cardId?: unknown };

    if (cardId === undefined || cardId === null || typeof cardId !== "number" || !Number.isInteger(cardId)) {
      return NextResponse.json({ error: "cardId is required and must be an integer" }, { status: 400 });
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

    const player = db
      .prepare("select id from players where guild_id = ? and discord_user_id = ?")
      .get(draft.guild_id, session.user.id) as { id: number } | undefined;

    if (!player) {
      return NextResponse.json({ error: "You are not a participant in this draft" }, { status: 400 });
    }

    if (draft.status !== "active") {
      return NextResponse.json({ error: "Draft is not active" }, { status: 400 });
    }

    const drafts = createDraftService(db);

    // alreadyPicked: true means auto-pick fired inside the transaction before the manual pick ran — that's fine, continue normally
    const { alreadyPicked: _alreadyPicked } = drafts.recordManualPick(draft.id, player.id, cardId);
    const currentStep = drafts.findById(draft.id);

    // Auto-pick for fake players and dev bots who haven't picked yet this step
    const fakePlayers = db
      .prepare(
        `SELECT dp.player_id FROM draft_players dp
         INNER JOIN players p ON p.id = dp.player_id
         WHERE dp.draft_id = ?
           AND (p.discord_user_id LIKE 'fake_%' OR p.discord_user_id LIKE 'bot_%')`
      )
      .all(draft.id) as Array<{ player_id: number }>;

    for (const fake of fakePlayers) {
      const hasPicked = db
        .prepare(
          `SELECT id FROM draft_picks
           WHERE draft_id = ? AND player_id = ? AND wave_number = ? AND pick_step = ?`
        )
        .get(draft.id, fake.player_id, currentStep.currentPackRound, currentStep.currentPickStep);

      if (!hasPicked) {
        const options = drafts.currentPackOptions(draft.id, fake.player_id);
        if (options.length > 0) {
          const randomCard = options[Math.floor(Math.random() * options.length)];
          drafts.pickCard(draft.id, fake.player_id, randomCard.id, "auto");
        }
      }
    }

    const wsCfg = { url: env.wsInternalUrl, secret: env.wsInternalSecret };

    void notifyWs(wsCfg, {
      kind: "pick",
      slug,
      playerId: player.id,
      packRound: currentStep.currentPackRound,
      pickStep: currentStep.currentPickStep,
    });

    const after = drafts.findById(draft.id);
    if (after.status === DRAFT_STATUS.completed) {
      void notifyWs(wsCfg, { kind: "complete", slug });
    } else if (
      after.currentPackRound !== currentStep.currentPackRound ||
      after.currentPickStep !== currentStep.currentPickStep
    ) {
      void notifyWs(wsCfg, {
        kind: "resync",
        slug,
        packRound: after.currentPackRound,
        pickStep: after.currentPickStep,
      });
    }

    // Return updated draft state
    const response = await buildDraftResponse(slug, session.user.id);

    if (!response) {
      return NextResponse.json({ error: "Draft not found" }, { status: 404 });
    }

    return NextResponse.json(response);
  } catch (error) {
    if (error instanceof Error) {
      console.error("[api/drafts/[slug]/pick] error:", error.message);
      return NextResponse.json({ error: error.message }, { status: 400 });
    }

    console.error("[api/drafts/[slug]/pick] unexpected error:", error);
    return NextResponse.json(
      { error: "Failed to pick card" },
      { status: 500 }
    );
  }
}
