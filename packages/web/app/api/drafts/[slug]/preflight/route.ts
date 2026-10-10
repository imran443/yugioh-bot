import { NextResponse } from "next/server";
import { requireWebAccess } from "@/lib/web-access";
import { getDb } from "@/lib/db";
import { env } from "@/lib/env";
import { hostThemeAssignmentError } from "@/lib/theme-draft-validation";
import { draftReadAccess } from "@/lib/draft-access";
import { themeDraftSetupError } from "@/lib/theme-drafts";
import { createCardCatalogService, createDraftService, createCubeService, mainDraftPicksPerPlayer, themeDraftNumberError } from "@yugidraft/shared/services";

export const runtime = "nodejs";

export async function GET(_request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const actor = await requireWebAccess();
  if (!actor.ok) return actor.response;
  const { slug } = await params;
  const db = getDb();
  const guildId = env.discordGuildId;
  const denied = draftReadAccess(db, slug, guildId, actor.userId);
  if (denied) return denied;

  const draftRow = db
    .prepare("select id from drafts where web_slug = ? and guild_id = ?")
    .get(slug, guildId) as { id: number } | undefined;
  if (!draftRow) {
    return NextResponse.json({ error: "Draft not found" }, { status: 404 });
  }

  const drafts = createDraftService(db);
  const draft = drafts.findById(draftRow.id);
  if (draft.config.mode !== "theme") {
    const analysis = drafts.analyzeBoosterDraft(draft.config, Math.max(2, drafts.players(draft.id).length), draft.guildId);
    return NextResponse.json({ errors: analysis.errors, warnings: analysis.warnings });
  }
  const closed = themeDraftSetupError(draft);
  if (closed) return NextResponse.json({ error: closed }, { status: 403 });
  if (draft.config.themeSelection === "host_assigned" && draft.createdByUserId !== actor.userId) {
    return NextResponse.json({ errors: [], warnings: [] });
  }
  const numberError = themeDraftNumberError(draft.config);
  if (numberError) return NextResponse.json({ errors: [numberError], warnings: [] });

  const cubes = createCubeService(db, createCardCatalogService(db));
  const cfg = {
    themePackSize: draft.config.themePackSize ?? 3,
    cardsPerPlayer: mainDraftPicksPerPlayer(draft.config),
    extraDeckSize: draft.config.extraDeckSize ?? 15,
    burnUnpicked: draft.config.burnUnpicked ?? false,
    extraDeckEnabled: draft.config.extraDeckEnabled ?? true,
    copyLimit: draft.config.copyLimit ?? true,
  };

  const playerIds = drafts.players(draft.id).map((p) => p.playerId);
  const assignmentError = hostThemeAssignmentError(db, draft.guildId, draft.config, playerIds);
  if (assignmentError) return NextResponse.json({ errors: [assignmentError], warnings: [] });

  // Host assignments are fixed; other modes can use any allowed theme at start.
  const cubeIds = draft.config.themeSelection === "host_assigned"
    ? [...new Set(playerIds.map((playerId) => draft.config.themeAssignments![String(playerId)]))]
    : draft.config.allowedCubeIds ?? [];
  const errors: string[] = [];
  const warnings: string[] = [];
  for (const cubeId of draft.config.allowedCubeIds ?? []) {
    const cube = db.prepare("select name, guild_id from cubes where id = ?")
      .get(cubeId) as { name: string; guild_id: string } | undefined;
    // Match assignThemes: deleted library cubes are dropped at start.
    if (!cube) continue;
    if (cube.guild_id !== draft.guildId) {
      errors.push(`Cube ${cubeId}: Cube not found`);
      continue;
    }
    // Scope every reference to this guild, but analyze only themes that can be assigned.
    if (!cubeIds.includes(cubeId)) continue;
    const analysis = cubes.analyzeCubePools(cubeId, cfg);
    const name = cube.name;
    for (const e of analysis.errors) errors.push(`${name}: ${e}`);
    for (const w of analysis.warnings) warnings.push(`${name}: ${w}`);
  }

  return NextResponse.json({ errors, warnings });
}
