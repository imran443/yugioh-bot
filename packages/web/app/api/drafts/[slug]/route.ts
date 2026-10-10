import { cardFetchErrorResponse } from "@/lib/card-fetch-errors";
import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { requireWebAccess } from "@/lib/web-access";
import { normalizeBoosterDraftNumbers } from "@/lib/booster-draft-validation";
import { cubeReferenceAccess } from "@/lib/cube-access";
import { ensureCatalogCards, sanitizePoolSource } from "@/lib/cube-pool";
import { env } from "@/lib/env";
import { boosterDraftConfigError, cardsPerPlayerError, themeDraftNumberError, createCardLookupBudget, createCardCatalogService, createDraftService, DraftTerminalError } from "@yugidraft/shared/services";
import { createDraftLobbyApi } from "@/lib/draft-lobby-api";
import { isValidLobbySeats, type DraftConfig } from "@yugidraft/shared/types";
import {
  buildDraftResponse, handleDraftStart, assertDraftLobbyAccess, assertDraftConfigShape, draftConfigInvalidation, DraftLobbyApiError, draftLobbyErrorResponse,
  readLobbyBody, runDraftLobbyRoute, validLobbyRevision, notifyDraftLobbySeats,
} from "./helpers";
import { broadcaster } from "@/lib/notify";
import { hostThemeAssignmentError } from "@/lib/theme-draft-validation";
import { draftReadAccess } from "@/lib/draft-access";
import { themeDraftSetupError } from "@/lib/theme-drafts";

export const runtime = "nodejs";

const DRAFT_STATUS = {
  cancelled: "cancelled",
  completed: "completed",
} as const;

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ slug: string }> }
) {
  let slug = "unknown";
  try {
    const actor = await requireWebAccess();
    if (!actor.ok) return actor.response;

    slug = (await params).slug;
    const denied = draftReadAccess(getDb(), slug, env.discordGuildId, actor.userId);
    if (denied) return denied;
    const response = await buildDraftResponse(slug, actor);

    if (!response) {
      return NextResponse.json({ error: "Draft not found" }, { status: 404 });
    }

    // A fallback tick can turn a public pending lobby into a private active draft.
    const deniedAfterTick = draftReadAccess(getDb(), slug, env.discordGuildId, actor.userId);
    if (deniedAfterTick) return deniedAfterTick;
    return NextResponse.json(response);
  } catch (error) {
    const fetchFailure = cardFetchErrorResponse(error);
    if (fetchFailure) return fetchFailure;
    if (error && typeof error === "object" && "code" in error) return draftLobbyErrorResponse(error);
    console.error(`[api/drafts/${slug}] load failed:`, error);
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
    const actor = await requireWebAccess();
    if (!actor.ok) return actor.response;

    const { slug } = await params;
    const db = getDb();
    const guildId = env.discordGuildId;
    const denied = draftReadAccess(db, slug, guildId, actor.userId);
    if (denied) return denied;

    const draft = db
      .prepare("select id, created_by_user_id, status from drafts where web_slug = ? and guild_id = ?")
      .get(slug, guildId) as { id: number; created_by_user_id: number; status: string } | undefined;

    if (!draft) {
      return NextResponse.json({ error: "Draft not found" }, { status: 404 });
    }

    if (draft.created_by_user_id !== actor.userId) {
      return NextResponse.json({ error: "Only the draft creator can cancel or delete a draft" }, { status: 403 });
    }

    if (draft.status === DRAFT_STATUS.completed || draft.status === DRAFT_STATUS.cancelled) {
      db.transaction(() => {
        db.prepare("delete from draft_passes where draft_id = ?").run(draft.id);
        db.prepare("delete from draft_picks where draft_id = ?").run(draft.id);
        db.prepare("delete from draft_cards where draft_id = ?").run(draft.id);
        db.prepare("delete from draft_packs where draft_id = ?").run(draft.id);
        db.prepare("delete from draft_undealt where draft_id = ?").run(draft.id);
        db.prepare("delete from draft_deal where draft_id = ?").run(draft.id);
        // Theme drafts reference draft_player_cube(draft_id) -> drafts(id); clear it
        // before the drafts row or the FK blocks the delete.
        db.prepare("delete from draft_player_cube where draft_id = ?").run(draft.id);
        db.prepare("delete from draft_players where draft_id = ?").run(draft.id);
        db.prepare("delete from drafts where id = ?").run(draft.id);
      })();
      void broadcaster.draft({ kind: "seats", slug });
      return NextResponse.json({ deleted: true });
    }

    const drafts = createDraftService(db);
    const cancelled = drafts.cancel(draft.id);

    void broadcaster.draft(
      { kind: "status", slug, status: DRAFT_STATUS.cancelled },
    );

    return NextResponse.json({
      id: cancelled.id,
      name: cancelled.name,
      status: cancelled.status,
      webSlug: cancelled.webSlug,
    });
  } catch (error) {
    if (error instanceof DraftTerminalError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
    }
    const fetchFailure = cardFetchErrorResponse(error);
    if (fetchFailure) return fetchFailure;
    console.error("[api/drafts/[slug] DELETE] error:", error);
    return NextResponse.json(
      { error: "Failed to cancel draft" },
      { status: 500 }
    );
  }
}

export async function PUT(request: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  return runDraftLobbyRoute(params, true, async (context) => {
    const { db, draftId, userId } = context;
    // Capture before request parsing or any catalog hydration for legacy callers.
    const captured = assertDraftLobbyAccess(context);
    const body = await readLobbyBody(request);
    const { name, config, revision } = body;
    if ((name !== undefined && (typeof name !== "string" || !name.trim()))
      || (config !== undefined && (!config || typeof config !== "object" || Array.isArray(config)))
      || (revision !== undefined && !validLobbyRevision(revision))) {
      throw new DraftLobbyApiError("Invalid name, config or revision", "INVALID_BODY");
    }
    const expectedRevision = revision === undefined ? captured.lobby_revision : revision as number;
    if (expectedRevision !== captured.lobby_revision || assertDraftLobbyAccess(context).lobby_revision !== expectedRevision) throw new DraftLobbyApiError("Lobby changed; refresh before editing", "STALE_LOBBY");
    const drafts = createDraftService(db);
    const existing = drafts.findById(draftId);
    const patch = config === undefined ? undefined : config as Partial<DraftConfig>;
    if (patch) {
      assertDraftConfigShape(patch);
      // A cleared host field returns to the shared forty-pick default.
      if (patch.cardsPerPlayer === null) patch.cardsPerPlayer = 40;
      const capError = cardsPerPlayerError(patch);
      if (capError) throw new DraftLobbyApiError(capError, "INVALID_CONFIG");
    }

    const merge = (base: DraftConfig) => {
      const sanitized = patch === undefined ? {} : sanitizePoolSource(db, existing.guildId, patch);
      const candidate: DraftConfig = { ...base, ...sanitized };
      if (patch && "poolSource" in patch && !("poolSource" in sanitized)) delete candidate.poolSource;
      return candidate;
    };
    const validate = (candidate: DraftConfig, base: DraftConfig): Response | undefined => {
      if (candidate.mode === "theme") {
        const closed = themeDraftSetupError({ config: base, status: "pending" });
        if (closed) return NextResponse.json({ error: closed }, { status: 403 });
      }
      assertDraftConfigShape(candidate);
      if (candidate.lobbySeats !== undefined && !isValidLobbySeats(candidate.lobbySeats)) {
        throw new DraftLobbyApiError("lobbySeats must be an integer from 2 to 8", "INVALID_LOBBY_SEATS");
      }
      const roster = drafts.players(draftId).map((p) => p.playerId);
      if (candidate.lobbySeats !== undefined && candidate.lobbySeats < roster.length) {
        throw new DraftLobbyApiError("Seat target cannot be below the joined count", "SEAT_TARGET_TOO_SMALL");
      }
      const numberError = candidate.mode === "theme"
        ? boosterDraftConfigError({ customExtraCardIds: candidate.customExtraCardIds }) ?? themeDraftNumberError(candidate)
        : boosterDraftConfigError(candidate);
      if (numberError) throw new DraftLobbyApiError(numberError, "INVALID_CONFIG");
      const denied = cubeReferenceAccess(db, candidate.allowedCubeIds, { allowMissing: true });
      if (denied) return denied;
      const assignmentError = hostThemeAssignmentError(db, existing.guildId, candidate, roster);
      if (assignmentError) throw new DraftLobbyApiError(assignmentError, "INVALID_CONFIG");
      if (name !== undefined) {
        const collision = db.prepare("select id from drafts where guild_id = ? and created_by_user_id = ? and name = ? and status in ('pending','active') and id != ?")
          .get(existing.guildId, existing.createdByUserId, name, draftId);
        if (collision) throw new DraftLobbyApiError("You already have a draft called this that hasn't finished.", "INVALID_BODY");
      }
    };
    let mergedConfig = merge(existing.config);
    const denied = validate(mergedConfig, existing.config);
    if (denied) return denied;
    let lookupLimited = false;
    let unknownIds: number[] = [];
    let resolvedPool: number[] | undefined;
    if (patch !== undefined && mergedConfig.mode !== "theme") {
      // Rebuild authored pools instead of retaining an old materialized snapshot.
      delete mergedConfig.cubeCardIds;
      delete mergedConfig.poolCardIds;
      const formatError = normalizeBoosterDraftNumbers(mergedConfig, patch);
      if (formatError) throw new DraftLobbyApiError(formatError, "INVALID_CONFIG");
      if (!mergedConfig.setNames?.length && !mergedConfig.customCardIds?.length) {
        throw new DraftLobbyApiError("Select at least one set or paste custom card IDs", "INVALID_CONFIG");
      }
      const cards = createCardCatalogService(db);
      const lookupBudget = createCardLookupBudget();
      await cards.syncDraftPool({
        setNames: mergedConfig.setNames ?? [], customCardIds: mergedConfig.customCardIds ?? [],
        includeNames: mergedConfig.includeNames ?? [], excludeNames: mergedConfig.excludeNames ?? [],
      }, { lookupBudget });
      const unknownExtraIds = await ensureCatalogCards(cards, mergedConfig.customExtraCardIds ?? [], lookupBudget);
      unknownIds = [...new Set([...(mergedConfig.customCardIds ?? []).filter((id) => !cards.hasCatalogRow(id)), ...unknownExtraIds])];
      lookupLimited = lookupBudget.lookupLimited;
      resolvedPool = drafts.resolveCubeCardIds(mergedConfig);
      if (!resolvedPool.length) {
        return NextResponse.json({
          error: "No cards matched the selected sets / passcodes",
          ...(lookupLimited ? { lookupLimited: true } : {}), ...(unknownIds.length ? { unknownIds } : {}),
        }, { status: 400 });
      }
    }
    const result = db.transaction(() => {
      const current = assertDraftLobbyAccess(context);
      if (current.lobby_revision !== expectedRevision) throw new DraftLobbyApiError("Lobby changed; refresh before editing", "STALE_LOBBY");
      // Merge and revalidate against authoritative config, references and roster.
      const currentConfig = drafts.findById(draftId).config;
      mergedConfig = merge(currentConfig);
      if (resolvedPool !== undefined) {
        delete mergedConfig.cubeCardIds;
        delete mergedConfig.poolCardIds;
        const formatError = normalizeBoosterDraftNumbers(mergedConfig, patch!);
        if (formatError) throw new DraftLobbyApiError(formatError, "INVALID_CONFIG");
        mergedConfig.cubeCardIds = resolvedPool;
      }
      const denied = validate(mergedConfig, currentConfig);
      if (denied) return denied;
      const analysis = mergedConfig.mode !== "theme" && patch !== undefined
        ? drafts.analyzeBoosterDraft(mergedConfig, mergedConfig.lobbySeats ?? 2, existing.guildId) : undefined;
      if (name !== undefined) db.prepare("update drafts set name = ? where id = ?").run(name, draftId);
      if (patch !== undefined) db.prepare("update drafts set config_json = ? where id = ?").run(JSON.stringify(mergedConfig), draftId);
      const service = createDraftLobbyApi(db);
      if (name !== undefined || patch !== undefined) {
        service.invalidate(draftId, draftConfigInvalidation(currentConfig, mergedConfig, drafts.players(draftId).map((p) => p.playerId)));
      }
      const updated = drafts.findById(draftId);
      return NextResponse.json({
        id: updated.id, name: updated.name, status: updated.status, webSlug: updated.webSlug,
        config: updated.config, lobby: service.read(draftId, userId).lobby,
        warnings: analysis?.warnings ?? [], errors: analysis?.errors ?? [],
        ...(lookupLimited ? { lookupLimited: true } : {}), ...(unknownIds.length ? { unknownIds } : {}),
      });
    }).immediate();
    if (result.status === 200 && (name !== undefined || patch !== undefined)) void notifyDraftLobbySeats(context.slug);
    return result;
  });
}

export async function POST(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  return handleDraftStart(request, params, true);
}
