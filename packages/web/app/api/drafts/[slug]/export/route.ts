import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { auth } from "@/lib/auth";
import { createDraftService } from "@yugidraft/shared/services";

export const runtime = "nodejs";

export async function GET(
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

    const draft = db
      .prepare("select id from drafts where web_slug = ?")
      .get(slug) as { id: number } | undefined;

    if (!draft) {
      return NextResponse.json({ error: "Draft not found" }, { status: 404 });
    }

    const player = db
      .prepare(
        "select p.id as player_id from draft_players dp inner join players p on p.id = dp.player_id where dp.draft_id = ? and p.discord_user_id = ?"
      )
      .get(draft.id, session.user.id) as { player_id: number } | undefined;

    if (!player) {
      return NextResponse.json({ error: "Not a participant" }, { status: 403 });
    }

    const drafts = createDraftService(db);
    const ydk = drafts.exportYdk(draft.id, player.player_id);

    return new NextResponse(ydk, {
      headers: {
        "Content-Type": "text/plain",
        "Content-Disposition": `attachment; filename="draft-${draft.id}.ydk"`,
      },
    });
  } catch (error) {
    console.error("[api/drafts/[slug]/export] error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to export" },
      { status: 400 }
    );
  }
}