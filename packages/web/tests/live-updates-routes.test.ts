import { fixtureUserId, fixtureDiscordId, seedFixtureUsers } from "./fixtures/identity";
import Database from "better-sqlite3";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { migrate } from "../../shared/src/db/schema";
import {
  createCardCatalogService, createCubeService, createDraftLobbyService, createDraftService, createPlayerService,
  createSavedDeckService, createTournamentService,
} from "../../shared/src/services/index";

const { auth, broadcaster, callDuelHost } = vi.hoisted(() => ({
  auth: vi.fn(),
  broadcaster: { draft: vi.fn().mockResolvedValue(undefined), tournament: vi.fn().mockResolvedValue(undefined) },
  callDuelHost: vi.fn(),
}));
let db: Database.Database;
vi.mock("@/lib/session-identity", async () => {
  const { sessionFixture } = await import("./fixtures/session");
  return sessionFixture(auth);
});
vi.mock("@/lib/db", () => ({ getDb: () => db }));
vi.mock("@/lib/env", () => ({ env: { discordGuildId: "guild", discordDefaultChannelId: "channel" } }));
vi.mock("@/lib/notify", () => ({ broadcaster, announcer: { announce: vi.fn().mockResolvedValue(undefined) } }));
vi.mock("@/lib/notify-duel", () => ({ notifyDuelChange: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/duel-host", () => ({ callDuelHost }));
// Use the same service source as the in-memory fixtures without requiring a build.
vi.mock("@yugidraft/shared/services", () => import("../../shared/src/services/index"));
vi.mock("@yugidraft/shared/duels", () => import("../../shared/src/duels/index"));

function fixture(packSize = 2) {
  const players = createPlayerService(db);
  const a = players.findOrCreate("guild", fixtureUserId("creator"), "Yugi");
  const b = players.findOrCreate("guild", fixtureUserId("opponent"), "Kaiba");
  const drafts = createDraftService(db);
  const ids = Array.from({ length: 80 }, (_, i) => i + 1);
  const insert = db.prepare(`insert into card_catalog
    (ygoprodeck_id, name, type, frame_type, image_url, image_url_small, card_sets_json, cached_at)
    values (?, ?, 'Normal Monster', 'normal', '', '', '[]', '2026-01-01')`);
  for (const id of ids) insert.run(id, `Card ${id}`);
  const draft = drafts.create("guild", "channel", "Draft", { cubeCardIds: ids, packSize, packsPerPlayer: 1, cardsPerPlayer: packSize, pickSeconds: 45 }, fixtureUserId("creator"), a.id);
  drafts.join(draft.id, b.id);
  db.prepare("update drafts set web_slug = 'draft-cup' where id = ?").run(draft.id);
  const tournaments = createTournamentService(db);
  const tournament = tournaments.create("guild", "Cup", "round_robin", fixtureUserId("creator"));
  tournaments.join(tournament.id, a.id);
  tournaments.join(tournament.id, b.id);
  db.prepare("update tournaments set web_slug = 'cup' where id = ?").run(tournament.id);
  return { a, b, draft, drafts, tournament, tournaments };
}

const draftCtx = { params: Promise.resolve({ slug: "draft-cup" }) };
const tournamentCtx = { params: Promise.resolve({ slug: "cup" }) };
function request(method: string, body?: unknown) {
  return new NextRequest("http://localhost/api", { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}

describe("draft and tournament route broadcasts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:01:00Z"));
    db = new Database(":memory:");
    migrate(db);
    seedFixtureUsers(db, FIXTURE_KEYS);
    auth.mockResolvedValue({ user: { id: String(fixtureUserId("creator")), discordUserId: fixtureDiscordId("creator"), name: "Yugi" } });
  });
  afterEach(() => {
    db.close();
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("the web draft POST schedules a start and broadcasts active only after the server countdown", async () => {
    const { draft, drafts } = fixture();
    const route = await import("../app/api/drafts/[slug]/route");
    const rejected = await route.POST(request("POST"), draftCtx);
    expect(rejected.status).toBe(409);
    expect(await rejected.json()).toMatchObject({ code: "NOT_READY" });
    expect(broadcaster.draft).not.toHaveBeenCalled();

    // Pressing Start acknowledges the host; only the guest needs to mark Ready.
    const lobby = createDraftLobbyService(db);
    lobby.setReady(draft.id, fixtureUserId("opponent"), true);
    expect(lobby.read(draft.id).players.find(player => player.isHost)?.ready).toBe(false);
    const scheduled = await route.POST(request("POST"), draftCtx);
    expect(scheduled.status).toBe(202);
    expect(await scheduled.json()).toMatchObject({ lobby: { start: {
      kind: "manual", startsAt: "2026-01-01T00:01:05.000Z",
    } } });
    expect(drafts.findById(draft.id).status).toBe("pending");
    expect(db.prepare("select count(*) as count from draft_packs where draft_id = ?").get(draft.id)).toEqual({ count: 0 });
    expect(broadcaster.draft).toHaveBeenCalledExactlyOnceWith({ kind: "seats", slug: "draft-cup" });

    broadcaster.draft.mockClear();
    vi.setSystemTime(new Date("2026-01-01T00:01:04.999Z"));
    expect((await (await route.GET(request("GET"), draftCtx)).json()).status).toBe("pending");
    expect(broadcaster.draft).not.toHaveBeenCalled();
    vi.setSystemTime(new Date("2026-01-01T00:01:05.000Z"));
    expect((await (await route.GET(request("GET"), draftCtx)).json()).status).toBe("active");
    expect(db.prepare("select count(*) as count from draft_packs where draft_id = ?").get(draft.id)).toEqual({ count: 2 });
    expect(broadcaster.draft).toHaveBeenCalledExactlyOnceWith({ kind: "status", slug: "draft-cup", status: "active" });
    broadcaster.draft.mockClear();
    expect((await route.GET(request("GET"), draftCtx)).status).toBe(200);
    expect(broadcaster.draft).not.toHaveBeenCalled();
  });

  it("the web draft DELETE action broadcasts", async () => {
    fixture();
    const route = await import("../app/api/drafts/[slug]/route");
    expect((await route.DELETE(request("DELETE"), draftCtx)).status).toBe(200);
    expect(broadcaster.draft).toHaveBeenCalledExactlyOnceWith({ kind: "status", slug: "draft-cup", status: "cancelled" });
  });

  it.each([
    ["POST", { kind: "started", slug: "cup" }],
    ["DELETE", { kind: "cancelled", slug: "cup" }],
  ] as const)("the web tournament %s action broadcasts", async (method, payload) => {
    fixture();
    const route = await import("../app/api/tournaments/[slug]/route");
    expect((await route[method](request(method), tournamentCtx)).status).toBe(200);
    expect(broadcaster.tournament).toHaveBeenCalledExactlyOnceWith(payload);
  });

  it.each(["completed", "cancelled"])("deleting a %s draft refreshes open pages", async (status) => {
    const { draft } = fixture();
    db.prepare("update drafts set status = ? where id = ?").run(status, draft.id);
    const { DELETE } = await import("../app/api/drafts/[slug]/route");
    expect((await DELETE(request("DELETE"), draftCtx)).status).toBe(200);
    expect(broadcaster.draft).toHaveBeenCalledExactlyOnceWith({ kind: "seats", slug: "draft-cup" });
  });

  it.each([{ name: "Renamed" }, { config: { mode: "theme", allowedCubeIds: [] } }])("editing a draft refreshes open pages: %j", async (body) => {
    if (body.config?.mode === "theme") vi.stubEnv("THEME_DRAFTS", "1");
    fixture();
    const { PUT } = await import("../app/api/drafts/[slug]/route");
    expect((await PUT(request("PUT", body), draftCtx)).status).toBe(200);
    expect(broadcaster.draft).toHaveBeenCalledExactlyOnceWith({ kind: "seats", slug: "draft-cup" });
  });

  it("adding and detaching a draft cube each refresh the lobby once", async () => {
    const { draft } = fixture();
    db.prepare("update drafts set config_json = ? where id = ?").run(JSON.stringify({ mode: "theme", allowedCubeIds: [] }), draft.id);
    const { POST, DELETE } = await import("../app/api/drafts/[slug]/cubes/route");
    const response = await POST(request("POST", { kind: "blank", name: "Cube" }), draftCtx);
    expect(response.status).toBe(201);
    const { cube } = await response.json();
    expect(broadcaster.draft).toHaveBeenCalledExactlyOnceWith({ kind: "seats", slug: "draft-cup" });
    broadcaster.draft.mockClear();
    expect((await DELETE(request("DELETE", { cubeId: cube.id }), draftCtx)).status).toBe(200);
    expect(broadcaster.draft).toHaveBeenCalledExactlyOnceWith({ kind: "seats", slug: "draft-cup" });
  });

  it("claiming a draft cube refreshes the lobby", async () => {
    const { draft } = fixture();
    const cube = createCubeService(db, createCardCatalogService(db)).createBlank("guild", "Cube", fixtureUserId("creator"));
    db.prepare("update drafts set config_json = ? where id = ?").run(JSON.stringify({ mode: "theme", allowedCubeIds: [cube.id] }), draft.id);
    const { POST } = await import("../app/api/drafts/[slug]/claim-cube/route");
    expect((await POST(request("POST", { cubeId: cube.id }), draftCtx)).status).toBe(200);
    expect(broadcaster.draft).toHaveBeenCalledExactlyOnceWith({ kind: "seats", slug: "draft-cup" });
  });

  it("creating a tournament refreshes its linked draft once", async () => {
    const { draft } = fixture();
    db.prepare("update drafts set status = 'completed' where id = ?").run(draft.id);
    const { POST } = await import("../app/api/drafts/[slug]/tournament/route");
    expect((await POST(request("POST", { format: "round_robin" }), draftCtx)).status).toBe(201);
    expect(broadcaster.draft).toHaveBeenCalledExactlyOnceWith({ kind: "seats", slug: "draft-cup" });
    broadcaster.draft.mockClear();
    expect((await POST(request("POST", { format: "round_robin" }), draftCtx)).status).toBe(409);
    expect(broadcaster.draft).not.toHaveBeenCalled();
  });

  it.each(["PUT", "PATCH"] as const)("a tournament rename via %s refreshes open pages", async (method) => {
    fixture();
    const route = await import("../app/api/tournaments/[slug]/route");
    expect((await route[method](request(method, { name: "Renamed" }), tournamentCtx)).status).toBe(200);
    expect(broadcaster.tournament).toHaveBeenCalledExactlyOnceWith({ kind: "match-updated", slug: "cup" });
  });

  it("registering a tournament deck refreshes open pages", async () => {
    fixture();
    const deck = { main: [1, 2, 3], extra: [], side: [] };
    const saved = createSavedDeckService(db).create("guild", fixtureUserId("creator"), { name: "Deck", mode: "normal", deck });
    callDuelHost.mockResolvedValue({ ok: true, data: { deck, report: { issues: [] } } });
    const { PUT } = await import("../app/api/tournaments/[slug]/deck/route");
    expect((await PUT(request("PUT", { savedDeckId: saved.id }), tournamentCtx)).status).toBe(200);
    expect(broadcaster.tournament).toHaveBeenCalledExactlyOnceWith({ kind: "match-updated", slug: "cup" });
  });

  it("saving and editing a draft deck each refresh its tournament registration", async () => {
    const { a, draft, tournament } = fixture();
    db.prepare("update drafts set status = 'completed', tournament_id = ? where id = ?").run(tournament.id, draft.id);
    const savedDecks = createSavedDeckService(db);
    const deck = savedDecks.create("guild", fixtureUserId("creator"), {
      name: "Draft deck", mode: "normal", draftId: draft.id, deck: { main: [1, 2], extra: [], side: [] },
    });
    const { registerDraftDeck } = await import("../app/api/decks/draft-deck");
    const context = { id: draft.id, name: "Draft", status: "completed", tournamentId: tournament.id, playerId: a.id };
    expect(registerDraftDeck(context, deck)).toBeUndefined();
    expect(broadcaster.tournament).toHaveBeenCalledExactlyOnceWith({ kind: "match-updated", slug: "cup" });
    broadcaster.tournament.mockClear();
    const updated = savedDecks.update(deck.id, "guild", fixtureUserId("creator"), {
      name: "Updated deck", mode: "normal", deck: { main: [2, 3], extra: [], side: [] },
    });
    expect(registerDraftDeck(context, updated)).toBeUndefined();
    expect(broadcaster.tournament).toHaveBeenCalledExactlyOnceWith({ kind: "match-updated", slug: "cup" });
    broadcaster.tournament.mockClear();
    db.prepare("update tournament_participants set deck_locked_at = '2026-01-01' where tournament_id = ? and player_id = ?").run(tournament.id, a.id);
    expect(registerDraftDeck(context, updated)).toBeUndefined();
    expect(broadcaster.tournament).not.toHaveBeenCalled();
  });

  it("a failed draft pool edit neither renames the draft nor broadcasts", async () => {
    fixture();
    const { PUT } = await import("../app/api/drafts/[slug]/route");
    expect((await PUT(request("PUT", { name: "Renamed", config: { setNames: [], customCardIds: [] } }), draftCtx)).status).toBe(400);
    expect(db.prepare("select name from drafts where web_slug = 'draft-cup'").get()).toEqual({ name: "Draft" });
    expect(broadcaster.draft).not.toHaveBeenCalled();
  });

  it.each([
    [2, { kind: "resync", slug: "draft-cup", packRound: 1, pickStep: 2 }],
    [1, { kind: "complete", slug: "draft-cup" }],
  ])("expiry during a draft read broadcasts progress for pack size %s", async (packSize, payload) => {
    const { drafts, draft } = fixture(packSize as number);
    drafts.start(draft.id, new Date("2026-01-01T00:00:00Z"));
    const { GET } = await import("../app/api/drafts/[slug]/route");
    expect((await GET(request("GET"), draftCtx)).status).toBe(200);
    expect(broadcaster.draft).toHaveBeenCalledExactlyOnceWith(payload);
    broadcaster.draft.mockClear();
    expect((await GET(request("GET"), draftCtx)).status).toBe(200);
    expect(broadcaster.draft).not.toHaveBeenCalled();
  });

  it("does not broadcast a failed start or an unauthorized edit", async () => {
    const { tournament } = fixture();
    db.prepare("update tournaments set visibility = 'open' where id = ?").run(tournament.id);
    db.prepare("delete from tournament_participants where tournament_id = ?").run(tournament.id);
    const route = await import("../app/api/tournaments/[slug]/route");
    expect((await route.POST(request("POST"), tournamentCtx)).status).toBe(400);
    auth.mockResolvedValue({ user: { id: String(fixtureUserId("outsider")), discordUserId: fixtureDiscordId("outsider") } });
    expect((await route.PUT(request("PUT", { name: "Wrong" }), tournamentCtx)).status).toBe(403);
    expect(broadcaster.tournament).not.toHaveBeenCalled();
  });
});

const FIXTURE_KEYS = ["creator", "opponent", "outsider"] as const;

// Session resolution is mocked; authorization still runs through the real web boundary.
