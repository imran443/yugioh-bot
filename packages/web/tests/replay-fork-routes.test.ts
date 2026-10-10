import Database from "better-sqlite3";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { migrate } from "@yugidraft/shared/db";
import { createDuelService, createReplayForkService, hashReplayForkPrefix } from "@yugidraft/shared/services";
import { seedIdentity } from "../../shared/tests/helpers/identity";

const state = vi.hoisted(() => ({ db: null as Database.Database | null, auth: vi.fn(), fetch: vi.fn() }));
vi.mock("@/lib/session-identity", async () => {
  const { sessionFixture } = await import("./fixtures/session"); return sessionFixture(state.auth);
});
vi.mock("@/lib/db", () => ({ getDb: () => state.db! }));
let slug: string, fork: string;
const signIn = (id: number) => state.auth.mockResolvedValue({ user: { id: String(id), name: "Test actor" } });
const params = (slug: string) => ({ params: Promise.resolve({ slug }) });
const payload = () => JSON.parse(state.fetch.mock.calls.at(-1)![1].body as string);
const input = { cursor: "sealed-test-cursor", sourceVersion: "source-v1", requestId: "request-1" };
beforeEach(() => {
  vi.resetModules(); state.auth.mockReset(); state.fetch.mockReset();
  vi.stubEnv("OWNER_USER_IDS", "101,102");
  state.db = new Database(":memory:"); migrate(state.db);
  for (const [playerId, userId] of [[61, 101], [62, 102], [63, 103], [64, 201], [65, 202]]) {
    seedIdentity(state.db, { guildId: "test-guild", playerId, userId });
  }
  const duels = createDuelService(state.db), session = duels.create({ guildId: "test-guild", organizerPlayerId: 64,
    name: "Private source", mode: "normal", settings: { visibility: "private" } });
  slug = session.slug; state.db.prepare("insert into duel_seats(duel_id,seat,player_id) values(?,1,65)").run(session.id);
  state.db.prepare("update duel_seats set deck_json = ?, ready = 1 where duel_id = ?").run(JSON.stringify({ main: [100], extra: [], side: [] }), session.id);
  state.db.prepare("update duels set status = 'interrupted', seed_json = ?, bundle_version = 'test-bundle' where id = ?")
    .run(JSON.stringify(["1", "2", "3", "4"]), session.id);
  const s = duels.privateState(slug, "test-guild");
  fork = createReplayForkService(state.db).create({ actor: { guildId: "test-guild", playerId: 61, userId: 101 },
    requestId: "fixture-1", cursorDigest: "a".repeat(64),
    source: { session: s.session, decks: s.decks, seed: s.seed as [string, string, string, string], bundleVersion: s.bundleVersion!, engineIdentity: null, commands: [] },
    origin: { sourceSlug: slug, sourceVersion: "source-v1", frameId: "frame-0", step: 0, prefixCount: 0,
      prefixHash: hashReplayForkPrefix([]), sourceSeats: s.session.seats.map(s => ({ seat: s.seat, displayName: s.displayName })) } }).session.slug;
  vi.stubEnv("DISCORD_GUILD_ID", "test-guild"); vi.stubEnv("OWNER_USER_IDS", "101,102"); vi.stubEnv("DUEL_SCENARIOS", "1");
  vi.stubEnv("DUEL_INTERNAL_URL", "http://duel.test"); vi.stubEnv("DUEL_INTERNAL_SECRET", "route-test-secret");
  state.fetch.mockImplementation(async () => Response.json({ slug: fork, room: { session: { slug: fork, kind: "replay-fork" } }, cards: [] }));
  vi.stubGlobal("fetch", state.fetch); signIn(101);
});
afterEach(() => { state.db?.close(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

async function launch(body: unknown = input) {
  const { POST } = await import("../app/api/admin/duels/[slug]/replay/fork/route");
  return POST(new Request("http://localhost/api/admin/duels/source/replay/fork", { method: "POST", body: JSON.stringify(body) }), params(slug));
}
it.each([101, 102])("allows owner %s to launch from a private production source without a source grant", async id => {
  signIn(id);
  // This route does not use normal room access. The host checks source and retry access.
  state.fetch.mockImplementation(async () => Response.json({ accepted: true }));
  const result = await launch(); expect(result.status).toBe(200);
  expect(payload()).toEqual({ op: "replay-fork", slug, guildId: "test-guild", playerId: id === 101 ? 61 : 62, userId: id, ...input });
  expect(result.headers.get("cache-control")).toBe("private, no-store");
  expect(state.db!.prepare("select * from duel_invite_grants").all()).toEqual([]);
});
it("forwards retries after source deletion to the host", async () => {
  state.db!.prepare("delete from duels where web_slug = ?").run(slug);
  expect((await launch()).status).toBe(200); expect(payload()).toMatchObject({ ...input, slug });
});
it.each([103, 201])("denies alpha user %s before host calls", async id => {
  signIn(id); const result = await launch(); expect(result.status).toBe(404);
  expect(await result.json()).toMatchObject({ code: "ACCESS_DENIED" }); expect(state.fetch).not.toHaveBeenCalled();
});
it.each([null, {}, { ...input, requestId: "" }, { ...input, decks: [] }, { ...input, ownerUserId: 101 }, { ...input, prefixCount: 0 }])
("rejects malformed or forged launch input %j", async body => {
  const result = await launch(body); expect(result.status).toBe(400);
  expect(await result.json()).toMatchObject({ code: "INVALID_CURSOR" }); expect(state.fetch).not.toHaveBeenCalled();
});
it.each([401, 503])("preserves access failure %s", async status => {
  if (status === 401) state.auth.mockResolvedValue(null); else state.auth.mockRejectedValue(new Error("Unavailable"));
  expect((await launch()).status).toBe(status); expect(state.fetch).not.toHaveBeenCalled();
});
it("drops the response when access is revoked during launch", async () => {
  state.fetch.mockImplementation(async () => { vi.stubEnv("OWNER_USER_IDS", ""); return Response.json({ private: "fixture" }); });
  const result = await launch(); expect(result.status).toBe(404); expect(await result.json()).toMatchObject({ code: "ACCESS_DENIED" });
});
it.each(["restart", "cancel"] as const)("restricts dedicated fork %s to its current creator", async operation => {
  const route = operation === "restart" ? await import("../app/api/duels/[slug]/fork/restart/route") : await import("../app/api/duels/[slug]/fork/cancel/route");
  const req = new Request(`http://localhost/api/duels/${fork}/fork/${operation}`, { method: "POST" });
  expect((await route.POST(req, params(fork))).status).toBe(200);
  expect(payload()).toMatchObject({ op: `fork-${operation}`, slug: fork, userId: 101 });
  state.fetch.mockClear();
  for (const id of [102, 103]) { signIn(id); expect((await route.POST(req, params(fork))).status).toBe(404); }
  expect(state.fetch).not.toHaveBeenCalled();
  signIn(101); expect((await route.POST(req, params(slug))).status).toBe(404);
});
it("forwards fork room seat/reveal and action/chain-mode seats with trusted user identity", async () => {
  const room = await import("../app/api/duels/[slug]/route");
  expect((await room.GET(new Request(`http://localhost/api/duels/${fork}?as=1&reveal=0`), params(fork))).status).toBe(200);
  expect(payload()).toMatchObject({ op: "view", slug: fork, as: 1, reveal: false, userId: 101 });
  const action = await import("../app/api/duels/[slug]/actions/route");
  const command = { promptId: "p1", revision: 1, answer: { choice: "next" } };
  expect((await action.POST(new NextRequest(`http://localhost/api/duels/${fork}/actions?as=1`, { method: "POST", body: JSON.stringify(command) }), params(fork))).status).toBe(200);
  expect(payload()).toMatchObject({ op: "respond", as: 1, userId: 101, command });
  const chain = await import("../app/api/duels/[slug]/chain-mode/route");
  expect((await chain.POST(new NextRequest(`http://localhost/api/duels/${fork}/chain-mode?as=1`, { method: "POST", body: JSON.stringify({ mode: "always", revision: 2 }) }), params(fork))).status).toBe(200);
  expect(payload()).toMatchObject({ op: "chain-mode", as: 1, userId: 101, mode: "always", revision: 2 });
});
it.each(["as=4", "as=-1", "as=01", "as=1&as=0", "reveal=true", "reveal=1&reveal=0"])("rejects malformed fork view %s", async query => {
  const route = await import("../app/api/duels/[slug]/route");
  expect((await route.GET(new Request(`http://localhost/api/duels/${fork}?${query}`), params(fork))).status).toBe(400);
  expect(state.fetch).not.toHaveBeenCalled();
});
it("forwards a prompt-bound card announcement search for a fork", async () => {
  const { GET } = await import("../app/api/duels/cards/route");
  const response = await GET(new NextRequest(`http://localhost/api/duels/cards?slug=${fork}&q=Card&as=1&promptId=p1&revision=5`));
  expect(response.status).toBe(200); expect(payload()).toMatchObject({ op: "cards", slug: fork, as: 1, promptId: "p1", revision: 5, userId: 101 });
  state.fetch.mockClear();
  for (const query of [`slug=${fork}&as=1`, "as=1", `slug=${fork}&as=1&promptId=p1&revision=-1`]) {
    expect((await GET(new NextRequest(`http://localhost/api/duels/cards?${query}`))).status).toBe(400);
  }
  signIn(103); expect((await GET(new NextRequest(`http://localhost/api/duels/cards?slug=${fork}&as=1&promptId=p1&revision=5`))).status).toBe(404);
  expect(state.fetch).not.toHaveBeenCalled();
});
it("rejects acting-seat control on a real duel for its player", async () => {
  signIn(201);
  const route = await import("../app/api/duels/[slug]/route");
  expect((await route.GET(new Request(`http://localhost/api/duels/${slug}?as=1`), params(slug))).status).toBe(400);
  const cards = await import("../app/api/duels/cards/route");
  expect((await cards.GET(new NextRequest(`http://localhost/api/duels/cards?slug=${slug}&as=1`))).status).toBe(400);
  expect(state.fetch).not.toHaveBeenCalled();
});
it("rejects normal fork lobby and series routes, including deck validation", async () => {
  const routes = [await import("../app/api/duels/[slug]/seat/route"), await import("../app/api/duels/[slug]/leave/route"),
    await import("../app/api/duels/[slug]/ready/route"), await import("../app/api/duels/[slug]/unready/route"),
    await import("../app/api/duels/[slug]/start/route"), await import("../app/api/duels/[slug]/bot/route"),
    await import("../app/api/duels/[slug]/deck/route"), await import("../app/api/duels/[slug]/deck/validate/route"),
    await import("../app/api/duels/[slug]/opening/route"), await import("../app/api/duels/[slug]/series/first/route"),
    await import("../app/api/duels/[slug]/series/side/route"), await import("../app/api/duels/[slug]/series/ready/route"),
    await import("../app/api/duels/[slug]/series/unready/route"), await import("../app/api/duels/[slug]/invite/route")];
  for (const route of routes) {
    const request = new NextRequest(`http://localhost/api/duels/${fork}`, { method: "POST", body: JSON.stringify({ seat: 1, choice: "first", action: "pick", move: "rock" }) });
    const result = await route.POST(request, params(fork)); expect(result.status).toBe(409);
  }
  signIn(201);
  for (const route of routes) {
    const request = new NextRequest(`http://localhost/api/duels/${slug}?as=1`, { method: "POST", body: JSON.stringify({ seat: 1, choice: "first", action: "pick", move: "rock" }) });
    expect((await route.POST(request, params(slug))).status).toBe(400);
  }
  expect(state.fetch).not.toHaveBeenCalled();
});
it("rejects series cancel when a marked fork is linked to the series", async () => {
  const id = Number(state.db!.prepare(`insert into duel_series(guild_id, player0_id, player1_id, mode, settings_json, created_by_player_id)
    values('test-guild',61,62,'normal','{}',61)`).run().lastInsertRowid);
  state.db!.prepare("update duels set series_id = ? where web_slug = ?").run(id, fork);
  const before = state.db!.prepare("select * from duel_series where id = ?").get(id);
  const { POST } = await import("../app/api/duels/series/[id]/cancel/route");
  const response = await POST(new Request(`http://localhost/api/duels/series/${id}/cancel`, { method: "POST" }),
    { params: Promise.resolve({ id: String(id) }) });
  expect(response.status).toBe(409); expect(state.db!.prepare("select * from duel_series where id = ?").get(id)).toEqual(before);
  expect(state.fetch).not.toHaveBeenCalled();
});
it("guards the report capability GET for a private fork", async () => {
  const { GET } = await import("../app/api/duels/[slug]/report/route");
  signIn(103); expect((await GET(new Request(`http://localhost/api/duels/${fork}/report`), params(fork))).status).toBe(404);
  signIn(101); expect((await GET(new Request(`http://localhost/api/duels/${fork}/report`), params(fork))).status).toBe(200);
});
it("drops fork room data if access is revoked during the host wait", async () => {
  const { GET } = await import("../app/api/duels/[slug]/route");
  state.fetch.mockImplementation(async () => { vi.stubEnv("OWNER_USER_IDS", ""); return Response.json({ engine: { private: "fixture" } }); });
  const response = await GET(new Request(`http://localhost/api/duels/${fork}?as=1`), params(fork));
  expect(response.status).toBe(404); expect(await response.json()).not.toHaveProperty("engine");
});
