import Database from "better-sqlite3";
import { NextRequest, NextResponse } from "next/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { migrate } from "@yugidraft/shared/db";
import type { DeckCardInfo } from "@yugidraft/shared/duels";
import fixture from "../../duel-server/tests/support/fixtures/red-eyes-exceed-cards.json";

const { requireDuelActor, callDuelHost, room, getDb } = vi.hoisted(() => ({
  requireDuelActor: vi.fn(), callDuelHost: vi.fn(), room: vi.fn(), getDb: vi.fn(),
}));
vi.mock("@/lib/duel-host", async original => ({
  ...await original<typeof import("../src/lib/duel-host")>(),
  requireDuelActor, callDuelHost,
  duelErrorResponse: () => NextResponse.json({ error: "Not found" }, { status: 404 }),
}));
vi.mock("@/lib/db", () => ({ getDb }));

const cards: DeckCardInfo[] = fixture.texts.map((row, index) => ({
  code: Number(row[0]), name: String(row[1]), description: String(row[2]),
  type: fixture.datas[index][4], attack: fixture.datas[index][5], defense: fixture.datas[index][6],
  level: fixture.datas[index][7], attribute: fixture.datas[index][9], race: index === 0 ? "dragon" : "unknown",
  alias: 0, setcodes: [], lscale: 0, rscale: 0, arrows: 0, ot: 1,
}));
let db: Database.Database;
beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  db = new Database(":memory:"); migrate(db); getDb.mockReturnValue(db);
  requireDuelActor.mockResolvedValue({ ok: true, guildId: "guild-1", playerId: 7, duels: { room } });
  callDuelHost.mockResolvedValue({ ok: true, data: { cards, missing: [] } });
});
afterEach(() => { db.close(); });

const post = (codes: unknown) => new Request("http://localhost/api/duels/cards", {
  method: "POST", body: JSON.stringify({ codes }),
});
const search = (query: string, slug?: string) => new NextRequest(
  `http://localhost/api/duels/cards?${new URLSearchParams({ q: query, ...(slug ? { slug } : {}) })}`,
);
function cacheCard(code = cards[0].code, name = "Catalog name", text = "Catalog full text") {
  db.prepare(`insert into card_catalog
    (ygoprodeck_id,name,type,frame_type,effect_text,image_url,image_url_small,card_sets_json,cached_at)
    values (?,?,'Fusion Monster','fusion',?,'','','[]','now')`).run(code, name, text);
}

it("gets exact new-card metadata exclusively from the signed host lookup", async () => {
  const { POST } = await import("../app/api/duels/cards/route");
  const response = await POST(post([17242022, 40235813, 17242022]));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ cards, missing: [] });
  expect(callDuelHost).toHaveBeenCalledWith({
    op: "card-details", guildId: "guild-1", playerId: 7, codes: [17242022, 40235813],
  });
});

it("preserves known host cards and reports other requested passcodes missing", async () => {
  cacheCard(100);
  callDuelHost.mockResolvedValue({ ok: true, data: { cards: [cards[0]], missing: [100] } });
  const { POST } = await import("../app/api/duels/cards/route");
  expect(await (await POST(post([100, 17242022, 100]))).json()).toEqual({ cards: [cards[0]], missing: [100] });
  expect(callDuelHost).toHaveBeenCalledWith({
    op: "card-details", guildId: "guild-1", playerId: 7, codes: [100, 17242022],
  });
});

it("retains exact and partial numeric matches in the host's search order", async () => {
  const matches = [cards[0], { ...cards[1], name: "17242022 in the name" }];
  callDuelHost.mockResolvedValue({ ok: true, data: { cards: matches } });
  const { GET } = await import("../app/api/duels/cards/route");
  expect(await (await GET(search("17242022"))).json()).toEqual({ cards: matches });
  expect(callDuelHost).toHaveBeenCalledWith({
    op: "cards", slug: undefined, guildId: "guild-1", playerId: 7, query: "17242022",
  });
  await GET(search("172"));
  expect(callDuelHost).toHaveBeenLastCalledWith({
    op: "cards", slug: undefined, guildId: "guild-1", playerId: 7, query: "172",
  });
});

it.each(["GET", "POST"] as const)("keeps engine names and text ahead of conflicting catalog text in %s", async method => {
  cacheCard();
  callDuelHost.mockResolvedValue({ ok: true, data: { cards: [cards[0]], missing: [] } });
  const routes = await import("../app/api/duels/cards/route");
  const response = method === "GET" ? await routes.GET(search(cards[0].name)) : await routes.POST(post([cards[0].code]));
  expect((await response.json()).cards).toEqual([cards[0]]);
  if (method === "GET") expect(callDuelHost).toHaveBeenCalledWith(expect.objectContaining({ query: cards[0].name }));
});

it.each([
  { name: undefined, description: undefined, expectedName: "Catalog name", expectedText: "Catalog full text" },
  { name: "Card 17242022", description: "", expectedName: "Catalog name", expectedText: "Catalog full text" },
  { name: "  ", description: cards[0].description, expectedName: "Catalog name", expectedText: cards[0].description },
  { name: cards[0].name, description: "  ", expectedName: cards[0].name, expectedText: "Catalog full text" },
])("fills only the missing host text fields ($name)", async ({ name, description, expectedName, expectedText }) => {
  cacheCard();
  const hostCard = { ...cards[0], name, description, attack: 5100 };
  callDuelHost.mockResolvedValue({ ok: true, data: { cards: [hostCard], missing: [] } });
  const { POST, GET } = await import("../app/api/duels/cards/route");
  for (const response of [await POST(post([hostCard.code])), await GET(search(String(hostCard.code)))]) {
    expect((await response.json()).cards).toEqual([{ ...hostCard, name: expectedName, description: expectedText }]);
  }
});

it("fills artwork text using the host's canonical passcode without changing engine metadata", async () => {
  cacheCard();
  const hostCard = { ...cards[0], code: 17242023, canonicalPasscode: 17242022, name: "Card 17242023", description: "" };
  callDuelHost.mockResolvedValue({ ok: true, data: { cards: [hostCard], missing: [] } });
  const { POST } = await import("../app/api/duels/cards/route");
  expect((await (await POST(post([hostCard.code]))).json()).cards).toEqual([
    { ...hostCard, name: "Catalog name", description: "Catalog full text" },
  ]);
});

it("does not fill host text with blank or placeholder catalog fields", async () => {
  cacheCard(17242022, "Card 17242022", "  ");
  const hostCard = { ...cards[0], code: 17242023, canonicalPasscode: 17242022, name: "Card 17242023", description: "" };
  callDuelHost.mockResolvedValue({ ok: true, data: { cards: [hostCard], missing: [] } });
  const { POST } = await import("../app/api/duels/cards/route");
  expect((await (await POST(post([hostCard.code]))).json()).cards).toEqual([hostCard]);
});

it("creates the catalog lazily and reuses it across requests", async () => {
  cacheCard();
  const { POST, GET } = await import("../app/api/duels/cards/route");
  expect(getDb).not.toHaveBeenCalled();
  await POST(post([cards[0].code]));
  expect(getDb).not.toHaveBeenCalled();
  callDuelHost.mockResolvedValue({ ok: true, data: {
    cards: [{ ...cards[0], name: "Card 17242022", description: "" }], missing: [],
  } });
  await POST(post([cards[0].code]));
  await GET(search(String(cards[0].code)));
  expect(getDb).toHaveBeenCalledTimes(1);
});

it.each([400, 403, 404, 409, 429, 500, 502, 503])("passes the host's %i and error body through to card clients", async status => {
  cacheCard();
  const error = { error: "Host failed", code: "HOST_ERROR" };
  callDuelHost.mockImplementation(async () => ({ ok: false, response: NextResponse.json(error, { status }) }));
  const { POST, GET } = await import("../app/api/duels/cards/route");
  const response = await POST(post([17242022, 100, 17242022]));
  expect(response.status).toBe(status);
  expect(await response.json()).toEqual(error);
  const found = await GET(search("17242022", "room"));
  expect(found.status).toBe(status);
  expect(await found.json()).toEqual(error);
  expect(getDb).not.toHaveBeenCalled();
});

it.each([401, 403, 503])("preserves the actor guard's %i before accessing card data", async status => {
  requireDuelActor.mockResolvedValue({ ok: false, response: NextResponse.json({ error: "Denied" }, { status }) });
  const { POST, GET } = await import("../app/api/duels/cards/route");
  expect((await POST(post([17242022]))).status).toBe(status);
  expect((await GET(search("17242022"))).status).toBe(status);
  expect(getDb).not.toHaveBeenCalled();
  expect(callDuelHost).not.toHaveBeenCalled();
});

it("checks room access with the actor's guild before slug-bound lookups", async () => {
  room.mockImplementation(() => { throw new Error("Room belongs to another guild"); });
  const { GET } = await import("../app/api/duels/cards/route");
  expect((await GET(search("17242022", "other"))).status).toBe(404);
  expect(room).toHaveBeenCalledWith("other", "guild-1", 7);
  expect(callDuelHost).not.toHaveBeenCalled();
  expect(getDb).not.toHaveBeenCalled();
});

it("keeps slug-bound numeric searches on the host's announcement permission path", async () => {
  const { GET } = await import("../app/api/duels/cards/route");
  await GET(search("17242022", "room"));
  expect(callDuelHost).toHaveBeenCalledWith({ op: "cards", slug: "room", guildId: "guild-1", playerId: 7, query: "17242022" });
});

it("rejects invalid JSON before host or catalog access", async () => {
  const { POST } = await import("../app/api/duels/cards/route");
  const response = await POST(new Request("http://localhost/api/duels/cards", { method: "POST", body: "{" }));
  expect(response.status).toBe(400);
  expect(callDuelHost).not.toHaveBeenCalled();
  expect(getDb).not.toHaveBeenCalled();
});

it.each([
  { label: "zero", codes: [0] }, { label: "negative", codes: [-1] },
  { label: "fraction", codes: [1.5] }, { label: "overflow", codes: [0x100000000] },
  { label: "string", codes: ["17242022"] }, { label: "too many", codes: Array(1001).fill(1) },
])("validates $label passcodes before host or catalog access", async ({ codes }) => {
  const { POST } = await import("../app/api/duels/cards/route");
  expect((await POST(post(codes))).status).toBe(400);
  expect(callDuelHost).not.toHaveBeenCalled();
  expect(getDb).not.toHaveBeenCalled();
});

it("preserves prerelease metadata in search and detail API responses",async()=>{
 const preview={...cards[0],prerelease:true};
 callDuelHost.mockResolvedValue({ok:true,data:{cards:[preview],missing:[]}});
 const {GET,POST}=await import("../app/api/duels/cards/route");
 for(const response of [await GET(search(preview.name)),await POST(post([preview.code]))]){
  expect((await response.json()).cards[0].prerelease).toBe(true);
 }
});
