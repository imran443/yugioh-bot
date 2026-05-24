import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { auth } from "@/lib/auth";
import { env } from "@/lib/env";
import { analyzeCube, createCardCatalogService, createDraftService, createPlayerService } from "@yugidraft/shared/services";
import type { DraftConfig } from "@yugidraft/shared/types";
import { announcer } from "@/lib/notify";
import { toUtcIso } from "@/lib/utils";

export const runtime = "nodejs";

export async function GET() {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const discordUserId = session.user.id;
    const db = getDb();

    const playerRows = db
      .prepare("select id from players where discord_user_id = ?")
      .all(discordUserId) as Array<{ id: number }>;

    const playerIds = playerRows.map((r) => r.id);

    if (playerIds.length === 0) {
      return NextResponse.json({ active: [], pending: [], completed: [], cancelled: [] });
    }

    const placeholders = playerIds.map(() => "?").join(",");

    const drafts = db
      .prepare(
        `
        select
          d.id,
          d.guild_id,
          d.name,
          d.status,
          d.web_slug,
          d.current_wave_number,
          d.current_pick_step,
          d.created_at,
          d.ended_at,
          count(dp.player_id) as player_count
        from drafts d
        inner join draft_players dp_me on dp_me.draft_id = d.id
        left join draft_players dp on dp.draft_id = d.id
        where dp_me.player_id in (${placeholders})
        group by d.id
        order by
          case d.status
            when 'active' then 0
            when 'pending' then 1
            when 'completed' then 2
            when 'cancelled' then 3
          end,
          d.created_at desc
      `
      )
      .all(...playerIds)
      .map((row: any) => ({
        id: row.id,
        guildId: row.guild_id,
        name: row.name,
        status: row.status,
        webSlug: row.web_slug ?? undefined,
        currentPackRound: row.current_wave_number ?? 0,
        currentPickStep: row.current_pick_step ?? 0,
        playerCount: row.player_count,
        createdAt: toUtcIso(row.created_at),
        endedAt: toUtcIso(row.ended_at),
      }));

    const active = drafts.filter((d: any) => d.status === "active");
    const pending = drafts.filter((d: any) => d.status === "pending");
    const completed = drafts.filter((d: any) => d.status === "completed");
    const cancelled = drafts.filter((d: any) => d.status === "cancelled");

    return NextResponse.json({ active, pending, completed, cancelled });
  } catch (error) {
    console.error("[api/drafts] error:", error);
    return NextResponse.json(
      { error: "Failed to load drafts" },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json();
  const { name, channelId, config } = body as {
    name: string;
    channelId?: string;
    config: DraftConfig;
  };

  if (!name || (!config?.setNames?.length && !config?.customCardIds?.length)) {
    return NextResponse.json(
      { error: "name and a draft pool are required" },
      { status: 400 }
    );
  }

  const guildId = env.discordGuildId;
  const resolvedChannelId = channelId || env.discordDefaultChannelId;

  if (!guildId || !resolvedChannelId) {
    return NextResponse.json(
      { error: "Server not configured for draft creation" },
      { status: 500 }
    );
  }

  const db = getDb();
  const players = createPlayerService(db);
  const player = players.findOrCreate(guildId, session.user.id, session.user.name ?? "Unknown");
  const drafts = createDraftService(db);

  const cards = createCardCatalogService(db);
  await cards.syncDraftPool({
    setNames: config.setNames ?? [],
    customCardIds: config.customCardIds ?? [],
    includeNames: config.includeNames ?? [],
    excludeNames: config.excludeNames ?? [],
  });
  const cubeCardIds = drafts.resolveCubeCardIds(config);
  if (cubeCardIds.length === 0) {
    return NextResponse.json(
      { error: "No cards matched the selected sets / passcodes" },
      { status: 400 }
    );
  }

  // Advisory feasibility check at create time. The draft has no opponents yet, so
  // assume the minimum start count of 2 players. Non-blocking: the cube can grow
  // before start, and startDraft is the authoritative gate.
  const expectedPlayers = 2;
  const analysis = analyzeCube(
    cubeCardIds,
    expectedPlayers,
    config.packsPerPlayer ?? 5,
    config.packSize ?? 8,
  );

  const configWithPool: typeof config = { ...config, cubeCardIds };

  const draft = drafts.create(
    guildId,
    resolvedChannelId,
    name,
    configWithPool,
    session.user.id,
    player.id,
  );

  void announcer.announce(
    {
      kind: "draft-created",
      draftId: draft.id,
      channelId: draft.channelId,
      name: draft.name,
      webSlug: draft.webSlug ?? "",
    },
  );

  return NextResponse.json(
    {
      id: draft.id,
      name: draft.name,
      status: draft.status,
      webSlug: draft.webSlug,
      warnings: analysis.warnings,
      errors: analysis.errors,
    },
    { status: 201 }
  );
}
