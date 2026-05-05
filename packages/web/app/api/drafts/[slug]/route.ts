import { NextRequest, NextResponse } from "next/server";
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
      .prepare(
        `
        select
          d.id,
          d.guild_id,
          d.channel_id,
          d.name,
          d.status,
          d.created_by_user_id,
          d.config_json,
          d.current_wave_number,
          d.current_pick_step,
          d.pick_deadline_at,
          d.status_message_id,
          d.web_slug,
          d.created_at,
          d.started_at,
          d.ended_at,
          count(dp.player_id) as player_count
        from drafts d
        left join draft_players dp on dp.draft_id = d.id
        where d.web_slug = ?
        group by d.id
      `
      )
      .get(slug) as any;

    if (!draft) {
      return NextResponse.json({ error: "Draft not found" }, { status: 404 });
    }

    const players = db
      .prepare(
        `
        select p.id as player_id, p.display_name, dp.seat_index, dp.pick_count, dp.finished_at, dp.joined_at
        from draft_players dp
        inner join players p on p.id = dp.player_id
        where dp.draft_id = ?
        order by dp.joined_at asc, dp.rowid asc
      `
      )
      .all(draft.id)
      .map((row: any) => ({
        playerId: row.player_id,
        displayName: row.display_name,
        seatIndex: row.seat_index ?? undefined,
        pickCount: row.pick_count,
        finishedAt: row.finished_at ?? undefined,
        joinedAt: row.joined_at,
      }));

    return NextResponse.json({
      id: draft.id,
      guildId: draft.guild_id,
      channelId: draft.channel_id,
      name: draft.name,
      status: draft.status,
      createdByUserId: draft.created_by_user_id,
      config: JSON.parse(draft.config_json),
      currentPackRound: draft.current_wave_number ?? 0,
      currentPickStep: draft.current_pick_step ?? 0,
      pickDeadlineAt: draft.pick_deadline_at ?? undefined,
      statusMessageId: draft.status_message_id ?? undefined,
      webSlug: draft.web_slug ?? undefined,
      createdAt: draft.created_at,
      startedAt: draft.started_at ?? undefined,
      endedAt: draft.ended_at ?? undefined,
      playerCount: draft.player_count,
      players,
    });
  } catch (error) {
    console.error("[api/drafts/[slug]] error:", error);
    return NextResponse.json(
      { error: "Failed to load draft" },
      { status: 500 }
    );
  }
}

export async function DELETE(
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
      .prepare("select id, created_by_user_id, status from drafts where web_slug = ?")
      .get(slug) as { id: number; created_by_user_id: string; status: string } | undefined;

    if (!draft) {
      return NextResponse.json({ error: "Draft not found" }, { status: 404 });
    }

    if (draft.created_by_user_id !== session.user.id) {
      return NextResponse.json({ error: "Only the draft creator can cancel or delete a draft" }, { status: 403 });
    }

    if (draft.status === "completed" || draft.status === "cancelled") {
      return NextResponse.json({ error: `Draft is already ${draft.status}` }, { status: 400 });
    }

    const drafts = createDraftService(db);
    const cancelled = drafts.cancel(draft.id);

    return NextResponse.json({
      id: cancelled.id,
      name: cancelled.name,
      status: cancelled.status,
      webSlug: cancelled.webSlug,
    });
  } catch (error) {
    console.error("[api/drafts/[slug] DELETE] error:", error);
    return NextResponse.json(
      { error: "Failed to cancel draft" },
      { status: 500 }
    );
  }
}

export async function PUT(
  request: NextRequest,
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
      .prepare("select id, created_by_user_id, status from drafts where web_slug = ?")
      .get(slug) as { id: number; created_by_user_id: string; status: string } | undefined;

    if (!draft) {
      return NextResponse.json({ error: "Draft not found" }, { status: 404 });
    }

    if (draft.created_by_user_id !== session.user.id) {
      return NextResponse.json({ error: "Only the draft creator can modify a draft" }, { status: 403 });
    }

    if (draft.status !== "pending") {
      return NextResponse.json({ error: "Can only modify pending drafts" }, { status: 400 });
    }

    const body = await request.json();
    const { name, config } = body as { name?: string; config?: unknown };

    if (name !== undefined) {
      if (!name.trim()) {
        return NextResponse.json({ error: "Name cannot be empty" }, { status: 400 });
      }

      const existing = db
        .prepare(
          "select id from drafts where guild_id = (select guild_id from drafts where id = ?) and name = ? and status in ('pending', 'active') and id != ?"
        )
        .get(draft.id, name) as { id: number } | undefined;

      if (existing) {
        return NextResponse.json({ error: "A draft with that name already exists" }, { status: 400 });
      }

      db.prepare("update drafts set name = ? where id = ?").run(name, draft.id);
    }

    if (config !== undefined) {
      db.prepare("update drafts set config_json = ? where id = ?").run(JSON.stringify(config), draft.id);
    }

    const updated = db.prepare("select * from drafts where id = ?").get(draft.id) as any;

    return NextResponse.json({
      id: updated.id,
      name: updated.name,
      status: updated.status,
      webSlug: updated.web_slug,
      config: JSON.parse(updated.config_json),
    });
  } catch (error) {
    console.error("[api/drafts/[slug] PUT] error:", error);
    return NextResponse.json(
      { error: "Failed to update draft" },
      { status: 500 }
    );
  }
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

    const draft = db
      .prepare("select id, created_by_user_id, status from drafts where web_slug = ?")
      .get(slug) as { id: number; created_by_user_id: string; status: string } | undefined;

    if (!draft) {
      return NextResponse.json({ error: "Draft not found" }, { status: 404 });
    }

    if (draft.created_by_user_id !== session.user.id) {
      return NextResponse.json({ error: "Only the draft creator can start a draft" }, { status: 403 });
    }

    const drafts = createDraftService(db);
    const started = drafts.start(draft.id);

    return NextResponse.json({
      id: started.id,
      name: started.name,
      status: started.status,
      webSlug: started.webSlug,
    });
  } catch (error) {
    console.error("[api/drafts/[slug] POST start] error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to start draft" },
      { status: 400 }
    );
  }
}
