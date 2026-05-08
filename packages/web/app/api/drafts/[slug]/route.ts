import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { auth } from "@/lib/auth";
import { env } from "@/lib/env";
import { createCardCatalogService, createDraftService } from "@yugidraft/shared/services";
import { buildDraftResponse } from "./helpers";
import { announceToBot } from "@/lib/announce-bot";
import { notifyWs } from "@/lib/notify-ws";

export const runtime = "nodejs";

const DRAFT_STATUS = {
  active: "active",
  cancelled: "cancelled",
  completed: "completed",
} as const;

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
    const response = await buildDraftResponse(slug, session.user.id);

    if (!response) {
      return NextResponse.json({ error: "Draft not found" }, { status: 404 });
    }

    return NextResponse.json(response);
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
    const guildId = env.discordGuildId;

    const draft = db
      .prepare("select id, created_by_user_id, status from drafts where web_slug = ? and guild_id = ?")
      .get(slug, guildId) as { id: number; created_by_user_id: string; status: string } | undefined;

    if (!draft) {
      return NextResponse.json({ error: "Draft not found" }, { status: 404 });
    }

    if (draft.created_by_user_id !== session.user.id) {
      return NextResponse.json({ error: "Only the draft creator can cancel or delete a draft" }, { status: 403 });
    }

    if (draft.status === DRAFT_STATUS.completed || draft.status === DRAFT_STATUS.cancelled) {
      db.transaction(() => {
        db.prepare("delete from draft_picks where draft_id = ?").run(draft.id);
        db.prepare("delete from draft_cards where draft_id = ?").run(draft.id);
        db.prepare("delete from draft_packs where draft_id = ?").run(draft.id);
        db.prepare("delete from draft_players where draft_id = ?").run(draft.id);
        db.prepare("delete from drafts where id = ?").run(draft.id);
      })();
      return NextResponse.json({ deleted: true });
    }

    const drafts = createDraftService(db);
    const cancelled = drafts.cancel(draft.id);

    await notifyWs(
      { url: env.wsInternalUrl, secret: env.wsInternalSecret },
      { kind: "status", slug, status: DRAFT_STATUS.cancelled },
    );

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
    const guildId = env.discordGuildId;

    const draft = db
      .prepare("select id, created_by_user_id, status from drafts where web_slug = ? and guild_id = ?")
      .get(slug, guildId) as { id: number; created_by_user_id: string; status: string } | undefined;

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
    const guildId = env.discordGuildId;

    const draft = db
      .prepare("select id, created_by_user_id, status from drafts where web_slug = ? and guild_id = ?")
      .get(slug, guildId) as { id: number; created_by_user_id: string; status: string } | undefined;

    if (!draft) {
      return NextResponse.json({ error: "Draft not found" }, { status: 404 });
    }

    if (draft.created_by_user_id !== session.user.id) {
      return NextResponse.json({ error: "Only the draft creator can start a draft" }, { status: 403 });
    }

    const drafts = createDraftService(db);
    const draftModel = drafts.findById(draft.id);
    const cards = createCardCatalogService(db);

    await cards.syncDraftPool({
      setNames: draftModel.config.setNames ?? [],
      customCardIds: draftModel.config.customCardIds ?? [],
      includeNames: draftModel.config.includeNames ?? [],
      excludeNames: draftModel.config.excludeNames ?? [],
    });

    const started = drafts.start(draft.id);

    await announceToBot(
      { url: env.botAnnounceUrl, secret: env.botAnnounceSecret },
      {
        kind: "draft-started",
        draftId: started.id,
        channelId: started.channelId,
        name: started.name,
        webSlug: started.webSlug ?? "",
      },
    );

    await notifyWs(
      { url: env.wsInternalUrl, secret: env.wsInternalSecret },
      { kind: "status", slug: started.webSlug ?? slug, status: DRAFT_STATUS.active },
    );

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
