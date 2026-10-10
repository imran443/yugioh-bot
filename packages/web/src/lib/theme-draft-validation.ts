import type Database from "better-sqlite3";
import { NextResponse } from "next/server";
import { DRAFT_LOBBY_ERROR_STATUS, type DraftConfig, type DraftLobbyErrorCode } from "@yugidraft/shared/types";
import { createDraftLobbyService, DraftLobbyServiceError, findDraftReadAccess, type DraftLobbyInvalidationOptions } from "@yugidraft/shared/services";
import { themeDraftSetupError } from "./theme-drafts";

class ThemeDraftsClosedError extends Error {}

export class ThemeDraftMutationError extends Error {
  constructor(public readonly code: DraftLobbyErrorCode, message: string, public readonly savedCubeId?: number) {
    super(message);
  }
}

export function themeDraftMutationResponse(error: unknown) {
  if (error instanceof ThemeDraftsClosedError) {
    return NextResponse.json({ error: error.message }, { status: 403 });
  }
  if (error instanceof DraftLobbyServiceError) {
    return NextResponse.json({ error: error.message, code: error.code, ...error.details }, { status: error.status });
  }
  if (!(error instanceof ThemeDraftMutationError)) throw error;
  return NextResponse.json({
    error: error.message, code: error.code,
    ...(error.savedCubeId === undefined ? {} : { savedCubeId: error.savedCubeId }),
  }, { status: DRAFT_LOBBY_ERROR_STATUS[error.code] });
}

export async function themeDraftMutationBody(request: Request): Promise<Record<string, unknown>> {
  const body: unknown = await request.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new ThemeDraftMutationError("INVALID_BODY", "Expected a JSON object");
  }
  return body as Record<string, unknown>;
}

/** Call again under the mutation's immediate transaction after any async work. */
export function pendingThemeDraft(db: Database.Database, slug: string, guildId: string, userId: number, hostOnly = false) {
  if (!findDraftReadAccess(db, slug, guildId, userId)?.canRead) {
    throw new ThemeDraftMutationError("DRAFT_NOT_FOUND", "Draft not found");
  }
  const row = db.prepare("select id, status, created_by_user_id, config_json from drafts where web_slug = ? and guild_id = ?")
    .get(slug, guildId) as { id: number; status: string; created_by_user_id: number; config_json: string } | undefined;
  if (!row) throw new ThemeDraftMutationError("DRAFT_NOT_FOUND", "Draft not found");
  if (hostOnly && row.created_by_user_id !== userId) throw new ThemeDraftMutationError("HOST_REQUIRED", "Only the host can edit cubes");
  if (row.status !== "pending") throw new ThemeDraftMutationError("DRAFT_NOT_PENDING", "Cubes can only be changed before the draft starts");
  const config = JSON.parse(row.config_json) as DraftConfig;
  const closed = themeDraftSetupError({ config, status: row.status });
  if (closed) throw new ThemeDraftsClosedError(closed);
  if (config.mode !== "theme") throw new ThemeDraftMutationError("THEME_SELECTION_REQUIRED", "This is not a theme draft");
  return { id: row.id, config };
}

/** Call inside the claim/config transaction; notify only after its commit. */
export function invalidateThemeLobby(
  db: Database.Database,
  draftId: number,
  options: DraftLobbyInvalidationOptions = { clearReady: true },
) {
  createDraftLobbyService(db).invalidate(draftId, options);
}

export function hostThemeAssignmentError(
  db: Database.Database,
  guildId: string,
  config: DraftConfig,
  playerIds: number[],
): string | undefined {
  if (config.mode !== "theme" || config.themeSelection !== "host_assigned") return;

  const allowed = config.allowedCubeIds ?? [];
  const assignments = config.themeAssignments ?? {};
  if (typeof assignments !== "object" || Array.isArray(assignments)) {
    return "Host-assigned themes require an allowed theme assignment for every player. Choose Random or Players pick instead.";
  }
  // Creation joins the creator; other entry points pass the current lobby's players.
  const assignedCubeIds = playerIds.map((playerId) => Object.hasOwn(assignments, String(playerId)) ? assignments[String(playerId)] : undefined);
  const validAssignment = (cubeId: unknown): cubeId is number => Number.isSafeInteger(cubeId) && (cubeId as number) > 0 && allowed.includes(cubeId as number);
  if (!assignedCubeIds.every(validAssignment)) {
    return "Host-assigned themes require an allowed theme assignment for every player. Choose Random or Players pick instead.";
  }

  const findCube = db.prepare("select id from cubes where id = ? and guild_id = ?");
  // Match startThemeDraft: unused allowed cubes do not affect host assignments.
  if (assignedCubeIds.some((cubeId) => !findCube.get(cubeId, guildId))) {
    return "Host-assigned themes must exist in the draft's guild. Choose valid themes or switch to Random or Players pick.";
  }

  if ((config.uniqueThemes ?? true) && new Set(assignedCubeIds).size !== assignedCubeIds.length) {
    return "Host-assigned themes must be distinct when uniqueThemes is enabled.";
  }
}
