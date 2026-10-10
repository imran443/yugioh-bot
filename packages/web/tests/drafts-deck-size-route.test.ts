import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { NextRequest } from "next/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { fixtureUserId, fixtureDiscordId, seedFixtureUsers } from "./fixtures/identity";

vi.mock("@/lib/session-identity", async () => {
  const { sessionFixture } = await import("./fixtures/session");
  return sessionFixture(vi.fn().mockResolvedValue({ user: { id: String(fixtureUserId("host")), discordUserId: fixtureDiscordId("host"), name: "Host" } }));
});
vi.mock("@/lib/notify", () => ({ announcer: { announce: vi.fn() }, broadcaster: { draft: vi.fn() } }));
vi.mock("@/lib/duel-host", () => ({ callDuelHost: async () => ({ ok: false, response: { status: 503 } }) }));

let directory: string;
beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: [] }) }));
  directory = mkdtempSync(join(tmpdir(), "draft-deck-size-route-"));
  vi.stubEnv("DATABASE_PATH", join(directory, "test.sqlite"));
  vi.stubEnv("DISCORD_GUILD_ID", "g");
  vi.stubEnv("DISCORD_DEFAULT_CHANNEL_ID", "c");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  rmSync(directory, { recursive: true, force: true });
});

async function setup() {
  const { getDb } = await import("../src/lib/db");
  const db = getDb();
  seedFixtureUsers(db, ["host", "other"]);
  const services = await import("@yugidraft/shared/services");
  const players = services.createPlayerService(db);
  const host = players.findOrCreate("g", fixtureUserId("host"), "Host");
  const other = players.findOrCreate("g", fixtureUserId("other"), "Other");
  const main = Array.from({ length: 120 }, (_, i) => i + 1);
  const extra = Array.from({ length: 6 }, (_, i) => 1001 + i);
  const insert = db.prepare("insert into card_catalog (ygoprodeck_id,name,type,frame_type,image_url,image_url_small,card_sets_json,cached_at) values (?,?,?,?, 'i','i','[]',?)");
  for (const id of main) insert.run(id, `M${id}`, "Normal Monster", "normal", new Date().toISOString());
  for (const id of extra) insert.run(id, `X${id}`, "Fusion Monster", "fusion", new Date().toISOString());
  return { db, host, other, main, extra, drafts: services.createDraftService(db), services };
}

it.each(["booster", "theme"].flatMap((mode) => [39, 121, 40.5, "40", null].map((cap) => ({ mode, cap }))))
  ("rejects invalid $mode cap $cap on create and non-null edits", async ({ mode, cap }) => {
    if (mode === "theme") vi.stubEnv("THEME_DRAFTS", "1");
    const app = await setup();
    const { POST } = await import("../app/api/drafts/route");
    const response = await POST(new Request("http://x", { method: "POST", body: JSON.stringify({ name: "Bad", config: { mode, customCardIds: app.main, cardsPerPlayer: cap } }) }) as NextRequest);
    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/40 to 120/);
    expect(app.db.prepare("select count(*) as n from drafts").get()).toEqual({ n: 0 });
    if (cap === null) return; // Null is rejected on create, and resets the cap on edit.
    const draft = app.drafts.create("g", "c", "Good", { mode: mode as "booster" | "theme", customCardIds: app.main }, fixtureUserId("host"), app.host.id);
    const { PUT } = await import("../app/api/drafts/[slug]/route");
    const edited = await PUT(new Request("http://x", { method: "PUT", body: JSON.stringify({ config: { cardsPerPlayer: cap } }) }) as NextRequest, { params: Promise.resolve({ slug: draft.webSlug! }) });
    expect(edited.status).toBe(400);
    expect((await edited.json()).error).toMatch(/40 to 120/);
    expect(app.drafts.findById(draft.id).config).toEqual(draft.config);
  });

it("uses the capped demand for create, edit, preflight, lobby start and the room response", async () => {
  const app = await setup();
  const config = { customCardIds: app.main, cardsPerPlayer: 40, packSize: 24, packsPerPlayer: 5, picksPerStep: 2, lobbySeats: 2, extraDeckEnabled: true, extraDeckSize: 3, customExtraCardIds: app.extra };
  const { POST } = await import("../app/api/drafts/route");
  const response = await POST(new Request("http://x", { method: "POST", body: JSON.stringify({ name: "Capped", config }) }) as NextRequest);
  expect(response.status).toBe(201);
  const created = await response.json();
  expect(created.errors).toEqual([]);
  const context = { params: Promise.resolve({ slug: created.webSlug }) };
  const { PUT, GET } = await import("../app/api/drafts/[slug]/route");
  const edited = await PUT(new Request("http://x", { method: "PUT", body: JSON.stringify({ config: { cardsPerPlayer: 41 } }) }) as NextRequest, context);
  expect(edited.status).toBe(200);
  expect((await edited.json()).errors).toEqual([]);
  app.drafts.join(created.id, app.other.id);
  const { GET: preflight } = await import("../app/api/drafts/[slug]/preflight/route");
  expect((await (await preflight(new Request("http://x"), context)).json()).errors).toEqual([]);
  const lobby = app.services.createDraftLobbyService(app.db);
  expect(lobby.read(created.id, fixtureUserId("host")).lobby.errors).toEqual([]);
  app.drafts.start(created.id);
  const room = await (await GET(new Request("http://x"), context)).json();
  expect(room.config.cardsPerPlayer).toBe(41);
  expect(room.config.packsPerPlayer).toBe(2);
  expect(room.totalPackRounds).toBe(3);
  expect(room.boosterProgress).toEqual({ main: 0, mainTotal: 41, extra: 0, extraTotal: 3 });
  for (let step = 0; step < 100 && app.drafts.findById(created.id).status === "active"; step++) {
    for (const player of [app.host, app.other]) {
      const options = app.drafts.currentPackOptions(created.id, player.id);
      if (options.length) app.drafts.pickCard(created.id, player.id, options[0].id);
    }
  }
  expect(app.drafts.findById(created.id).status).toBe("completed");
  const finished = await (await GET(new Request("http://x"), context)).json();
  expect(finished.phase).toBe("extra");
  expect(finished.boosterProgress).toEqual({ main: 41, mainTotal: 41, extra: 3, extraTotal: 3 });
  expect(finished.myPool).toHaveLength(44);
  // The same cap and derived rounds are stored and exposed.
  expect(app.drafts.findById(created.id).config.cardsPerPlayer).toBe(41);
});

it.each([40, 120])("accepts a %i-card target and can edit the room's projected config", async (cap) => {
  const app = await setup();
  const { POST } = await import("../app/api/drafts/route");
  const response = await POST(new Request("http://x", { method: "POST", body: JSON.stringify({ name: "Small", config: { customCardIds: app.main, cardsPerPlayer: cap, packSize: 24, packsPerPlayer: 5, lobbySeats: 2 } }) }) as NextRequest);
  expect(response.status).toBe(201);
  const draft = await response.json();
  const context = { params: Promise.resolve({ slug: draft.webSlug }) };
  const { GET, PUT } = await import("../app/api/drafts/[slug]/route");
  const room = await (await GET(new Request("http://x"), context)).json();
  expect(room.config.cardsPerPlayer).toBe(cap);
  expect(room.config.packsPerPlayer).toBe(Math.ceil(cap / 24));
  const edited = await PUT(new Request("http://x", { method: "PUT", body: JSON.stringify({ config: { ...room.config, cardsPerPlayer: 41 } }) }) as NextRequest, context);
  expect(edited.status).toBe(200);
  expect((await edited.json()).config.packsPerPlayer).toBe(2);
  app.drafts.join(draft.id, app.other.id);
  expect(app.services.createDraftLobbyService(app.db).read(draft.id, fixtureUserId("host")).lobby.errors).toEqual([]);
});

it.each([false, true])("uses the cap in theme preflight, lobby checks and phase/progress (burn=%s)", async (burnUnpicked) => {
  const app = await setup();
  const cubes = app.services.createCubeService(app.db, app.services.createCardCatalogService(app.db));
  const cube = cubes.createBlank("g", "Theme", fixtureUserId("host"));
  for (const id of app.main.slice(0, burnUnpicked ? 120 : 42)) cubes.addCard(cube.id, id, "main", 1);
  for (const id of app.extra) cubes.addCard(cube.id, id, "extra", 1);
  const draft = app.drafts.create("g", "c", "Theme Size", { mode: "theme", cardsPerPlayer: 40, allowedCubeIds: [cube.id], themeSelection: "random", uniqueThemes: false, burnUnpicked, extraDeckEnabled: true, extraDeckSize: 2, themePackSize: 3 }, fixtureUserId("host"), app.host.id);
  app.drafts.join(draft.id, app.other.id);
  const context = { params: Promise.resolve({ slug: draft.webSlug! }) };
  const { GET: preflight } = await import("../app/api/drafts/[slug]/preflight/route");
  expect((await (await preflight(new Request("http://x"), context)).json()).errors).toEqual([]);
  const lobby = app.services.createDraftLobbyService(app.db);
  expect(lobby.read(draft.id, fixtureUserId("host")).lobby.errors).toEqual([]);
  app.drafts.start(draft.id);
  for (let step = 0; step < 40; step++) {
    for (const player of [app.host, app.other]) app.drafts.pickCard(draft.id, player.id, app.drafts.currentPackOptions(draft.id, player.id)[0].id);
  }
  const { GET } = await import("../app/api/drafts/[slug]/route");
  const room = await (await GET(new Request("http://x"), context)).json();
  expect(room.phase).toBe("extra");
  expect(room.config.cardsPerPlayer).toBe(40);
  expect(room.themeProgress).toEqual({ main: 40, mainTotal: 40, extra: 0, extraTotal: 2 });
});

it.each(["booster", "theme"].flatMap((mode) => [40, null].map((reset) => ({ mode, reset }))))
  ("resets the $mode cap to default with $reset", async ({ mode, reset }) => {
    const app = await setup();
    const draft = app.drafts.create("g", "c", "Reset", { mode: mode as "booster" | "theme",
      customCardIds: app.main, cardsPerPlayer: 120, packSize: 24 }, fixtureUserId("host"), app.host.id);
    const { PUT } = await import("../app/api/drafts/[slug]/route");
    const response = await PUT(new Request("http://x", { method: "PUT", body: JSON.stringify({ config: { cardsPerPlayer: reset } }) }) as NextRequest,
      { params: Promise.resolve({ slug: draft.webSlug! }) });
    expect(response.status).toBe(200);
    expect((await response.json()).config).toMatchObject({ cardsPerPlayer: 40, packsPerPlayer: 2 });
    expect(app.drafts.findById(draft.id).config.cardsPerPlayer).toBe(40);
  });

it("returns effective theme setup in the paginated draft list", async () => {
  const app = await setup();
  const draft = app.drafts.create("g", "c", "Listed Theme", { mode: "theme", cardsPerPlayer: 60,
    packSize: 24, packsPerPlayer: 5, themeAssignments: { [app.host.id]: 999 } }, fixtureUserId("host"), app.host.id);
  const { GET } = await import("../app/api/drafts/route");
  const response = await GET(new Request("http://x/api/drafts"));
  expect(response.status).toBe(200);
  const listed = (await response.json()).items.find((item: { id: number }) => item.id === draft.id);
  expect(listed.config).toMatchObject({ mode: "theme", cardsPerPlayer: 60, packsPerPlayer: 3,
    extraDeckEnabled: true, extraDeckSize: 15 });
  expect(listed.config).not.toHaveProperty("themeAssignments");
});

it.each([2, 3].flatMap((players) => [1, 2].flatMap((picksPerStep) => [false, true].flatMap((extraDeckEnabled) =>
  [players * 40 - 1, players * 20].map((size) => ({ players, picksPerStep, extraDeckEnabled, size }))))))
  ("shows reachable totals for $players players, pool $size, $picksPerStep picks, Extra=$extraDeckEnabled", async ({ players, size, picksPerStep, extraDeckEnabled }) => {
    const app = await setup();
    seedFixtureUsers(app.db, ["third"]);
    const third = app.services.createPlayerService(app.db).findOrCreate("g", fixtureUserId("third"), "Third");
    const roster = [app.host, app.other, third].slice(0, players);
    const draft = app.drafts.create("g", "c", "Reachable", { customCardIds: app.main.slice(0, size),
      cardsPerPlayer: 40, packSize: 24, picksPerStep, extraDeckEnabled, extraDeckSize: 2, customExtraCardIds: app.extra },
      fixtureUserId("host"), app.host.id);
    for (const player of roster.slice(1)) app.drafts.join(draft.id, player.id);
    app.drafts.start(draft.id);
    const { buildDraftResponse } = await import("../app/api/drafts/[slug]/helpers");
    const read = (index: number) => buildDraftResponse(draft.webSlug!, {
      userId: fixtureUserId(["host", "other", "third"][index]), discordUserId: null });
    const initial = await Promise.all(roster.map((_, index) => read(index)));
    expect(initial.some((room) => room!.boosterProgress!.mainTotal < 40)).toBe(true);
    for (let step = 0; step < 100 && app.drafts.findById(draft.id).status === "active"; step++) {
      for (const player of roster) {
        const options = app.drafts.currentPackOptions(draft.id, player.id);
        if (options.length) app.drafts.pickCard(draft.id, player.id, options[0].id);
      }
      if (step === 5) {
        for (let index = 0; index < roster.length; index++) {
          expect((await read(index))!.boosterProgress!.mainTotal).toBe(initial[index]!.boosterProgress!.mainTotal);
        }
      }
    }
    expect(app.drafts.findById(draft.id).status).toBe("completed");
    for (let index = 0; index < roster.length; index++) {
      const main = app.drafts.pool(draft.id, roster[index].id).filter((card) => card.catalogCardId < 1000).length;
      expect(initial[index]!.boosterProgress!.mainTotal).toBe(main);
      expect((await read(index))!.boosterProgress).toEqual({ main, mainTotal: main,
        extra: extraDeckEnabled ? 2 : 0, extraTotal: extraDeckEnabled ? 2 : 0 });
      expect(initial[index]!.config.cardsPerPlayer).toBe(40);
    }
  });

it("takes test-bot picks through an odd two-pick Main cap without over-picking", async () => {
  const app = await setup();
  const bot = app.services.createPlayerService(app.db).findOrCreateTestPlayer("g", "bot_player_dev_1", "Bot");
  const draft = app.drafts.create("g", "c", "Bot cap", { customCardIds: app.main,
    cardsPerPlayer: 41, packSize: 24, picksPerStep: 2 }, fixtureUserId("host"), app.host.id);
  app.drafts.join(draft.id, bot.id);
  app.drafts.start(draft.id);
  const { POST } = await import("../app/api/drafts/[slug]/pick/route");
  const context = { params: Promise.resolve({ slug: draft.webSlug! }) };
  let lastId = 0;
  for (let step = 0; step < 100 && app.drafts.findById(draft.id).status === "active"; step++) {
    const options = app.drafts.currentPackOptions(draft.id, app.host.id);
    expect(options.length).toBeGreaterThan(0);
    lastId = options[0].id;
    const response = await POST(new Request("http://x", { method: "POST", body: JSON.stringify({ cardId: lastId }) }) as NextRequest, context);
    expect(response.status).toBe(200);
    for (const player of [app.host, bot]) expect(app.drafts.pool(draft.id, player.id).length).toBeLessThanOrEqual(41);
  }
  expect(app.drafts.findById(draft.id).status).toBe("completed");
  expect(app.drafts.pool(draft.id, app.host.id)).toHaveLength(41);
  const botPool = app.drafts.pool(draft.id, bot.id);
  expect(botPool).toHaveLength(41);
  expect(botPool.every((card) => card.pickMethod === "auto")).toBe(true);
  const repeated = await POST(new Request("http://x", { method: "POST", body: JSON.stringify({ cardId: lastId }) }) as NextRequest, context);
  expect(repeated.status).toBe(400);
  expect(app.drafts.pool(draft.id, bot.id)).toHaveLength(41);
});
