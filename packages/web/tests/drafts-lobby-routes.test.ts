import { fixtureUserId, fixtureDiscordId, seedFixtureUsers } from "./fixtures/identity";
import Database from "better-sqlite3";
import { migrate } from "@yugidraft/shared/db";
import * as sharedServices from "@yugidraft/shared/services";
import { createDraftService, TEST_BOT_DISCORD_PREFIX } from "@yugidraft/shared/services";
import type { DraftLobbyResponse } from "@yugidraft/shared/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Drive the real persisted lobby through its deadline without waiting on wall time. */
export async function finishTestLobbyStart(response: Response, database?: Database.Database) {
  expect(response.status).toBe(202);
  const body = await response.clone().json() as DraftLobbyResponse;
  expect(body.lobby.start?.kind).toBe("manual");
  const db = database ?? (await import("@/lib/db")).getDb();
  const row = db.prepare("select id from drafts where lobby_start_token = ?").get(body.lobby.start!.token) as { id: number };
  expect(db.prepare("select count(*) as n from draft_cards where draft_id = ?").get(row.id)).toEqual({ n: 0 });
  const { createDraftLobbyApi } = await vi.importActual<typeof import("@/lib/draft-lobby-api")>("@/lib/draft-lobby-api");
  const api = createDraftLobbyApi(db);
  const deadline = new Date(body.lobby.start!.startsAt).getTime();
  expect(api.tick(deadline - 1, row.id).started).toHaveLength(0);
  const result = api.tick(deadline, row.id);
  expect(result.started).toHaveLength(1);
  expect(api.tick(deadline + 1, row.id).started).toHaveLength(0);
  return result.started[0];
}

const auth = vi.hoisted(() => vi.fn());
const getDb = vi.hoisted(() => vi.fn());
const notify = vi.hoisted(() => ({ announcer: { announce: vi.fn() }, broadcaster: { draft: vi.fn() } }));
const service = vi.hoisted(() => ({
  read: vi.fn(), setReady: vi.fn(), leave: vi.fn(), removePlayer: vi.fn(), scheduleStart: vi.fn(),
  stopStart: vi.fn(), setAutoStart: vi.fn(), invalidate: vi.fn(), tick: vi.fn(),
}));
// Importing the deadline helper from a regression suite must not register this suite again.
if (expect.getState().testPath?.endsWith("/drafts-lobby-routes.test.ts")) describe("browser lobby contracts", () => {
  let db: Database.Database;
  let projection: DraftLobbyResponse;
  const context = { params: Promise.resolve({ slug: "lobby" }) };
  const request = (method: string, body?: unknown) => new Request("http://localhost/api/drafts/lobby", {
    method, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("THEME_DRAFTS", "1"); vi.clearAllMocks();
vi.doMock("@/lib/session-identity", async () => {
  const { sessionFixture } = await import("./fixtures/session");
  return sessionFixture(auth);
});
vi.doMock("@/lib/db", () => ({ getDb }));
vi.doMock("@/lib/notify", () => notify);
vi.doMock("@/lib/draft-engine-types", () => ({ lookupDraftCardTypes: async () => new Map() }));
vi.doMock("@/lib/draft-lobby-api", async () => ({
  ...await vi.importActual<typeof import("@/lib/draft-lobby-api")>("@/lib/draft-lobby-api"), createDraftLobbyApi: () => service,
}));


    vi.stubEnv("DISCORD_GUILD_ID", "guild");
    vi.stubEnv("DISCORD_BOT_ENABLED", "1");
    vi.stubEnv("DUEL_DATA_DIR", "/tmp/ds-t04-unused-engine");
    db = new Database(":memory:"); migrate(db); seedFixtureUsers(db, FIXTURE_KEYS); getDb.mockReturnValue(db);
    db.exec(`insert into players (guild_id, user_id, discord_user_id, display_name) values ('guild', ${fixtureUserId("host")}, '${fixtureDiscordId("host")}', 'Host');
      insert into drafts (guild_id, channel_id, name, status, created_by_user_id, config_json, web_slug, visibility)
      values ('guild','channel','Lobby','pending',${fixtureUserId("host")},'{"mode":"theme","themeSelection":"random","allowedCubeIds":[]}', 'lobby', 'open');
      insert into draft_players (draft_id, player_id) values (1,1);`);
    auth.mockResolvedValue({ user: { id: String(fixtureUserId("host")) } });
    projection = sharedServices.createDraftLobbyService(db).read(1, fixtureUserId("host"));
    for (const name of ["read", "setReady", "leave", "removePlayer", "scheduleStart", "stopStart", "setAutoStart"] as const) {
      service[name].mockReturnValue(projection);
    }
    service.tick.mockReturnValue({ started: [], changedSlugs: [] });
  });
  afterEach(() => { db.close(); vi.useRealTimers(); vi.unstubAllEnvs(); });

  async function route(action: string, method: "POST" | "PUT" | "DELETE", body?: unknown, params = context) {
    const routes = {
      ready: () => import("../app/api/drafts/[slug]/ready/route"),
      leave: () => import("../app/api/drafts/[slug]/join/route"),
      remove: () => import("../app/api/drafts/[slug]/players/[playerId]/route"),
      start: () => import("../app/api/drafts/[slug]/start/route"),
      auto: () => import("../app/api/drafts/[slug]/auto-start/route"),
    };
    const module = await routes[action as keyof typeof routes]();
    return (module as any)[method](request(method, body), params);
  }

  it.each(["ready", "leave", "remove", "start", "auto"])("requires a session for %s", async (action) => {
    auth.mockResolvedValue(null);
    expect((await route(action, action === "auto" ? "PUT" : action === "leave" || action === "remove" ? "DELETE" : "POST")).status).toBe(401);
  });
  it.each(["ready", "leave", "remove", "start", "auto"])("hides a foreign guild lobby at %s", async (action) => {
    db.prepare("update drafts set guild_id = 'foreign'").run();
    expect((await route(action, action === "auto" ? "PUT" : action === "leave" || action === "remove" ? "DELETE" : "POST")).status).toBe(404);
    expect(service.read).not.toHaveBeenCalled();
  });
  it.each(["ready", "leave", "remove", "start", "auto"])("conflicts after start at %s", async (action) => {
    db.prepare("update drafts set status = 'active'").run();
    expect((await route(action, action === "auto" ? "PUT" : action === "leave" || action === "remove" ? "DELETE" : "POST")).status).toBe(409);
  });
  it.each(["remove", "start", "auto"])("requires host ownership at %s", async (action) => {
    auth.mockResolvedValue({ user: { id: String(fixtureUserId("viewer")) } });
    expect((await route(action, action === "auto" ? "PUT" : action === "remove" ? "DELETE" : "POST")).status).toBe(403);
  });
  it.each([{}, { ready: "true" }, { ready: 1 }, null, []])("rejects invalid Ready body %j", async (body) => {
    expect((await route("ready", "POST", body)).status).toBe(400);
    expect(service.setReady).not.toHaveBeenCalled();
  });
  it("sets Ready for the session identity and returns the shared projection", async () => {
    const response = await route("ready", "POST", { ready: true, playerId: 999 });
    expect(response.status).toBe(200); expect(await response.json()).toEqual(projection);
    expect(service.setReady).toHaveBeenCalledWith(1, fixtureUserId("host"), true);
    expect(notify.broadcaster.draft).toHaveBeenCalledWith({ kind: "seats", slug: "lobby" });
  });
  it("allows the host to leave without losing ownership", async () => {
    expect((await route("leave", "DELETE")).status).toBe(200);
    expect(service.leave).toHaveBeenCalledWith(1, fixtureUserId("host"));
    expect(db.prepare("select created_by_user_id from drafts").get()).toEqual({ created_by_user_id: fixtureUserId("host") });
  });
  it.each(["bad", "0", "-1", "1.5", "9007199254740992"])("validates player path %s", async (playerId) => {
    expect((await route("remove", "DELETE", undefined, { params: Promise.resolve({ slug: "lobby", playerId }) } as any)).status).toBe(400);
  });
  it("passes the scoped player ID to the host removal service", async () => {
    expect((await route("remove", "DELETE", undefined, { params: Promise.resolve({ slug: "lobby", playerId: "2" }) } as any)).status).toBe(200);
    expect(service.removePlayer).toHaveBeenCalledWith(1, fixtureUserId("host"), 2);
  });
  it.each([{}, { revision: -1 }, { revision: 0.5 }, { revision: "0" }, { revision: 0, force: "yes" }])("validates start body %j", async (body) => {
    expect((await route("start", "POST", body)).status).toBe(400);
  });
  it("schedules a 202 response without dealing or announcing a start", async () => {
    const response = await route("start", "POST", { revision: 0, force: true });
    expect(response.status).toBe(202); expect(await response.json()).toEqual(projection);
    expect(service.scheduleStart).toHaveBeenCalledWith(1, fixtureUserId("host"), { revision: 0, force: true });
    expect(db.prepare("select count(*) as n from draft_cards").get()).toEqual({ n: 0 });
    expect(notify.announcer.announce).not.toHaveBeenCalled();
  });
  it("maps service conflict details without losing NOT_READY information", async () => {
    const { DraftLobbyServiceError } = await import("@yugidraft/shared/services");
    service.scheduleStart.mockImplementationOnce(() => { throw new DraftLobbyServiceError("Confirm unready seats", "NOT_READY", {
      notReadyPlayerIds: [1], unclaimedPlayerIds: [1],
    }); });
    const response = await route("start", "POST", { revision: 0 });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "Confirm unready seats", code: "NOT_READY", notReadyPlayerIds: [1], unclaimedPlayerIds: [1] });
    expect(notify.broadcaster.draft).not.toHaveBeenCalled();
  });
  it.each([{}, { token: "" }, { token: 1 }])("validates Stop body %j", async (body) => {
    expect((await route("start", "DELETE", body)).status).toBe(400);
  });
  it("stops by token and forwards explicit Resume", async () => {
    expect((await route("start", "DELETE", { token: "schedule" })).status).toBe(200);
    expect(service.stopStart).toHaveBeenCalledWith(1, fixtureUserId("host"), "schedule");
    expect((await route("auto", "PUT", { enabled: true, held: false, revision: 0 })).status).toBe(200);
    expect(service.setAutoStart).toHaveBeenCalledWith(1, fixtureUserId("host"), { enabled: true, held: false, revision: 0 });
  });
  it.each([{}, { enabled: 1, revision: 0 }, { enabled: true }, { enabled: true, held: "no", revision: 0 }])("validates auto-start body %j", async (body) => {
    expect((await route("auto", "PUT", body)).status).toBe(400);
  });
  it("runs a scoped pending GET tick and notifies only committed starts", async () => {
    db.prepare("update drafts set lobby_start_token = 'schedule' where id = 1").run();
    const draft = createDraftService(db).findById(1);
    service.tick.mockImplementationOnce(() => {
      db.prepare("update drafts set status = 'active'").run();
      return { started: [{ ...draft, status: "active" }], changedSlugs: ["lobby"] };
    });
    const { GET } = await import("../app/api/drafts/[slug]/route");
    const response = await GET(request("GET"), context);
    expect(response.status).toBe(200); expect((await response.json()).lobby).toBeUndefined();
    expect(service.tick).toHaveBeenCalledWith(expect.any(Number), 1);
    expect(notify.broadcaster.draft).toHaveBeenCalledWith({ kind: "status", slug: "lobby", status: "active" });
    expect(notify.announcer.announce).toHaveBeenCalledWith(expect.objectContaining({ kind: "draft-started", draftId: 1 }));
  });
  it.each([{ enabled: 0, held: 0 }, { enabled: 0, held: 1 }, { enabled: 1, held: 1 }])(
    "skips the GET fallback tick for an idle or held lobby: %j", async ({ enabled, held }) => {
      db.prepare("update drafts set lobby_auto_start = ?, lobby_auto_held = ? where id = 1").run(enabled, held);
      const { GET } = await import("../app/api/drafts/[slug]/route");
      const response = await GET(request("GET"), context);
      expect(response.status).toBe(200);
      expect((await response.json()).lobby).toEqual(projection.lobby);
      expect(service.tick).not.toHaveBeenCalled();
      expect(notify.broadcaster.draft).not.toHaveBeenCalled();
    },
  );
  it("runs the GET fallback tick for auto-start eligibility without a countdown", async () => {
    db.prepare("update drafts set lobby_auto_start = 1 where id = 1").run();
    const { GET } = await import("../app/api/drafts/[slug]/route");
    expect((await GET(request("GET"), context)).status).toBe(200);
    expect(service.tick).toHaveBeenCalledExactlyOnceWith(expect.any(Number), 1);
  });
  it("defaults new web theme lobbies to four seats", async () => {
    vi.stubEnv("DISCORD_DEFAULT_CHANNEL_ID", "channel");
    const { POST } = await import("../app/api/drafts/route");
    const response = await POST(request("POST", { name: "New lobby", config: { mode: "theme" } }) as any);
    expect(response.status).toBe(201);
    const stored = db.prepare("select config_json from drafts where name = 'New lobby'").get() as { config_json: string };
    expect(JSON.parse(stored.config_json).lobbySeats).toBe(4);
  });
  it.each([1, 9, 4.5, "4", null, true])("rejects invalid create seat target %j before writes", async (lobbySeats) => {
    vi.stubEnv("DISCORD_DEFAULT_CHANNEL_ID", "channel");
    const { POST } = await import("../app/api/drafts/route");
    const response = await POST(request("POST", { name: "Bad lobby", config: { mode: "theme", lobbySeats } }) as any);
    expect(response.status).toBe(400);
    expect(db.prepare("select count(*) as n from drafts").get()).toEqual({ n: 1 });
  });
  it("rejects a seat target below the current joined count", async () => {
    db.exec(`insert into players (guild_id, user_id, discord_user_id, display_name) values ('guild', ${fixtureUserId("p2")}, '${fixtureDiscordId("p2")}', 'Two'), ('guild', ${fixtureUserId("p3")}, '${fixtureDiscordId("p3")}', 'Three');
      insert into draft_players (draft_id,player_id) values (1,2),(1,3);`);
    const { PUT } = await import("../app/api/drafts/[slug]/route");
    const response = await PUT(request("PUT", { revision: 0, config: { lobbySeats: 2 } }) as any, context);
    expect(response.status).toBe(409); expect((await response.json()).code).toBe("SEAT_TARGET_TOO_SMALL");
    expect(service.invalidate).not.toHaveBeenCalled();
  });
  it("rejects stale PUT revisions without changing name or config", async () => {
    const { PUT } = await import("../app/api/drafts/[slug]/route");
    const response = await PUT(request("PUT", { revision: 2, name: "Lost edit" }) as any, context);
    expect(response.status).toBe(409); expect((await response.json()).code).toBe("STALE_LOBBY");
    expect(db.prepare("select name from drafts").get()).toEqual({ name: "Lobby" });
  });
  it("returns the lobby on PUT and preserves acknowledgements for a name-only edit", async () => {
    const { PUT } = await import("../app/api/drafts/[slug]/route");
    const response = await PUT(request("PUT", { name: "Renamed", revision: 0 }) as any, context);
    expect(response.status).toBe(200); expect((await response.json()).lobby).toEqual(projection.lobby);
    expect(service.invalidate).toHaveBeenCalledWith(1, { clearReady: false });
  });
  it("projects authored distinct and copy counts and strips internal player fields", async () => {
    db.exec(`insert into card_catalog (ygoprodeck_id,name,type,frame_type,image_url,image_url_small,card_sets_json,cached_at)
      values (1,'Main','Monster','normal','','','[]','now'),(2,'Extra','Fusion Monster','fusion','','','[]','now');
      insert into cubes (guild_id, name, created_by_user_id) values ('guild', 'Cube', ${fixtureUserId("host")});
      insert into cube_cards (cube_id,catalog_card_id,pool,max_copies) values (1,1,'main',5),(1,2,'extra',3);
      update drafts set config_json = '{"mode":"theme","themeSelection":"player_pick","allowedCubeIds":[1]}';
      insert into draft_player_cube (draft_id,player_id,cube_id) values (1,1,1);`);
    projection = sharedServices.createDraftLobbyService(db).read(1, fixtureUserId("viewer"));
    service.read.mockReturnValue({ ...projection, players: projection.players.map((p) => ({ ...p, discordUserId: "secret", readySetupHash: "secret" })) });
    auth.mockResolvedValue({ user: { id: String(fixtureUserId("viewer")) } });
    const { GET } = await import("../app/api/drafts/[slug]/route");
    const response = await GET(request("GET"), context); expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.lobby).toEqual(projection.lobby);
    expect(body.players[0]).toMatchObject({ isHost: true, isYou: false, cubeId: 1 });
    expect(body.players[0]).not.toHaveProperty("discordUserId");
    expect(body.players[0]).not.toHaveProperty("readySetupHash");
    expect(body.allowedCubes[0]).toMatchObject({ mainCount: 1, extraCount: 1, mainDistinct: 1, extraDistinct: 1, mainCopies: 5, extraCopies: 3 });
  });

  it("keeps an observer out if the pending GET fallback commits a start", async () => {
    db.prepare("update drafts set lobby_start_token = 'schedule' where id = 1").run();
    auth.mockResolvedValue({ user: { id: String(fixtureUserId("observer")) } });
    service.tick.mockImplementationOnce(() => { db.prepare("update drafts set status = 'active'").run(); return { started: [], changedSlugs: [] }; });
    const { GET } = await import("../app/api/drafts/[slug]/route");
    expect((await GET(request("GET"), context)).status).toBe(404);
  });
  it("rejects a roster join racing a whole host assignment map", async () => {
    db.exec(`insert into cubes (guild_id, name, created_by_user_id) values ('guild', 'One', ${fixtureUserId("host")}), ('guild', 'Two', ${fixtureUserId("host")});
      update drafts set config_json = '{"mode":"theme","themeSelection":"host_assigned","allowedCubeIds":[1,2],"themeAssignments":{"1":1}}';`);
    const req = request("PUT", { name: "Lost edit", config: { themeAssignments: { "1": 1 } } });
    const text = req.text.bind(req);
    vi.spyOn(req, "text").mockImplementationOnce(async () => {
      db.exec(`insert into players (guild_id, user_id, discord_user_id, display_name) values ('guild', ${fixtureUserId("joining")}, '${fixtureDiscordId("joining")}', 'Two');
        insert into draft_players (draft_id,player_id) values (1,2);
        update drafts set lobby_revision = lobby_revision + 1;`);
      return text();
    });
    const { PUT } = await import("../app/api/drafts/[slug]/route");
    const response = await PUT(req as any, context);
    expect(response.status).toBe(409); expect((await response.json()).code).toBe("STALE_LOBBY");
    expect(db.prepare("select name,lobby_revision from drafts").get()).toEqual({ name: "Lobby", lobby_revision: 1 });
  });

  it("clears acknowledgement only for the seat whose host assignment changes", async () => {
    db.exec(`insert into players (guild_id, user_id, discord_user_id, display_name) values ('guild', ${fixtureUserId("second")}, '${fixtureDiscordId("second")}', 'Two');
      insert into draft_players (draft_id,player_id) values (1,2);
      insert into cubes (guild_id, name, created_by_user_id) values ('guild', 'One', ${fixtureUserId("host")}), ('guild', 'Two', ${fixtureUserId("host")}), ('guild', 'Three', ${fixtureUserId("host")});
      update drafts set config_json = '{"mode":"theme","themeSelection":"host_assigned","allowedCubeIds":[1,2,3],"themeAssignments":{"1":1,"2":2}}';`);
    const { PUT } = await import("../app/api/drafts/[slug]/route");
    const response = await PUT(request("PUT", { config: { themeAssignments: { "1": 3, "2": 2 } }, revision: 0 }) as any, context);
    expect(response.status).toBe(200);
    expect(service.invalidate).toHaveBeenCalledWith(1, { clearReady: false, playerIds: [1] });
  });

  it("lets the shared service recognize an identical Start racing hydration", async () => {
    vi.doMock("@yugidraft/shared/services", async () => {
      const original = await vi.importActual<typeof import("@yugidraft/shared/services")>("@yugidraft/shared/services");
      return { ...original, createCardCatalogService: (database: Database.Database) => ({
        ...original.createCardCatalogService(database), syncDraftPool: async () => {
          db.prepare("update drafts set lobby_revision = 1, lobby_start_token = 'first', lobby_start_kind = 'manual'").run();
        },
      }) };
    });
    const response = await route("start", "POST", { revision: 0 });
    expect(response.status).toBe(202);
    expect(service.scheduleStart).toHaveBeenCalledWith(1, fixtureUserId("host"), { revision: 0, force: false });
    vi.doUnmock("@yugidraft/shared/services");
  });

  it.each([
    { customCardIds: 1 }, { customCardIds: ["1"] }, { cubeCardIds: "1" }, { poolCardIds: {} },
    { setNames: "x" }, { includeNames: [1] }, { excludeNames: null }, { themeAssignments: [] },
  ])("rejects malformed config collections on create and PUT: %j", async (invalid) => {
    vi.stubEnv("DISCORD_DEFAULT_CHANNEL_ID", "channel");
    const before = db.prepare("select name,config_json,lobby_revision from drafts").all();
    const { POST } = await import("../app/api/drafts/route");
    const { PUT } = await import("../app/api/drafts/[slug]/route");
    for (const mode of ["theme", "booster"]) {
      expect((await POST(request("POST", { name: "Malformed", config: { mode, ...invalid } }) as any)).status).toBe(400);
      expect((await PUT(request("PUT", { config: { mode, ...invalid } }) as any, context)).status).toBe(400);
    }
    expect(db.prepare("select name,config_json,lobby_revision from drafts").all()).toEqual(before);
  });

  async function useRealLobbyService() {
    vi.doUnmock("@/lib/draft-lobby-api");
    db.exec(`insert into players (guild_id, user_id, discord_user_id, display_name) values ('guild', ${fixtureUserId("guest")}, '${fixtureDiscordId("guest")}', 'Guest');
      insert into draft_players (draft_id,player_id) values (1,2);
      insert into cubes (guild_id, name, created_by_user_id) values ('guild', 'Theme', ${fixtureUserId("host")});`);
    for (let id = 1; id <= 42; id++) {
      db.prepare(`insert into card_catalog (ygoprodeck_id,name,type,frame_type,image_url,image_url_small,card_sets_json,cached_at)
        values (?,?,'Normal Monster','normal','','','[]','now')`).run(id, `Card ${id}`);
      db.prepare(`insert into cube_cards (cube_id,catalog_card_id,pool,max_copies) values (1,?,'main',1)`).run(id);
    }
    db.prepare("update drafts set config_json = ?").run(JSON.stringify({
      mode: "theme", themeSelection: "random", allowedCubeIds: [1], uniqueThemes: false,
      extraDeckEnabled: false, lobbySeats: 2, cardsPerPlayer: 40, themePackSize: 3, pickSeconds: 45,
    }));
    const { createDraftLobbyApi } = await import("@/lib/draft-lobby-api");
    return createDraftLobbyApi(db);
  }
  it.each(["random", "player_pick"])("schedules and starts a %s theme draft when only the host is not Ready", async (themeSelection) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-07T12:00:00Z"));
    const api = await useRealLobbyService();
    if (themeSelection === "player_pick") {
      const draft = createDraftService(db).findById(1);
      db.prepare("update drafts set config_json = ? where id = 1").run(JSON.stringify({ ...draft.config, themeSelection }));
      db.exec(`insert into draft_player_cube (draft_id,player_id,cube_id) values (1,1,1),(1,2,1)`);
    }
    api.setReady(1, fixtureUserId("guest"), true);
    const response = await route("start", "POST", { revision: api.read(1, fixtureUserId("host")).lobby.revision });
    expect(response.status).toBe(202);
    const state = await response.clone().json() as DraftLobbyResponse;
    expect(state.players.find((p) => p.isHost)).toMatchObject({ ready: false, readyAt: null });
    expect(state.lobby).toMatchObject({ allReady: false, start: { kind: "manual", startsAt: "2026-10-07T12:00:05.000Z" } });
    expect(await finishTestLobbyStart(response, db)).toMatchObject({ id: 1, status: "active" });
  });

  it("returns guest readiness and all unclaimed theme seats when the host presses Start", async () => {
    const api = await useRealLobbyService();
    const draft = createDraftService(db).findById(1);
    db.prepare("update drafts set config_json = ? where id = 1").run(JSON.stringify({ ...draft.config, themeSelection: "player_pick" }));
    const response = await route("start", "POST", { revision: api.read(1, fixtureUserId("host")).lobby.revision });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "NOT_READY", notReadyPlayerIds: [2], unclaimedPlayerIds: [1, 2] });
    expect(api.read(1, fixtureUserId("host")).lobby.start).toBeNull();
  });

  it.each(["manual", "auto"])("starts an unclaimed test bot with a random theme through the %s route", async (kind) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-07T12:00:00Z"));
    const api = await useRealLobbyService();
    const draft = createDraftService(db).findById(1);
    db.prepare("update drafts set config_json = ? where id = 1").run(JSON.stringify({ ...draft.config, themeSelection: "player_pick" }));
    db.prepare("update players set discord_user_id = ? where id = 2").run(`${TEST_BOT_DISCORD_PREFIX}1`);
    db.exec(`insert into draft_player_cube (draft_id,player_id,cube_id) values (1,1,1)`);
    api.setReady(1, fixtureUserId("host"), true);
    const state = api.read(1, fixtureUserId("host"));
    expect(state.players[1]).toMatchObject({ isBot: true, ready: true, cubeId: null });
    expect(state.lobby.autoStart.eligible).toBe(true);
    const response = kind === "manual"
      ? await route("start", "POST", { revision: state.lobby.revision })
      : await route("auto", "PUT", { enabled: true, revision: state.lobby.revision });
    expect(response.status).toBe(kind === "manual" ? 202 : 200);
    const body = await response.json() as DraftLobbyResponse;
    expect(body.lobby.start?.kind).toBe(kind);
    const deadline = new Date(body.lobby.start!.startsAt).getTime();
    expect(api.tick(deadline - 1, 1).started).toHaveLength(0);
    expect(api.tick(deadline, 1).started).toHaveLength(1);
    expect(db.prepare("select cube_id from draft_player_cube where draft_id = 1 and player_id = 2").get()).toEqual({ cube_id: 1 });
    expect(api.tick(deadline + 1, 1).started).toHaveLength(0);
  });

  it.each([undefined, "0", "true", "01", "1"])("returns the explicit Discord flag for DISCORD_BOT_ENABLED=%s", async (enabled) => {
    vi.stubEnv("DISCORD_BOT_ENABLED", enabled);
    const { GET } = await import("../app/api/drafts/[slug]/route");
    for (const status of ["pending", "active", "completed"]) {
      db.prepare("update drafts set status = ? where id = 1").run(status);
      const response = await GET(request("GET"), context);
      expect(response.status).toBe(200);
      expect((await response.json()).discordEnabled).toBe(enabled === "1");
    }
  });
  it.each([
    ["manual", "host"], ["manual", "guest"], ["manual", "member"],
    ["auto", "host"], ["auto", "guest"], ["auto", "member"],
  ])("no bot timer: an expired %s countdown starts once on the next GET by %s", async (kind, viewer) => {
    vi.stubEnv("DISCORD_BOT_ENABLED", undefined);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-07T12:00:00Z"));
    const api = await useRealLobbyService();
    api.setReady(1, fixtureUserId("host"), true);
    api.setReady(1, fixtureUserId("guest"), true);
    const revision = api.read(1, fixtureUserId("host")).lobby.revision;
    const scheduled = kind === "manual"
      ? await route("start", "POST", { revision })
      : await route("auto", "PUT", { enabled: true, revision });
    expect(scheduled.status).toBe(kind === "manual" ? 202 : 200);
    const deadline = (await scheduled.json()).lobby.start.startsAt;
    notify.broadcaster.draft.mockClear();
    notify.announcer.announce.mockClear();
    notify.broadcaster.draft.mockImplementationOnce(() => {
      expect(db.inTransaction).toBe(false);
      expect(createDraftService(db).findById(1).status).toBe("active");
      expect(db.prepare("select count(*) as n from draft_cards where draft_id = 1").get()).toEqual({ n: 6 });
      return Promise.resolve();
    });
    auth.mockResolvedValue({ user: { id: String(fixtureUserId(viewer)) } });
    const { GET } = await import("../app/api/drafts/[slug]/route");
    vi.setSystemTime(new Date(Date.parse(deadline) - 1));
    const pendingResponse = await GET(request("GET"), context);
    expect(pendingResponse.status).toBe(200);
    expect((await pendingResponse.json()).status).toBe("pending");
    expect(db.prepare("select count(*) as n from draft_cards where draft_id = 1").get()).toEqual({ n: 0 });
    // No timer or direct tick runs while the persisted deadline expires.
    vi.setSystemTime(new Date(Date.parse(deadline) + 1));
    const responses = await Promise.all([GET(request("GET"), context), GET(request("GET"), context)]);
    for (const response of responses) {
      expect(response.status).toBe(viewer === "member" ? 404 : 200);
      if (response.status === 200) {
        expect(await response.json()).toMatchObject({ status: "active", discordEnabled: false });
      }
    }
    expect(createDraftService(db).findById(1).status).toBe("active");
    expect(db.prepare("select count(*) as n from draft_cards where draft_id = 1").get()).toEqual({ n: 6 });
    expect(notify.broadcaster.draft).toHaveBeenCalledExactlyOnceWith({ kind: "status", slug: "lobby", status: "active" });
    expect(notify.announcer.announce).not.toHaveBeenCalled();
    await GET(request("GET"), context);
    expect(notify.broadcaster.draft).toHaveBeenCalledTimes(1);
    expect(db.prepare("select count(*) as n from draft_cards where draft_id = 1").get()).toEqual({ n: 6 });
  });
  it("waits for post-commit WS invalidation before returning the GET start result", async () => {
    vi.stubEnv("DISCORD_BOT_ENABLED", undefined);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-07T12:00:00Z"));
    const api = await useRealLobbyService();
    const scheduled = api.scheduleStart(1, fixtureUserId("host"), { revision: api.read(1, fixtureUserId("host")).lobby.revision, force: true });
    vi.setSystemTime(new Date(scheduled.lobby.start!.startsAt));
    auth.mockResolvedValue({ user: { id: String(fixtureUserId("member")) } });
    let entered!: () => void;
    let delivered!: () => void;
    const called = new Promise<void>((resolve) => { entered = resolve; });
    const delivery = new Promise<void>((resolve) => { delivered = resolve; });
    notify.broadcaster.draft.mockImplementationOnce(() => {
      expect(db.inTransaction).toBe(false);
      expect(createDraftService(db).findById(1).status).toBe("active");
      entered();
      return delivery;
    });
    const { GET } = await import("../app/api/drafts/[slug]/route");
    let returned = false;
    const response = GET(request("GET"), context).then((result) => { returned = true; return result; });
    try {
      await called;
      await new Promise<void>((resolve) => { setImmediate(resolve); });
      expect(returned).toBe(false);
    } finally { delivered(); }
    expect((await response).status).toBe(404);
  });
  it("preserves the shared service clock, optional viewer and invalidation contract", async () => {
    const api = await useRealLobbyService();
    const now = new Date("2026-10-07T12:00:00Z");
    const snapshot = api.read(1, undefined, now);
    expect(snapshot.lobby.serverNow).toBe(now.toISOString());
    expect(snapshot.players.every((p) => !p.isYou)).toBe(true);
    expect(() => api.invalidate(1, { expectedRevision: snapshot.lobby.revision + 1 }))
      .toThrow(expect.objectContaining({ code: "STALE_LOBBY", status: 409 }));
    expect(api.read(1, fixtureUserId("host"), now).lobby.revision).toBe(snapshot.lobby.revision);
  });
  it("T03 runtime: Ready, manual retry/Stop, auto Hold/Resume and GET expiry", async () => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-10-07T12:00:00Z"));
    try {
      const api = await useRealLobbyService();
      const unready = await route("start", "POST", { revision: api.read(1, fixtureUserId("host")).lobby.revision });
      expect(unready.status).toBe(409); expect((await unready.json()).code).toBe("NOT_READY");
      expect((await route("ready", "POST", { ready: true })).status).toBe(200);
      auth.mockResolvedValue({ user: { id: String(fixtureUserId("guest")) } });
      expect((await route("ready", "POST", { ready: true })).status).toBe(200);
      auth.mockResolvedValue({ user: { id: String(fixtureUserId("host")) } });
      const revision = api.read(1, fixtureUserId("host")).lobby.revision;
      const scheduled = await route("start", "POST", { revision }); expect(scheduled.status).toBe(202);
      const first = await scheduled.json() as DraftLobbyResponse;
      expect(new Date(first.lobby.start!.startsAt).getTime() - Date.now()).toBe(5000);
      vi.setSystemTime(Date.now() + 1000);
      const repeated = await route("start", "POST", { revision }); expect(repeated.status).toBe(202);
      expect((await repeated.json()).lobby.start).toEqual(first.lobby.start);
      expect(db.prepare("select count(*) as n from draft_cards").get()).toEqual({ n: 0 });
      expect((await route("start", "DELETE", { token: "wrong" })).status).toBe(409);
      expect((await route("start", "DELETE", { token: first.lobby.start!.token })).status).toBe(200);
      const enabled = await route("auto", "PUT", { enabled: true, revision: api.read(1, fixtureUserId("host")).lobby.revision });
      expect(enabled.status).toBe(200);
      const auto = (await enabled.json()).lobby;
      expect(new Date(auto.start.startsAt).getTime() - Date.now()).toBe(10000);
      expect((await route("auto", "PUT", { enabled: true, held: true, revision: auto.revision })).status).toBe(200);
      vi.setSystemTime(Date.now() + 20000);
      const { GET } = await import("../app/api/drafts/[slug]/route");
      const held = await GET(request("GET"), context); expect(held.status).toBe(200);
      expect((await held.json()).lobby).toMatchObject({ start: null, autoStart: { held: true } });
      const resumed = await route("auto", "PUT", { enabled: true, held: false, revision: api.read(1, fixtureUserId("host")).lobby.revision });
      const resumedLobby = (await resumed.json()).lobby;
      expect(new Date(resumedLobby.start.startsAt).getTime() - Date.now()).toBe(10000);
      vi.setSystemTime(new Date(resumedLobby.start.startsAt));
      const active = await GET(request("GET"), context); expect(active.status).toBe(200);
      expect(await active.json()).toMatchObject({ status: "active" });
      expect(db.prepare("select count(*) as n from draft_cards").get()).toEqual({ n: 6 });
      await GET(request("GET"), context);
      expect(notify.announcer.announce).toHaveBeenCalledTimes(1);
      expect((await route("ready", "POST", { ready: false })).status).toBe(409);
    } finally { vi.useRealTimers(); }
  });
  it("T03 runtime: host Leave, scoped removal and unready rejoin", async () => {
    const api = await useRealLobbyService();
    expect((await route("leave", "DELETE")).status).toBe(200);
    expect((await route("leave", "DELETE")).status).toBe(200);
    expect(api.read(1, fixtureUserId("host")).lobby.joined).toBe(1);
    expect(db.prepare("select created_by_user_id from drafts").get()).toEqual({ created_by_user_id: fixtureUserId("host") });
    expect((await route("remove", "DELETE", undefined, { params: Promise.resolve({ slug: "lobby", playerId: "2" }) } as any)).status).toBe(200);
    expect((await route("remove", "DELETE", undefined, { params: Promise.resolve({ slug: "lobby", playerId: "2" }) } as any)).status).toBe(404);
    const { POST } = await import("../app/api/drafts/[slug]/join/route");
    expect((await POST(request("POST"), context)).status).toBe(200);
    expect(api.read(1, fixtureUserId("host")).players[0]).toMatchObject({ isHost: true, ready: false, cubeId: null });
    expect((await route("remove", "DELETE", undefined, { params: Promise.resolve({ slug: "lobby", playerId: "1" }) } as any)).status).toBe(400);
  });

});

const FIXTURE_KEYS = ["bot_player_dev_table_1", "creator-user", "guest", "host", "joining", "member", "observer", "other", "p2", "p3", "second", "stranger", "viewer"] as const;
