import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { env } from "@/lib/env";
import { createCardCatalogService, createDraftService, createThemesService } from "@yugidraft/shared/services";

export const runtime = "nodejs";

async function loadDraft(slug: string) {
  const db = getDb();
  const guildId = env.discordGuildId;
  const row = db
    .prepare("select id, status, created_by_user_id from drafts where web_slug = ? and guild_id = ?")
    .get(slug, guildId) as { id: number; status: string; created_by_user_id: string } | undefined;
  return { db, guildId, row };
}

function persistAllowedThemeIds(db: ReturnType<typeof getDb>, draftId: number, allowedThemeIds: number[]) {
  const drafts = createDraftService(db);
  const draft = drafts.findById(draftId);
  const nextConfig = { ...draft.config, allowedThemeIds };
  db.prepare("update drafts set config_json = ? where id = ?").run(JSON.stringify(nextConfig), draftId);
}

export async function POST(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { slug } = await params;
  const { db, row } = await loadDraft(slug);
  if (!row) {
    return NextResponse.json({ error: "Draft not found" }, { status: 404 });
  }
  if (row.created_by_user_id !== session.user.id) {
    return NextResponse.json({ error: "Only the host can edit theme cubes" }, { status: 403 });
  }
  if (row.status !== "pending") {
    return NextResponse.json({ error: "Theme cubes can only be edited before the draft starts" }, { status: 400 });
  }

  const guildId = env.discordGuildId!;
  const drafts = createDraftService(db);
  const draft = drafts.findById(row.id);
  const catalog = createCardCatalogService(db);
  const themes = createThemesService(db, catalog);

  const body = (await request.json().catch(() => ({}))) as {
    kind?: "archetype" | "blank";
    archetype?: string;
    name?: string;
  };

  try {
    let theme;
    if (body.kind === "archetype") {
      const archetype = body.archetype?.trim();
      if (!archetype) {
        return NextResponse.json({ error: "archetype is required" }, { status: 400 });
      }
      const extraTarget = (draft.config.extraDeckEnabled ?? true) ? draft.config.extraDeckSize ?? 15 : 0;
      theme = await themes.createFromArchetype(guildId, archetype, session.user.id, {
        name: archetype,
        includeStaples: true,
        extraTarget,
      });
    } else {
      const name = body.name?.trim();
      if (!name) {
        return NextResponse.json({ error: "name is required" }, { status: 400 });
      }
      theme = themes.createBlank(guildId, name, session.user.id);
    }

    const allowedThemeIds = [...(draft.config.allowedThemeIds ?? []), theme.id];
    persistAllowedThemeIds(db, row.id, allowedThemeIds);

    const pools = themes.getThemePools(theme.id);
    return NextResponse.json(
      {
        theme: {
          id: theme.id,
          name: theme.name,
          archetype: theme.archetype,
          mainCount: pools.main.length,
          extraCount: pools.extra.length,
        },
        allowedThemeIds,
      },
      { status: 201 },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to add theme cube";
    // Network/API failures (unreachable card DB) surface as 502 so the UI can suggest passcode import.
    const status = /reach the card database|YGOPRODeck/i.test(message) ? 502 : 400;
    return NextResponse.json({ error: message }, { status });
  }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { slug } = await params;
  const { db, row } = await loadDraft(slug);
  if (!row) {
    return NextResponse.json({ error: "Draft not found" }, { status: 404 });
  }
  if (row.created_by_user_id !== session.user.id) {
    return NextResponse.json({ error: "Only the host can edit theme cubes" }, { status: 403 });
  }
  if (row.status !== "pending") {
    return NextResponse.json({ error: "Theme cubes can only be edited before the draft starts" }, { status: 400 });
  }

  const body = (await request.json().catch(() => ({}))) as { themeId?: number };
  const themeId = body.themeId;
  if (!Number.isInteger(themeId)) {
    return NextResponse.json({ error: "themeId is required" }, { status: 400 });
  }

  const drafts = createDraftService(db);
  const draft = drafts.findById(row.id);
  const allowedThemeIds = (draft.config.allowedThemeIds ?? []).filter((id) => id !== themeId);
  persistAllowedThemeIds(db, row.id, allowedThemeIds);

  // The theme cube belongs to this draft — delete it and its cards.
  db.prepare("delete from theme_cards where theme_id = ?").run(themeId);
  db.prepare("delete from draft_player_theme where draft_id = ? and theme_id = ?").run(row.id, themeId);
  db.prepare("delete from themes where id = ?").run(themeId);

  return NextResponse.json({ ok: true, allowedThemeIds });
}
