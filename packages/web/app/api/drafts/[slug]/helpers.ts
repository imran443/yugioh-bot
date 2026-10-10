import { NextResponse } from "next/server";
import { cubeReferenceAccess } from "@/lib/cube-access";
import { ensureCatalogCards } from "@/lib/cube-pool";
import { cardFetchErrorResponse } from "@/lib/card-fetch-errors";
import { createDraftLobbyApi } from "@/lib/draft-lobby-api";
import { DRAFT_LOBBY_ERROR_STATUS, type DraftAllowedCube, type DraftConfig, type DraftLobbyErrorCode, type DraftLobbyResponse, type DraftLobbyTickResult } from "@yugidraft/shared/types";
import { requireWebAccess } from "@/lib/web-access";
import { getDb } from "@/lib/db";
import { env } from "@/lib/env";
import {
  createCardCatalogService,
  createCardLookupBudget,
  createDraftService,
  findDraftReadAccess,
  findTournamentReadAccess,
  DraftLobbyServiceError,
  CurrentNameTakenError,
  createSavedDeckService,
  MAX_COPIES_PER_PLAYER,
  boosterDraftPhase,
  boosterExtraSize,
  boosterMainRounds,
  reachableBoosterMainPicks,
  mainDraftPicksPerPlayer,
} from "@yugidraft/shared/services";
import { toUtcIso } from "@/lib/utils";
import { announcer, broadcaster } from "@/lib/notify";
import { lookupDraftCardTypes, type EngineCardTypes } from "@/lib/draft-engine-types";
import { draftTestBotsEnabled } from "@/lib/draft-test-bots";
import { cardImageUrl } from "@/lib/card-image-url";
import { isOwnerUser } from "@/lib/owner-access";

function getTimerSeconds(pickDeadlineAt: string | null | undefined): number {
  if (!pickDeadlineAt) {
    return 0;
  }

  const remainingMs = new Date(pickDeadlineAt).getTime() - Date.now();
  return Math.max(0, Math.ceil(remainingMs / 1000));
}

/**
 * Run one part of the draft response. If it throws, log it with the draft slug and use the fallback,
 * so one bad row degrades that part of the page and the player still gets into the draft.
 * SQLITE_BUSY errors are rethrown.
 */
function degrade<T>(slug: string, part: string, fallback: T, run: () => T): T {
  try {
    return run();
  } catch (error) {
    // A locked database is not a bad row. Fail the load so the room shows the error; a fallback here
    // would show stale data (a frozen timer) while the database is busy.
    const code = (error as { code?: unknown } | null)?.code;
    if (typeof code === "string" && code.startsWith("SQLITE_BUSY")) throw error;
    console.error(`[api/drafts/${slug}] ${part} failed:`, error);
    return fallback;
  }
}

function mapDraftCardDetails(
  slug: string,
  db: ReturnType<typeof getDb>,
  cards: Array<{ draftCardId: number; catalogCardId: number; forced?: boolean }>,
  engineTypes: ReadonlyMap<number, EngineCardTypes> = new Map(),
) {
  if (cards.length === 0) {
    return [];
  }

  const catalog = createCardCatalogService(db);
  // A catalog row that cannot be read shows as "Card <passcode>" instead of failing the whole draft.
  const catalogCards = degrade(slug, "card catalog lookup", [] as ReturnType<typeof catalog.findByIds>, () =>
    catalog.findByIds(cards.map((card) => card.catalogCardId)),
  );
  const catalogById = new Map(catalogCards.map((card) => [card.ygoprodeckId, card]));

  return cards.map((card) => {
    const catalogCard = catalogById.get(card.catalogCardId);
    const engine = engineTypes.get(card.catalogCardId);

    return {
      id: card.draftCardId,
      ...(card.forced !== undefined ? { forced: card.forced } : {}),
      passcode: card.catalogCardId,
      name: catalogCard?.name ?? `Card ${card.catalogCardId}`,
      type: catalogCard?.type ?? "Unknown",
      frameType: catalogCard?.frameType ?? "normal",
      attribute: catalogCard?.attribute,
      archetype: catalogCard?.archetype ?? null,
      race: engine?.race ?? null,
      spellTrapType: engine?.spellTrapType ?? null,
      level: catalogCard?.level,
      effectText: catalogCard?.effectText ?? "",
      atk: catalogCard?.atk,
      def: catalogCard?.def,
      imageUrl: catalogCard?.imageUrl ?? "",
      imageUrlSmall: catalogCard?.imageUrlSmall ?? catalogCard?.imageUrl ?? "",
    };
  });
}

export async function buildDraftResponse(slug: string, actor: { userId: number; discordUserId: string | null }) {
  const userId = actor.userId;
  const db = getDb();
  const drafts = createDraftService(db);
  const guildId = env.discordGuildId;

  const draftIdRow = db
    .prepare("select id, status, lobby_start_token, lobby_auto_start, lobby_auto_held from drafts where web_slug = ? and guild_id = ?")
    .get(slug, guildId) as { id: number; status: string; lobby_start_token: string | null;
      lobby_auto_start: number; lobby_auto_held: number } | undefined;

  if (!draftIdRow) {
    return null;
  }

  if (draftIdRow.status === "pending" && (draftIdRow.lobby_start_token !== null
    || (draftIdRow.lobby_auto_start === 1 && draftIdRow.lobby_auto_held === 0))) {
    // GET is a start entry point even without a background timer. The shared
    // tick commits the winning transition before its notifications are sent.
    const transitions = createDraftLobbyApi(db).tick(Date.now(), draftIdRow.id);
    await notifyDraftLobbyTick(transitions);
  }

  if (drafts.findById(draftIdRow.id).status === "active") {
    // The timeout sweep also runs in the worker. If it fails here, the page still loads the draft as it is.
    const { autoPickedPlayerIds } = degrade(slug, "pick expiry", { autoPickedPlayerIds: [] as number[] }, () =>
      drafts.expireCurrentPickStep(draftIdRow.id),
    );
    if (autoPickedPlayerIds.length > 0) {
      const updated = drafts.findById(draftIdRow.id);
      if (updated.status === "completed") {
        void broadcaster.draft({ kind: "complete", slug });
      } else {
        void broadcaster.draft({ kind: "resync", slug, packRound: updated.currentPackRound, pickStep: updated.currentPickStep });
      }
    }
  }

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
          d.tournament_id,
          count(dp.player_id) as player_count
        from drafts d
        left join draft_players dp on dp.draft_id = d.id
        where d.id = ?
        group by d.id
      `
    )
    .get(draftIdRow.id) as any;

  if (!draft) {
    return null;
  }

  const draftModel = drafts.findById(draft.id);
  const config = { ...draftModel.config };
  if (userId !== draft.created_by_user_id) {
    delete config.themeAssignments;
  }

  const pendingLobby = draft.status === "pending"
    ? projectDraftLobbyResponse(createDraftLobbyApi(db).read(draft.id, userId))
    : undefined;

  const players = pendingLobby?.players ?? db
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
      finishedAt: toUtcIso(row.finished_at),
      joinedAt: toUtcIso(row.joined_at),
    }));

  const currentPlayer = db
    .prepare("select id from players where guild_id = ? and user_id = ?")
    .get(draft.guild_id, userId) as { id: number } | undefined;

  const isParticipant = currentPlayer
    ? players.some((p: any) => p.playerId === currentPlayer.id)
    : false;

  // A player who passed the pick (nothing in the pack they may take) is done for the step too.
  const pickedPlayerIds = new Set(
    db
      .prepare(
        `
          select player_id from draft_picks
          where draft_id = ? and wave_number = ? and pick_step = ?
          union
          select player_id from draft_passes
          where draft_id = ? and wave_number = ? and pick_step = ?
        `
      )
      .all(
        draft.id, draftModel.currentPackRound, draftModel.currentPickStep,
        draft.id, draftModel.currentPackRound, draftModel.currentPickStep,
      )
      .map((row: any) => row.player_id as number)
  );

  const seats = players
    .map((player, index) => ({
      seatIndex: player.seatIndex ?? index,
      playerId: player.playerId,
      displayName: player.displayName,
      hasPicked: pickedPlayerIds.has(player.playerId),
      isCurrentPlayer: currentPlayer ? player.playerId === currentPlayer.id : false,
    }))
    .sort((a, b) => a.seatIndex - b.seatIndex);

  // Only a seat in the draft has a pack. A viewer with a player row but no seat gets an empty one.
  const currentPackCards =
    draft.status === "active" && currentPlayer && isParticipant
      ? degrade(slug, "current pack", [] as Array<{ draftCardId: number; catalogCardId: number }>, () =>
          drafts.currentPackOptions(draft.id, currentPlayer.id).map((card) => ({
            draftCardId: card.id,
            catalogCardId: card.catalogCardId,
          })),
        )
      : [];

  const myPoolCards =
    currentPlayer && isParticipant
      ? degrade(slug, "card pool", [] as Array<{ draftCardId: number; catalogCardId: number }>, () =>
          drafts.pool(draft.id, currentPlayer.id).map((card) => ({
            draftCardId: card.draftCardId,
            catalogCardId: card.catalogCardId,
            forced: card.forced,
          })),
        )
      : [];

  // Monster type and spell/trap kind come from the duel engine. Without it (or without a seat to ask
  // it as) the cards carry no types and the room hides those chip rows.
  const engineTypes = currentPlayer && isParticipant
    ? await lookupDraftCardTypes(
        [...currentPackCards, ...myPoolCards].map((card) => card.catalogCardId),
        { guildId: draft.guild_id, playerId: currentPlayer.id },
      )
    : new Map<number, EngineCardTypes>();
  // The whole pack is sent. A card the viewer already holds the per-player maximum of is marked
  // blocked, with the copies held, so the room can show it as unavailable.
  const held =
    draft.status === "active" && currentPlayer && isParticipant
      ? degrade(slug, "held copies", {} as Record<number, number>, () => drafts.heldCopies(draft.id, currentPlayer.id))
      : {};
  const hasLegalCard = currentPackCards.some((card) => (held[card.catalogCardId] ?? 0) < MAX_COPIES_PER_PLAYER);
  const forced = draftModel.config.copyLimit !== false && draftModel.config.mode !== "theme" && currentPackCards.length > 0 && !hasLegalCard;
  const currentPack = mapDraftCardDetails(slug, db, currentPackCards, engineTypes).map((card) => {
    const copies = held[card.passcode] ?? 0;
    return { ...card, held: copies, forced, blocked: draftModel.config.copyLimit !== false && copies >= MAX_COPIES_PER_PLAYER && (draftModel.config.mode === "theme" || hasLegalCard) };
  });
  const passed =
    draft.status === "active" && currentPlayer && isParticipant
      ? degrade(slug, "passed step", false, () => drafts.hasPassedStep(draft.id, currentPlayer.id))
      : false;
  const myPool = mapDraftCardDetails(slug, db, myPoolCards, engineTypes);

  // Theme-mode extras: derived phase, progress, and lobby theme previews.
  const isTheme = draftModel.config.mode === "theme";
  const mainSize = mainDraftPicksPerPlayer(draftModel.config);
  const phase: "main" | "extra" | undefined = isTheme
    ? draftModel.currentPackRound <= mainSize
      ? "main"
      : "extra"
    : boosterExtraSize(config) > 0 ? boosterDraftPhase(config, draftModel.currentPackRound) : undefined;
  const mainRounds = boosterMainRounds(config);
  const extraSize = boosterExtraSize(config);
  const totalPackRounds = isTheme ? undefined : mainRounds + (extraSize > 0 ? 1 : 0);
  const currentPackSize = isTheme ? undefined : phase === "extra" ? extraSize : config.packSize ?? 8;
  let boosterProgress: { main: number; mainTotal: number; extra: number; extraTotal: number } | undefined;
  if (!isTheme) {
    const counts = currentPlayer && isParticipant ? db.prepare(`select
      sum(case when wave_number <= ? then 1 else 0 end) as main,
      sum(case when wave_number > ? then 1 else 0 end) as extra
      from draft_picks where draft_id = ? and player_id = ?`)
      .get(mainRounds, mainRounds, draft.id, currentPlayer.id) as { main: number | null; extra: number | null } : undefined;
    let mainTotal = mainSize;
    if (draft.status !== "pending") {
      if (counts && (draft.status === "completed" || phase === "extra")) {
        mainTotal = counts.main ?? 0;
      } else {
        const playerCount = players.length;
        const packSize = config.packSize ?? 8;
        const deal = db.prepare("select position from draft_deal where draft_id = ? and position < ?")
          .all(draft.id, mainRounds * playerCount * packSize) as Array<{ position: number }>;
        // Older active drafts without a persisted deal retain their generator's configured total.
        if (deal.length > 0) {
          const sizes = Array.from({ length: mainRounds }, () => Array<number>(playerCount).fill(0));
          for (const card of deal) {
            const pack = Math.floor(card.position / packSize);
            sizes[Math.floor(pack / playerCount)][pack % playerCount]++;
          }
          const reachable = reachableBoosterMainPicks(sizes, config);
          const seat = players.find((player) => player.playerId === currentPlayer?.id)?.seatIndex;
          mainTotal = seat == null ? Math.max(...reachable) : reachable[seat];
        }
      }
    }
    boosterProgress = { main: counts?.main ?? 0, mainTotal, extra: counts?.extra ?? 0, extraTotal: extraSize };
  }

  let allowedCubes: DraftAllowedCube[] | undefined;
  let themeProgress: { main: number; mainTotal: number; extra: number; extraTotal: number } | undefined;
  if (isTheme) {
    const ids = draftModel.config.allowedCubeIds ?? [];
    // The host's allowed theme pool is public; per-player assignments stay private.
    if (ids.length > 0) {
      const placeholders = ids.map(() => "?").join(",");
      const rows = db
        .prepare(`select id, name, archetype from cubes where guild_id = ? and id in (${placeholders})`)
        .all(draft.guild_id, ...ids) as Array<{ id: number; name: string; archetype: string | null }>;
      const countStmt = db.prepare("select pool, count(*) as n, sum(max_copies) as copies from cube_cards where cube_id = ? group by pool");
      const sampleStmt = db.prepare(
        "select catalog_card_id as id from cube_cards where cube_id = ? limit 4",
      );
      allowedCubes = rows.map((r) => {
        const counts = countStmt.all(r.id) as Array<{ pool: string; n: number; copies: number }>;
        const samples = (sampleStmt.all(r.id) as Array<{ id: number }>).map((s) => cardImageUrl(s.id, "small"));
        return {
          id: r.id,
          name: r.name,
          archetype: r.archetype,
          mainCount: counts.find((c) => c.pool === "main")?.n ?? 0,
          extraCount: counts.find((c) => c.pool === "extra")?.n ?? 0,
          mainDistinct: counts.find((c) => c.pool === "main")?.n ?? 0,
          extraDistinct: counts.find((c) => c.pool === "extra")?.n ?? 0,
          mainCopies: counts.find((c) => c.pool === "main")?.copies ?? 0,
          extraCopies: counts.find((c) => c.pool === "extra")?.copies ?? 0,
          sampleImages: samples,
        };
      });
    }
    const picked =
      currentPlayer && isParticipant
        ? players.find((p) => p.playerId === currentPlayer.id)?.pickCount ?? 0
        : 0;
    const phaseCounts = currentPlayer && isParticipant
      ? db.prepare(`select sum(case when wave_number <= ? then 1 else 0 end) as main,
          sum(case when wave_number > ? then 1 else 0 end) as extra
          from draft_picks where draft_id = ? and player_id = ?`)
        .get(mainSize, mainSize, draft.id, currentPlayer.id) as { main: number | null; extra: number | null }
      : undefined;
    themeProgress = {
      main: phaseCounts ? phaseCounts.main ?? 0 : Math.min(picked, mainSize),
      mainTotal: mainSize,
      extra: phaseCounts ? phaseCounts.extra ?? 0 : Math.max(0, picked - mainSize),
      extraTotal: (draftModel.config.extraDeckEnabled ?? true) ? draftModel.config.extraDeckSize ?? 15 : 0,
    };
  }

  const timerSeconds = getTimerSeconds(draft.pick_deadline_at);
  const pickSeconds = draftModel.config.pickSeconds ?? 45;
  const isMyTurn = draft.status === "active" && currentPack.some((card) => !card.blocked);
  const participantPickCount = currentPlayer && isParticipant
    ? players.find((player) => player.playerId === currentPlayer.id)?.pickCount
    : undefined;

  // The viewer's saved draft deck, so the results page offers Edit deck instead of Create deck.
  // A saved deck that cannot be read only hides that button; the results still load.
  const myDeckId = isParticipant && draft.status === "completed"
    ? degrade(slug, "saved deck lookup", null as number | null, () =>
        createSavedDeckService(db).findByDraft(draft.guild_id, userId, draft.id)?.id ?? null,
      )
    : null;

  // The tournament made from this draft, so the finale and results can link straight to it.
  const tournament = draft.tournament_id != null && findTournamentReadAccess(db, draft.tournament_id, draft.guild_id, userId)?.canRead
    ? degrade(slug, "tournament lookup", null as { name: string; webSlug: string | null } | null, () => {
        const row = db.prepare("select name, web_slug from tournaments where id = ? and guild_id = ?").get(draft.tournament_id, draft.guild_id) as
          | { name: string; web_slug: string | null }
          | undefined;
        return row ? { name: row.name, webSlug: row.web_slug } : null;
      })
    : null;

  const canCreateTournament = draft.status === "completed" && draft.tournament_id == null && draft.created_by_user_id === userId;

  return {
    id: draft.id,
    guildId: draft.guild_id,
    channelId: draft.channel_id,
    name: draft.name,
    status: draft.status,
    visibility: draftModel.visibility,
    canJoin: findDraftReadAccess(db, draft.id, guildId, userId)?.canJoin ?? false,
    ...(draft.created_by_user_id === userId ? { canManageInvite: true } : {}),
    // The same rule as POST /cancel: the host or an owner. The page only uses it to show the controls.
    ...(draft.created_by_user_id === userId || isOwnerUser(userId) ? { canCancel: true } : {}),
    createdByUserId: draft.created_by_user_id,
    config,
    currentPackRound: draftModel.currentPackRound,
    currentPickStep: draftModel.currentPickStep,
    pickDeadlineAt: draft.pick_deadline_at ?? undefined,
    statusMessageId: draft.status_message_id ?? undefined,
    webSlug: draft.web_slug ?? undefined,
    createdAt: toUtcIso(draft.created_at),
    startedAt: toUtcIso(draft.started_at),
    endedAt: toUtcIso(draft.ended_at),
    playerCount: draft.player_count,
    tournamentId: tournament ? draft.tournament_id : null,
    tournamentName: tournament?.name ?? null,
    tournamentSlug: tournament?.webSlug ?? null,
    canCreateTournament,
    players,
    ...(pendingLobby ? { lobby: pendingLobby.lobby } : {}),
    participantPickCount,
    myDeckId,
    isParticipant,
    currentPack,
    myPool,
    seats,
    packRound: draftModel.currentPackRound,
    pickStep: draftModel.currentPickStep,
    timerSeconds,
    isMyTurn,
    passed,
    completed: draft.status === "completed",
    pickSeconds,
    phase,
    totalPackRounds,
    currentPackSize,
    boosterProgress,
    themeProgress,
    allowedCubes,
    botsEnabled: draftTestBotsEnabled(),
    discordEnabled: env.discordBotEnabled,
  };
}


export class DraftLobbyApiError extends Error {
  constructor(message: string, readonly code: DraftLobbyErrorCode) { super(message); }
}

export function draftLobbyErrorResponse(error: unknown): Response {
  const fetchFailure = cardFetchErrorResponse(error);
  if (fetchFailure) return fetchFailure;
  if (error instanceof CurrentNameTakenError) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
  if (error instanceof DraftLobbyServiceError) {
    return NextResponse.json({ error: error.message, code: error.code, ...error.details }, { status: error.status });
  }
  const failure = error as { message?: string; code?: string; details?: Record<string, unknown> } | null;
  if (failure?.code && Object.hasOwn(DRAFT_LOBBY_ERROR_STATUS, failure.code)) {
    const code = failure.code as DraftLobbyErrorCode;
    const details = failure.details ?? failure;
    const body: Record<string, unknown> = { error: failure.message ?? "Lobby action failed", code };
    for (const key of ["notReadyPlayerIds", "unclaimedPlayerIds", "errors", "warnings"] as const) {
      if (key in details) body[key] = (details as Record<string, unknown>)[key];
    }
    return NextResponse.json(body, { status: DRAFT_LOBBY_ERROR_STATUS[code] });
  }
  console.error("[draft lobby] action failed:", error);
  return NextResponse.json({ error: "Failed to update draft lobby" }, { status: 500 });
}

export type DraftLobbyContext = {
  db: ReturnType<typeof getDb>; draftId: number; slug: string; userId: number; hostOnly: boolean;
};

/** Also reusable by Nudge: resolve configured guild and ownership before writes. */
export function assertDraftLobbyAccess(context: DraftLobbyContext) {
  if (!findDraftReadAccess(context.db, context.slug, env.discordGuildId, context.userId)?.canRead) {
    throw new DraftLobbyApiError("Draft not found", "DRAFT_NOT_FOUND");
  }
  const draft = context.db.prepare(
    "select id, created_by_user_id, status, lobby_revision from drafts where id = ? and web_slug = ? and guild_id = ?",
  ).get(context.draftId, context.slug, env.discordGuildId) as
    { id: number; created_by_user_id: number; status: string; lobby_revision: number } | undefined;
  if (!draft) throw new DraftLobbyApiError("Draft not found", "DRAFT_NOT_FOUND");
  if (context.hostOnly && draft.created_by_user_id !== context.userId) {
    throw new DraftLobbyApiError("Only the draft host can manage this lobby", "HOST_REQUIRED");
  }
  if (draft.status !== "pending") throw new DraftLobbyApiError("Draft is no longer pending", "DRAFT_NOT_PENDING");
  return draft;
}

export async function runDraftLobbyRoute(
  params: Promise<{ slug: string }>, hostOnly: boolean,
  action: (context: DraftLobbyContext) => Response | Promise<Response>,
): Promise<Response> {
  try {
    const actor = await requireWebAccess();
    if (!actor.ok) return actor.response;
    const { slug } = await params;
    const db = getDb();
    const draft = db.prepare("select id from drafts where web_slug = ? and guild_id = ?")
      .get(slug, env.discordGuildId) as { id: number } | undefined;
    if (!draft) throw new DraftLobbyApiError("Draft not found", "DRAFT_NOT_FOUND");
    const context = { db, draftId: draft.id, slug, userId: actor.userId, hostOnly };
    assertDraftLobbyAccess(context);
    return await action(context);
  } catch (error) { return draftLobbyErrorResponse(error); }
}

export function projectDraftLobbyResponse(response: DraftLobbyResponse): DraftLobbyResponse {
  return {
    lobby: response.lobby,
    players: response.players.map((p) => ({
      playerId: p.playerId, displayName: p.displayName, seatIndex: p.seatIndex,
      pickCount: p.pickCount, finishedAt: p.finishedAt, joinedAt: p.joinedAt,
      isHost: p.isHost, isYou: p.isYou, isBot: p.isBot, ready: p.ready,
      readyAt: p.readyAt, cubeId: p.cubeId,
    })),
  };
}

export function commitDraftLobbyMutation(
  context: DraftLobbyContext,
  mutate: (service: ReturnType<typeof createDraftLobbyApi>) => DraftLobbyResponse,
  status = 200,
): Response {
  const response = context.db.transaction(() => {
    assertDraftLobbyAccess(context);
    return projectDraftLobbyResponse(mutate(createDraftLobbyApi(context.db)));
  }).immediate();
  void notifyDraftLobbySeats(context.slug);
  return NextResponse.json(response, { status });
}

export async function readLobbyBody(request: Request, optional = false): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    const text = await request.text();
    body = optional && !text.trim() ? {} : JSON.parse(text);
  } catch { throw new DraftLobbyApiError("Invalid JSON body", "INVALID_BODY"); }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new DraftLobbyApiError("Expected an object body", "INVALID_BODY");
  }
  return body as Record<string, unknown>;
}

export function validLobbyRevision(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export async function notifyDraftLobbySeats(slug: string) {
  const results = await Promise.allSettled([broadcaster.draft({ kind: "seats", slug })]);
  for (const result of results) if (result.status === "rejected") console.error("[draft lobby] seats notification failed:", result.reason);
}

export async function notifyDraftLobbyTick(result: DraftLobbyTickResult) {
  const startedSlugs = new Set(result.started.map((d) => d.webSlug));
  const deliveries: Promise<unknown>[] = result.changedSlugs.filter((slug) => !startedSlugs.has(slug))
    .map((slug) => broadcaster.draft({ kind: "seats", slug }));
  for (const draft of result.started) {
    if (draft.webSlug) deliveries.push(broadcaster.draft({ kind: "status", slug: draft.webSlug, status: "active" }));
    if (env.discordBotEnabled && draft.channelId) deliveries.push(announcer.announce({
      kind: "draft-started", draftId: draft.id, channelId: draft.channelId,
      name: draft.name, webSlug: draft.webSlug ?? "",
    }));
  }
  const results = await Promise.allSettled(deliveries);
  for (const delivery of results) if (delivery.status === "rejected") console.error("[draft lobby] transition notification failed:", delivery.reason);
}


/** Rules/pools affect all seats; an assignment edit affects only changed seats. */
export function draftConfigInvalidation(before: DraftConfig, after: DraftConfig, playerIds: number[]) {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)]));
    }
    return value;
  };
  const rules = (config: DraftConfig) => {
    const { themeAssignments: _assignments, draftType: _metadata, poolSource, ...rules } = config;
    return JSON.stringify(canonical({ ...rules, ...(poolSource ? { poolSource: { cubeId: poolSource.cubeId } } : {}) }));
  };
  if (rules(before) !== rules(after)) return { clearReady: true };
  const changedSeats = playerIds.filter((id) => before.themeAssignments?.[String(id)] !== after.themeAssignments?.[String(id)]);
  return { clearReady: false, ...(changedSeats.length ? { playerIds: changedSeats } : {}) };
}


/** Reject collection shapes that catalog hydration and lobby hashing cannot read. */
export function assertDraftConfigShape(config: Partial<DraftConfig>) {
  for (const key of ["customCardIds", "customExtraCardIds", "cubeCardIds", "poolCardIds", "allowedCubeIds"] as const) {
    const ids = config[key];
    if (ids !== undefined && (!Array.isArray(ids) || ids.some((id) => !Number.isSafeInteger(id) || id <= 0))) {
      throw new DraftLobbyApiError(`${key} must be a list of positive IDs`, "INVALID_CONFIG");
    }
  }
  for (const key of ["setNames", "includeNames", "excludeNames"] as const) {
    const names = config[key];
    if (names !== undefined && (!Array.isArray(names) || names.some((name) => typeof name !== "string"))) {
      throw new DraftLobbyApiError(`${key} must be a list of names`, "INVALID_CONFIG");
    }
  }
  const assignments = config.themeAssignments;
  // A null cube ID is an unassigned seat; hostThemeAssignmentError checks roster completeness.
  if (assignments !== undefined && (!assignments || typeof assignments !== "object" || Array.isArray(assignments)
    || Object.entries(assignments).some(([playerId, cubeId]) => !/^\d+$/.test(playerId)
      || !Number.isSafeInteger(Number(playerId)) || Number(playerId) <= 0
      || (cubeId !== null && (!Number.isSafeInteger(cubeId) || cubeId <= 0))))) {
    throw new DraftLobbyApiError("themeAssignments must map player IDs to positive cube IDs", "INVALID_CONFIG");
  }
  if (config.mode !== undefined && config.mode !== "booster" && config.mode !== "theme") {
    throw new DraftLobbyApiError("Invalid draft mode", "INVALID_CONFIG");
  }
  if (config.themeSelection !== undefined && !["player_pick", "random", "host_assigned"].includes(config.themeSelection)) {
    throw new DraftLobbyApiError("Invalid theme selection", "INVALID_CONFIG");
  }
}

function assertStartCubeGuilds(context: DraftLobbyContext) {
  const draft = createDraftService(context.db).findById(context.draftId);
  const findCube = context.db.prepare("select guild_id from cubes where id = ?");
  for (const cubeId of draft.config.allowedCubeIds ?? []) {
    const row = findCube.get(cubeId) as { guild_id: string } | undefined;
    if (row && row.guild_id !== draft.guildId) throw new DraftLobbyApiError("Cube not found", "CUBE_NOT_FOUND");
  }
  if (draft.config.mode === "theme" && (draft.config.themeSelection ?? "player_pick") === "player_pick") {
    const claims = context.db.prepare("select cube_id from draft_player_cube where draft_id = ?")
      .all(draft.id) as Array<{ cube_id: number }>;
    for (const claim of claims) {
      const cube = findCube.get(claim.cube_id) as { guild_id: string } | undefined;
      if (!cube || cube.guild_id !== draft.guildId) throw new DraftLobbyApiError("Cube not found", "CUBE_NOT_FOUND");
      if (!(draft.config.allowedCubeIds ?? []).includes(claim.cube_id)) {
        throw new DraftLobbyApiError("Claimed cube is not allowed in this draft", "CUBE_NOT_ALLOWED");
      }
    }
  }
}

/** Root POST uses the same handler; its empty body captures the current revision. */
export async function handleDraftStart(request: Request, params: Promise<{ slug: string }>, compatibility = false) {
  return runDraftLobbyRoute(params, true, async (context) => {
    const capturedRevision = assertDraftLobbyAccess(context).lobby_revision;
    const body = await readLobbyBody(request, compatibility);
    const revision = compatibility && body.revision === undefined ? capturedRevision : body.revision;
    if (!validLobbyRevision(revision) || (body.force !== undefined && typeof body.force !== "boolean")) {
      throw new DraftLobbyApiError("revision and optional force are invalid", "INVALID_BODY");
    }
    const draft = createDraftService(context.db).findById(context.draftId);
    const denied = cubeReferenceAccess(context.db, draft.config.allowedCubeIds, { allowMissing: true });
    if (denied) return denied;
    assertStartCubeGuilds(context);
    const cards = createCardCatalogService(context.db);
    const lookupBudget = createCardLookupBudget();
    if (!draft.config.cubeCardIds?.length && !draft.config.poolCardIds?.length) {
      await cards.syncDraftPool({
        setNames: draft.config.setNames ?? [], customCardIds: draft.config.customCardIds ?? [],
        includeNames: draft.config.includeNames ?? [], excludeNames: draft.config.excludeNames ?? [],
      }, { lookupBudget });
    }
    if (draft.config.mode !== "theme") await ensureCatalogCards(cards, draft.config.customExtraCardIds ?? [], lookupBudget);
    return commitDraftLobbyMutation(context, (service) => {
      assertDraftLobbyAccess(context);
      // scheduleStart compares the submitted/captured revision and recognizes
      // an identical existing schedule without extending its deadline.
      assertStartCubeGuilds(context);
      return service.scheduleStart(context.draftId, context.userId, { revision, force: body.force === true });
    }, 202);
  });
}
