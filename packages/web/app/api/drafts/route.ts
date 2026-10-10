import { withCardFetchErrors } from "@/lib/card-fetch-errors";
import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { requireWebAccess } from "@/lib/web-access";
import { parseDraftConfig } from "@/components/draft/list/drafts-list-model";
import { normalizeBoosterDraftNumbers } from "@/lib/booster-draft-validation";
import { cubeReferenceAccess } from "@/lib/cube-access";
import { env } from "@/lib/env";
import { findDraftListPage, InvalidListCursorError, boosterDraftConfigError, cardsPerPlayerError, themeDraftNumberError, createCardLookupBudget, createCardCatalogService, createDraftService, createPlayerService, isDraftVisibility } from "@yugidraft/shared/services";
import { DEFAULT_LOBBY_SEATS, isValidLobbySeats } from "@yugidraft/shared/types";
import { assertDraftConfigShape, readLobbyBody, draftLobbyErrorResponse } from "./[slug]/helpers";
import type { DraftConfig } from "@yugidraft/shared/types";
import { announcer } from "@/lib/notify";
import { toUtcIso } from "@/lib/utils";
import { ensureCatalogCards, sanitizePoolSource } from "@/lib/cube-pool";
import { hostThemeAssignmentError } from "@/lib/theme-draft-validation";
import { themeDraftsEnabled, themeDraftSetupError } from "@/lib/theme-drafts";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const actor = await requireWebAccess();
    if (!actor.ok) return actor.response;
    const cursor = new URL(request.url).searchParams.get("cursor");
    const result = findDraftListPage(getDb(), env.discordGuildId, actor.userId, cursor);
    const items = result.items.map(({ configJson, ...item }) => ({
      ...item, config: parseDraftConfig(configJson, item.status), createdAt: toUtcIso(item.createdAt), endedAt: toUtcIso(item.endedAt),
    }));
    return NextResponse.json({ items, nextCursor: result.nextCursor, themeDraftsEnabled: themeDraftsEnabled() });
  } catch (error) {
    if (error instanceof InvalidListCursorError) return NextResponse.json({ error: error.message }, { status: 400 });
    console.error("[api/drafts] error:", error);
    return NextResponse.json({ error: "Failed to load drafts" }, { status: 500 });
  }
}

async function handlePOST(request: NextRequest) {
  const actor = await requireWebAccess();
  if (!actor.ok) return actor.response;

  const body = await readLobbyBody(request);
  const visibility = body.visibility === undefined ? "private" : body.visibility;
  if (!isDraftVisibility(visibility)) {
    return NextResponse.json({ error: "visibility must be open or private", code: "INVALID_BODY" }, { status: 400 });
  }
  const { name, channelId, config: rawConfig } = body as {
    name: string;
    channelId?: string;
    config: DraftConfig;
  };
  const discordEnabled = env.discordBotEnabled;

  if (typeof name !== "string" || !name.trim() || !rawConfig || typeof rawConfig !== "object" || Array.isArray(rawConfig)
    || (discordEnabled && channelId !== undefined && typeof channelId !== "string")) {
    return NextResponse.json({ error: "name and config are required", code: "INVALID_BODY" }, { status: 400 });
  }
  if (rawConfig.mode === "theme") {
    const closed = themeDraftSetupError();
    if (closed) return NextResponse.json({ error: closed }, { status: 403 });
  }
  assertDraftConfigShape(rawConfig);
  const capError = cardsPerPlayerError(rawConfig);
  if (capError) return NextResponse.json({ error: capError }, { status: 400 });
  const lobbySeats = rawConfig.lobbySeats === undefined ? DEFAULT_LOBBY_SEATS : rawConfig.lobbySeats;
  if (!isValidLobbySeats(lobbySeats)) {
    return NextResponse.json({ error: "lobbySeats must be an integer from 2 to 8", code: "INVALID_LOBBY_SEATS" }, { status: 400 });
  }
  const guildId = env.discordGuildId;
  // Drafts can be created without a Discord channel.
  const resolvedChannelId = discordEnabled ? channelId || env.discordDefaultChannelId || null : null;

  if (!guildId) {
    return NextResponse.json(
      { error: "Server not configured for draft creation" },
      { status: 500 }
    );
  }

  const db = getDb();
  const config = sanitizePoolSource(db, guildId, { ...rawConfig, lobbySeats });
  const denied = cubeReferenceAccess(db, config?.allowedCubeIds);
  if (denied) return denied;

  // Theme mode: no card-pool sync — the pool lives in the theme cubes, which the
  // host adds inside the draft after creation. So a theme draft starts blank.
  if (config?.mode === "theme") {
    const extraIdsError = boosterDraftConfigError({ customExtraCardIds: config.customExtraCardIds });
    if (extraIdsError) return NextResponse.json({ error: extraIdsError }, { status: 400 });
    const numberError = themeDraftNumberError(config);
    if (numberError) return NextResponse.json({ error: numberError }, { status: 400 });
    if (!name) {
      return NextResponse.json({ error: "name is required" }, { status: 400 });
    }
    const players = createPlayerService(db);
    const player = players.findOrCreate(guildId, actor.userId, actor.userName);
    const assignmentError = hostThemeAssignmentError(db, guildId, config, [player.id]);
    if (assignmentError) {
      return NextResponse.json({ error: assignmentError }, { status: 400 });
    }
    const drafts = createDraftService(db);
    const draft = drafts.create(
      guildId,
      resolvedChannelId,
      name,
      { ...config, allowedCubeIds: config.allowedCubeIds ?? [] },
      actor.userId,
      player.id,
      visibility,
    );

    if (discordEnabled && draft.channelId) {
      void announcer.announce({
        kind: "draft-created",
        draftId: draft.id,
        channelId: draft.channelId,
        name: draft.name,
        webSlug: draft.webSlug ?? "",
      });
    }

    return NextResponse.json(
      { id: draft.id, name: draft.name, status: draft.status, visibility: draft.visibility, webSlug: draft.webSlug, warnings: [], errors: [] },
      { status: 201 },
    );
  }

  if (!name || (!config?.setNames?.length && !config?.customCardIds?.length)) {
    return NextResponse.json(
      { error: "name and a draft pool are required" },
      { status: 400 }
    );
  }
  const numberError = boosterDraftConfigError(config) ?? normalizeBoosterDraftNumbers(config);
  if (numberError) return NextResponse.json({ error: numberError }, { status: 400 });

  const players = createPlayerService(db);
  const player = players.findOrCreate(guildId, actor.userId, actor.userName);
  const drafts = createDraftService(db);

  const cards = createCardCatalogService(db);
  const lookupBudget = createCardLookupBudget();
  await cards.syncDraftPool({
    setNames: config.setNames ?? [],
    customCardIds: config.customCardIds ?? [],
    includeNames: config.includeNames ?? [],
    excludeNames: config.excludeNames ?? [],
  }, { lookupBudget });
  const unknownExtraIds = await ensureCatalogCards(cards, config.customExtraCardIds ?? [], lookupBudget);
  const unknownIds = [...new Set([...(config.customCardIds ?? []).filter((id) => !cards.hasCatalogRow(id)), ...unknownExtraIds])];
  const cubeCardIds = drafts.resolveCubeCardIds(config);
  if (cubeCardIds.length === 0) {
    return NextResponse.json(
      {
        error: "No cards matched the selected sets / passcodes",
        ...(lookupBudget.lookupLimited ? { lookupLimited: true } : {}),
        ...(unknownIds.length ? { unknownIds } : {}),
      },
      { status: 400 }
    );
  }

  // Advisory demand uses the real target; manual starts may use fewer seats.
  const expectedPlayers = lobbySeats;
  const analysis = drafts.analyzeBoosterDraft({ ...config, cubeCardIds }, expectedPlayers, guildId);

  const configWithPool: typeof config = { ...config, cubeCardIds };

  const draft = drafts.create(
    guildId,
    resolvedChannelId,
    name,
    configWithPool,
    actor.userId,
    player.id,
    visibility,
  );

  if (discordEnabled && draft.channelId) {
    void announcer.announce(
      {
        kind: "draft-created",
        draftId: draft.id,
        channelId: draft.channelId,
        name: draft.name,
        webSlug: draft.webSlug ?? "",
      },
    );
  }

  return NextResponse.json(
    {
      id: draft.id,
      name: draft.name,
      status: draft.status,
      visibility: draft.visibility,
      webSlug: draft.webSlug,
      config: draft.config,
      warnings: analysis.warnings,
      errors: analysis.errors,
      ...(lookupBudget.lookupLimited ? { lookupLimited: true } : {}),
      ...(unknownIds.length ? { unknownIds } : {}),
    },
    { status: 201 }
  );
}

export const POST = withCardFetchErrors(async (request: NextRequest) => {
  try { return await handlePOST(request); }
  catch (error) { return draftLobbyErrorResponse(error); }
});
