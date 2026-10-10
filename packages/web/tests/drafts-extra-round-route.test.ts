import { fixtureUserId, fixtureDiscordId, seedFixtureUsers } from "./fixtures/identity";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { NextRequest } from "next/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const { realPoolSync } = vi.hoisted(() => ({ realPoolSync: { enabled: false } }));
const auth = vi.fn();
const broadcaster = { draft: vi.fn() };
vi.mock("@/lib/session-identity", async () => {
  const { sessionFixture } = await import("./fixtures/session");
  return sessionFixture(auth);
});
vi.mock("@/lib/notify", () => ({ announcer: { announce: vi.fn() }, broadcaster }));
vi.mock("@/lib/draft-engine-types", () => ({ lookupDraftCardTypes: vi.fn().mockResolvedValue(new Map()) }));
vi.mock("@yugidraft/shared/services", async (importOriginal) => {
  const original = await importOriginal<typeof import("@yugidraft/shared/services")>();
  return { ...original, createCardCatalogService: (db: Parameters<typeof original.createCardCatalogService>[0]) => {
    const catalog = original.createCardCatalogService(db);
    return { ...catalog, syncDraftPool: vi.fn((...args: Parameters<typeof catalog.syncDraftPool>) =>
      realPoolSync.enabled ? catalog.syncDraftPool(...args) : Promise.resolve([])) };
  } };
});
let directory: string;
beforeEach(async () => {
  vi.resetModules();
  realPoolSync.enabled = false;
  auth.mockReset().mockResolvedValue({ user: { id: String(fixtureUserId("host")), discordUserId: fixtureDiscordId("host"), name: "Host" } });
  broadcaster.draft.mockReset();
  directory = mkdtempSync(join(process.cwd(), ".extra-round-test-"));
  vi.stubEnv("DATABASE_PATH", join(directory, "test.sqlite"));
  vi.stubEnv("DISCORD_GUILD_ID", "g");
  vi.stubEnv("DISCORD_DEFAULT_CHANNEL_ID", "c");
  const { getDb } = await import("../src/lib/db");
  const db = getDb();
  seedFixtureUsers(db, ["host"]);
  const insert = db.prepare(`insert into card_catalog
    (ygoprodeck_id, name, type, frame_type, image_url, image_url_small, card_sets_json, cached_at)
    values (?, ?, ?, ?, 'i', 'i', '[]', 't')`);
  for (let i = 1; i <= 600; i++) insert.run(i, `Main ${i}`, "Effect Monster", "effect");
  for (let i = 1001; i <= 1064; i++) insert.run(i, `Extra ${i}`, "Fusion Monster", "fusion");
  db.exec(`insert into card_artworks (card_id, artwork_id, image_url, image_url_small, is_main)
    select ygoprodeck_id, ygoprodeck_id, image_url, image_url_small, 1 from card_catalog`);
});
afterEach(async () => {
  const { getDb } = await import("../src/lib/db");
  getDb().close();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  rmSync(directory, { recursive: true, force: true });
});
const json = (body: unknown) => new Request("http://localhost/api/drafts", { method: "POST", body: JSON.stringify(body) }) as NextRequest;
const baseConfig = { customCardIds: Array.from({ length: 100 }, (_, i) => i + 1),
  packSize: 8, packsPerPlayer: 5, cardsPerPlayer: 40, pickSeconds: 600,
  extraDeckEnabled: true, extraDeckSize: 3, customExtraCardIds: [1001, 1001, 1002, 1002, 1003, 1003] };
async function create(config: object = baseConfig) {
  const { POST } = await import("../app/api/drafts/route");
  const response = await POST(json({ name: "Extra night", config }));
  expect(response.status).toBe(201);
  return response.json();
}
const context = (slug: string) => ({ params: Promise.resolve({ slug }) });
async function joinBot(id: number) {
  const { getDb } = await import("../src/lib/db");
  const { createDraftService, createPlayerService } = await import("@yugidraft/shared/services");
  const db = getDb();
  const drafts = createDraftService(db);
  const bot = createPlayerService(db).findOrCreateTestPlayer("g", "bot_player_dev_1", "Bot");
  drafts.join(id, bot.id);
  return { db, drafts, bot };
}

it.each(["POST", "PUT"])("preserves lookup diagnostics on an empty main pool from %s", async (method) => {
  const created = method === "PUT" ? await create() : undefined;
  const { getDb } = await import("../src/lib/db");
  const db = getDb();
  const before = db.prepare("select * from drafts").all();
  const ids = Array.from({ length: 51 }, (_, i) => 900000 + i);
  const fetch = vi.fn(async (input: RequestInfo | URL) => {
    const id = Number(new URL(String(input)).searchParams.get("id"));
    return id === ids[50] ? Response.json({ data: [{ id, name: "Valid last card", type: "Effect Monster", frameType: "effect",
      card_images: [{ id, image_url: "i", image_url_small: "i" }] }] })
      : Response.json({ error: "No card matching your query was found" }, { status: 400 });
  });
  vi.stubGlobal("fetch", fetch);
  realPoolSync.enabled = true;
  const config = { customCardIds: ids, customExtraCardIds: [], setNames: [], packSize: 8, packsPerPlayer: 5, cardsPerPlayer: 40 };
  const response = method === "POST"
    ? await (await import("../app/api/drafts/route")).POST(json({ name: "Limited empty", config }))
    : await (await import("../app/api/drafts/[slug]/route")).PUT(json({ config }), context(created.webSlug));
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ lookupLimited: true, unknownIds: ids });
  expect(fetch).toHaveBeenCalledTimes(50);
  expect(db.prepare("select * from drafts").all()).toEqual(before);
}, 40000);

it("stores imported extra copies and returns the normalized normal config", async () => {
  const result = await create();
  expect(result.config).toMatchObject({ customExtraCardIds: baseConfig.customExtraCardIds, extraDeckEnabled: true, extraDeckSize: 3, picksPerStep: 1 });
  const { getDb } = await import("../src/lib/db");
  const row = getDb().prepare("select config_json from drafts where id = ?").get(result.id) as { config_json: string };
  expect(JSON.parse(row.config_json).customExtraCardIds).toEqual(baseConfig.customExtraCardIds);
});

it("returns main and extra pool previews with authored quantities", async () => {
  const result = await create();
  const { GET } = await import("../app/api/drafts/[slug]/pool/route");
  const pool = await (await GET(new Request("http://x"), context(result.webSlug))).json();
  expect(pool.cards.every((card: { id: number }) => card.id < 1000)).toBe(true);
  expect(pool.extraCards.map((card: { id: number; qty: number }) => [card.id, card.qty])).toEqual([[1001, 2], [1002, 2], [1003, 2]]);
});

it("uses source cube extras when no explicit extra array was sent, including with the toggle OFF", async () => {
  const { getDb } = await import("../src/lib/db");
  const db = getDb();
  const cubeId = Number(db.prepare("insert into cubes (guild_id, name, created_by_user_id) values ('g', 'Source', ?)").run(fixtureUserId("host")).lastInsertRowid);
  db.prepare("insert into cube_cards (cube_id, catalog_card_id, pool, max_copies) values (?, 1001, 'extra', 6)").run(cubeId);
  const { customExtraCardIds: _, ...config } = baseConfig;
  const result = await create({ ...config, poolSource: { cubeId, cubeName: "wrong name" }, extraDeckEnabled: false });
  const { GET } = await import("../app/api/drafts/[slug]/pool/route");
  const pool = await (await GET(new Request("http://x"), context(result.webSlug))).json();
  expect(pool.extraCards).toEqual([expect.objectContaining({ id: 1001, qty: 6 })]);
  expect(result.config.poolSource).toEqual({ cubeId, cubeName: "Source" });
});

it("reports too-small extras at create and preflight and blocks start atomically", async () => {
  const result = await create({ ...baseConfig, customExtraCardIds: [1001, 1002] });
  expect(result.errors).toEqual([expect.stringMatching(/Extra.*2.*12/)]);
  expect(result.warnings).toContainEqual(expect.stringMatching(/160 requested picks/));
  await joinBot(result.id);
  const { GET } = await import("../app/api/drafts/[slug]/preflight/route");
  expect((await (await GET(new Request("http://x"), context(result.webSlug))).json()).errors).toEqual([expect.stringMatching(/Extra.*2.*6/)]);
  const { POST } = await import("../app/api/drafts/[slug]/route");
  const started = await POST(json({}), context(result.webSlug));
  expect(started.status).toBe(409);
  expect((await started.json()).error).toMatch(/Extra.*2.*6/);
});

it.each([
  { extraDeckSize: -1 }, { extraDeckSize: 16 }, { extraDeckSize: 1.5 }, { extraDeckSize: null },
  { extraDeckEnabled: "yes" }, { picksPerStep: 0 }, { picksPerStep: 3 },
  { customExtraCardIds: "1001" }, { customExtraCardIds: [0] }, { customExtraCardIds: [1.5] },
])("rejects invalid normal config before writing: %j", async (invalid) => {
  const { POST } = await import("../app/api/drafts/route");
  const response = await POST(json({ name: "Bad", config: { ...baseConfig, ...invalid } }));
  expect(response.status).toBe(400);
  const { getDb } = await import("../src/lib/db");
  expect(getDb().prepare("select count(*) n from drafts").get()).toEqual({ n: 0 });
});

it("edits extra-only settings without changing the main format and preserves the owner format", async () => {
  const result = await create({ ...baseConfig, customCardIds: Array.from({ length: 480 }, (_, i) => i + 1),
    packSize: 24, packsPerPlayer: 5, cardsPerPlayer: 120, picksPerStep: 2 });
  const { PUT } = await import("../app/api/drafts/[slug]/route");
  const edited = await PUT(json({ config: { extraDeckSize: 2, customExtraCardIds: [1001, 1001, 1002, 1002] } }), context(result.webSlug));
  expect(edited.status).toBe(200);
  expect((await edited.json()).config).toMatchObject({ packsPerPlayer: 5, packSize: 24, cardsPerPlayer: 120, picksPerStep: 2, extraDeckSize: 2 });
});

it("rejects invalid extra edits without changing the pool or draft name", async () => {
  const result = await create();
  const { PUT } = await import("../app/api/drafts/[slug]/route");
  const edited = await PUT(json({ name: "Bad edit", config: { extraDeckSize: 30 } }), context(result.webSlug));
  expect(edited.status).toBe(400);
  const { getDb } = await import("../src/lib/db");
  expect(getDb().prepare("select name from drafts where id = ?").get(result.id)).toEqual({ name: "Extra night" });
});

it("runs test bots through two-pick main and odd-sized extra packs and broadcasts resync/complete", async () => {
  const result = await create({ ...baseConfig, packSize: 8, packsPerPlayer: 5, cardsPerPlayer: 40, picksPerStep: 2 });
  const { drafts, db } = await joinBot(result.id);
  drafts.start(result.id);
  const human = drafts.players(result.id)[0].playerId;
  const { POST } = await import("../app/api/drafts/[slug]/pick/route");
  let response: any;
  for (let i = 0; i < 43; i++) {
    const option = drafts.pickOptions(result.id, human)[0];
    expect(option).toBeDefined();
    const picked = await POST(json({ cardId: option.id }), context(result.webSlug));
    expect(picked.status).toBe(200);
    response = await picked.json();
    if (i === 39) {
      expect(response).toMatchObject({ status: "active", phase: "extra", totalPackRounds: 6, currentPackSize: 3,
        boosterProgress: { main: 40, mainTotal: 40, extra: 0, extraTotal: 3 } });
      expect(broadcaster.draft).toHaveBeenCalledWith({ kind: "resync", slug: result.webSlug, packRound: 6, pickStep: 1 });
    }
  }
  expect(response.status).toBe("completed");
  expect(response.myPool).toHaveLength(43);
  expect(broadcaster.draft).toHaveBeenCalledWith({ kind: "complete", slug: result.webSlug });
  const saved = db.prepare("select deck_json from saved_decks where draft_id = ?").get(result.id) as { deck_json: string };
  expect(JSON.parse(saved.deck_json).extra).toHaveLength(3);
  expect(drafts.picks(result.id).filter((p) => p.pickMethod === "auto")).toHaveLength(43);
});

it("saves scratch extras as cube extra rows and respects explicit quantities over source-copy quantities", async () => {
  const { getDb } = await import("../src/lib/db");
  const db = getDb();
  const source = Number(db.prepare("insert into cubes (guild_id, name, created_by_user_id) values ('g', 'Source', ?)").run(fixtureUserId("host")).lastInsertRowid);
  db.prepare("insert into cube_cards (cube_id, catalog_card_id, pool, max_copies) values (?, 1001, 'extra', 9)").run(source);
  db.prepare("insert into cube_cards (cube_id, catalog_card_id, pool, max_copies) values (?, 1002, 'extra', 4)").run(source);
  const { POST } = await import("../app/api/cubes/route");
  const response = await POST(json({ kind: "pool", name: "Saved", cards: [{ id: 1, copies: 3 }],
    extraCards: [{ id: 1001, copies: 2 }], copyExtraFromCubeId: source }));
  expect(response.status).toBe(201);
  const body = await response.json();
  expect(db.prepare("select catalog_card_id id, pool, max_copies copies from cube_cards where cube_id = ? order by 1").all(body.cube.id))
    .toEqual([{ id: 1, pool: "main", copies: 3 }, { id: 1001, pool: "extra", copies: 2 }]);
});

it("requires valid copy entries when saving an explicit extra pool", async () => {
  const { POST } = await import("../app/api/cubes/route");
  const response = await POST(json({ kind: "pool", name: "Bad", cards: [{ id: 1, copies: 3 }], extraCards: [{ id: 1001, copies: 0 }] }));
  expect(response.status).toBe(400);
});

it("saves config-backed scratch extras into actual cube rows", async () => {
  const { POST } = await import("../app/api/cubes/route");
  const response = await POST(json({ name: "Config saved", config: { customCardIds: [1, 1], customExtraCardIds: [1001, 1001, 1002] } }));
  expect(response.status).toBe(201);
  const { cube } = await response.json();
  const { getDb } = await import("../src/lib/db");
  expect(getDb().prepare("select catalog_card_id id, max_copies copies from cube_cards where cube_id = ? and pool = 'extra' order by 1").all(cube.id))
    .toEqual([{ id: 1001, copies: 2 }, { id: 1002, copies: 1 }]);
});


it.each([
  ["POST", "booster"], ["PUT", "booster"], ["POST", "theme"], ["PUT", "theme"],
])("rejects more than 1000 distinct extra ids on %s (%s) without draft writes", async (method, mode) => {
  if (mode === "theme") vi.stubEnv("THEME_DRAFTS", "1");
  const { getDb } = await import("../src/lib/db");
  const db = getDb();
  const created = method === "PUT" ? await create() : undefined;
  const before = db.prepare("select * from drafts").all();
  const config = { ...baseConfig, mode, customExtraCardIds: Array.from({ length: 1001 }, (_, i) => 10000 + i) };
  const response = method === "POST"
    ? await (await import("../app/api/drafts/route")).POST(json({ name: "Too many", config }))
    : await (await import("../app/api/drafts/[slug]/route")).PUT(json({ config }), context(created.webSlug));
  expect(response.status).toBe(400);
  expect((await response.json()).error).toMatch(/1000/);
  expect(db.prepare("select * from drafts").all()).toEqual(before);
});


it.each(["POST", "PUT"])("accepts 1000 distinct extra ids and repeated copies on %s", async (method) => {
  const { getDb } = await import("../src/lib/db");
  const db = getDb();
  const insert = db.prepare(`insert into card_catalog
    (ygoprodeck_id,name,type,frame_type,image_url,image_url_small,card_sets_json,cached_at)
    values (?,?,'Fusion Monster','fusion','i','i','[]','t')`);
  const ids = Array.from({ length: 1000 }, (_, i) => i + 10000);
  db.transaction(() => ids.forEach((id) => insert.run(id, `Extra ${id}`)))();
  const created = method === "PUT" ? await create() : undefined;
  const config = { ...baseConfig, cardsPerPlayer: 40, packSize: 8, customExtraCardIds: [...ids, ...Array<number>(1001).fill(ids[0])] };
  const response = method === "POST"
    ? await (await import("../app/api/drafts/route")).POST(json({ name: "Boundary", config }))
    : await (await import("../app/api/drafts/[slug]/route")).PUT(json({ config }), context(created.webSlug));
  expect(response.status).toBe(method === "POST" ? 201 : 200);
  expect((await response.json()).config.customExtraCardIds).toEqual(config.customExtraCardIds);
});


it.each([
  { cardsPerPlayer: 39 }, { cardsPerPlayer: 121 }, { cardsPerPlayer: 40.5 }, { cardsPerPlayer: "40" }, { cardsPerPlayer: null },
  { packSize: 4 }, { packSize: 121 }, { packSize: 8.5 }, { packSize: "8" }, { packSize: null },
  { packsPerPlayer: 0 }, { packsPerPlayer: -1 }, { packsPerPlayer: 1.5 }, { packsPerPlayer: "5" }, { packsPerPlayer: null },
  { packsPerPlayer: Number.MAX_SAFE_INTEGER + 1 },
])("validates main numbers on POST before player/draft writes: %j", async (invalid) => {
  const { POST } = await import("../app/api/drafts/route");
  const response = await POST(json({ name: "Invalid numbers", config: {
    ...baseConfig, packSize: 8, packsPerPlayer: 5, cardsPerPlayer: 40, ...invalid,
  } }));
  expect(response.status).toBe(400);
  const { getDb } = await import("../src/lib/db");
  expect(getDb().prepare("select count(*) n from drafts").get()).toEqual({ n: 0 });
  expect(getDb().prepare("select count(*) n from players").get()).toEqual({ n: 0 });
});

it.each([
  { cardsPerPlayer: 40, packSize: 5, packsPerPlayer: 8 },
  { cardsPerPlayer: 120, packSize: 120, packsPerPlayer: 1 },
  { cardsPerPlayer: 120, packSize: 24, packsPerPlayer: 5 },
])("accepts main numeric boundaries on POST: %j", async (numbers) => {
  const result = await create({ ...baseConfig, ...numbers });
  expect(result.config).toMatchObject(numbers);
});

it("derives rounds on POST when only the main quota is supplied", async () => {
  const result = await create({ customCardIds: baseConfig.customCardIds, cardsPerPlayer: 50 });
  expect(result.config).toMatchObject({ cardsPerPlayer: 50, packSize: 8, packsPerPlayer: 7 });
});
