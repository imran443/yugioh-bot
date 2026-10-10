import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { migrate } from "@yugidraft/shared/db";
import { createDuelService } from "@yugidraft/shared/services";
import { seedIdentity } from "../../shared/tests/helpers/identity";

const state = vi.hoisted(() => ({ db: null as Database.Database | null, auth: vi.fn(), fetch: vi.fn() }));
vi.mock("@/lib/session-identity", async () => {
  const { sessionFixture } = await import("./fixtures/session"); return sessionFixture(state.auth);
});
vi.mock("@/lib/db", () => ({ getDb: () => state.db! }));
let slug: string;
const signIn = (id: number) => state.auth.mockResolvedValue({ user: { id: String(id), name: "Test actor" } });
beforeEach(() => {
  vi.resetModules(); state.auth.mockReset(); state.fetch.mockReset();
  state.db = new Database(":memory:"); migrate(state.db);
  for (const [playerId, userId] of [[61, 101], [62, 102], [63, 103], [64, 201]]) {
    seedIdentity(state.db, { guildId: "test-guild", playerId, userId });
  }
  slug = createDuelService(state.db).create({ guildId: "test-guild", organizerPlayerId: 64, name: "Source", mode: "normal" }).slug;
  vi.stubEnv("DISCORD_GUILD_ID", "test-guild"); vi.stubEnv("OWNER_USER_IDS", "101,102");
  vi.stubEnv("DUEL_INTERNAL_URL", "http://duel.test"); vi.stubEnv("DUEL_INTERNAL_SECRET", "route-test-secret");
  state.fetch.mockImplementation(async () => Response.json({ version: 2, frames: [] })); vi.stubGlobal("fetch", state.fetch); signIn(103);
});
afterEach(() => { state.db?.close(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
async function get(admin: boolean, query = "") {
  const path = admin ? "../app/api/admin/duels/[slug]/replay/route" : "../app/api/duels/[slug]/replay/route";
  const route = admin ? await import("../app/api/admin/duels/[slug]/replay/route") : await import("../app/api/duels/[slug]/replay/route");
  return route.GET(new Request(`http://localhost/api/${path}/${slug}?${query}`), { params: Promise.resolve({ slug }) });
}
function payload() { return JSON.parse(state.fetch.mock.calls.at(-1)![1].body as string); }
it("keeps the v1 normal request and forwards v2 visibility with trusted identity", async () => {
  expect((await get(false)).status).toBe(200);
  expect(payload()).toEqual({ op: "replay", slug, guildId: "test-guild", playerId: 63, userId: 103 });
  expect((await get(false, "version=2&visibility=public")).status).toBe(200);
  expect(payload()).toMatchObject({ op: "replay", version: 2, visibility: "public" });
});
it.each(["seat=1", "reveal=0", "as=1", "version=3", "visibility=private", "version=2&version=1", "seat=", "isOwner=true"])
("rejects normal private or malformed query %s before host calls", async query => {
  const response = await get(false, query); expect(response.status).toBe(400); expect(state.fetch).not.toHaveBeenCalled();
});
it("checks normal current source access", async () => {
  state.db!.prepare("update duels set settings_json = json_set(settings_json, '$.visibility', 'private') where web_slug = ?").run(slug);
  const response = await get(false, "version=2"); expect(response.status).toBe(403); expect(state.fetch).not.toHaveBeenCalled();
  expect(await response.json()).toMatchObject({ code: "ACCESS_DENIED" });
});
it.each([401, 503])("returns a typed normal replay access error for status %s", async status => {
  if (status === 401) state.auth.mockResolvedValue(null); else state.auth.mockRejectedValue(new Error("Auth unavailable"));
  const response = await get(false, "version=2"); expect(response.status).toBe(status);
  expect(await response.json()).toMatchObject({ code: status === 401 ? "ACCESS_DENIED" : "ACCESS_UNAVAILABLE" });
});
it.each([101, 102])("allows the privileged first fetch for owner %s without normal source access", async id => {
  signIn(id);
  state.db!.prepare("update duels set settings_json = json_set(settings_json, '$.visibility', 'private') where web_slug = ?").run(slug);
  const response = await get(true); expect(response.status).toBe(200);
  expect(payload()).toEqual({ op: "owner-replay", slug, guildId: "test-guild", playerId: id === 101 ? 61 : 62, userId: id, version: 2 });
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(state.db!.prepare("select * from duel_invite_grants").all()).toEqual([]);
});
it("forwards explicit owner seat/reveal and preserves default projection when seat is absent", async () => {
  signIn(101);
  expect((await get(true, "seat=1&reveal=1")).status).toBe(200);
  expect(payload()).toMatchObject({ seat: 1, reveal: true, version: 2 });
  expect((await get(true, "reveal=0&visibility=public")).status).toBe(200);
  expect(payload()).toMatchObject({ reveal: false, visibility: "public" }); expect(payload()).not.toHaveProperty("seat");
});
it.each(["seat=-1", "seat=01", "seat=4", "seat=1.5", "reveal=true", "as=1", "seat=1&seat=0", "version=1"])
("rejects owner query %s", async query => {
  signIn(101); expect((await get(true, query)).status).toBe(400); expect(state.fetch).not.toHaveBeenCalled();
});
it.each(["", "103"])("denies privileged alpha requests with owner list %s before source lookup", async list => {
  vi.stubEnv("OWNER_USER_IDS", list === "103" ? "101,102" : list);
  const response = await get(true); expect(response.status).toBe(404);
  expect(await response.json()).toMatchObject({ code: "ACCESS_DENIED" }); expect(state.fetch).not.toHaveBeenCalled();
});
it.each([401, 503])("keeps signed-out/unavailable owner status %s", async status => {
  if (status === 401) state.auth.mockResolvedValue(null); else state.auth.mockRejectedValue(new Error("Auth unavailable"));
  const response = await get(true); expect(response.status).toBe(status); expect(state.fetch).not.toHaveBeenCalled();
});
it("forwards typed host errors with finalBoard and no-store", async () => {
  const body = { error: "Resources changed", code: "ENGINE_UNAVAILABLE_FOR_SOURCE", finalBoard: "available" };
  state.fetch.mockResolvedValue(Response.json(body, { status: 409 }));
  const response = await get(false, "version=2"); expect(response.status).toBe(409);
  expect(await response.json()).toEqual(body); expect(response.headers.get("cache-control")).toBe("private, no-store");
});
it.each([false, true])("returns ENGINE_BUSY if the replay host is down (owner=%s)", async admin => {
  if (admin) signIn(101);
  state.fetch.mockRejectedValue(new TypeError("fetch failed"));
  vi.spyOn(console, "error").mockImplementation(() => {});
  const response = await get(admin, "version=2"); expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({ code: "ENGINE_BUSY" });
});
it("rechecks owner access on the next call and never returns a cached private response", async () => {
  signIn(101); await get(true, "seat=1");
  vi.stubEnv("OWNER_USER_IDS", "");
  expect((await get(true, "seat=1")).status).toBe(404); expect(state.fetch).toHaveBeenCalledTimes(1);
});
it("denies a source in another guild", async () => {
  signIn(101); state.db!.prepare("update duels set guild_id = 'other-guild' where web_slug = ?").run(slug);
  expect((await get(true)).status).toBe(404); expect(state.fetch).not.toHaveBeenCalled();
});
it("denies other owners and normal users who request a known fork slug", async () => {
  state.db!.exec("alter table duels add column kind text not null default 'play'");
  const setup = { replayFork: { ownerUserId: 101, control: "all-manual", origin: {
    sourceSlug: "source-fixture", sourceVersion: "source-v1", frameId: "frame-0", step: 0, prefixCount: 0,
    prefixHash: "a".repeat(64), sourceSeats: [{ seat: 0, displayName: null }, { seat: 1, displayName: null }],
  } } };
  state.db!.prepare("update duels set kind = 'replay-fork', setup_json = ? where web_slug = ?").run(JSON.stringify(setup), slug);
  for (const id of [102, 103, 201]) {
    signIn(id); expect((await get(false, "version=2")).status).toBe(404); expect((await get(true)).status).toBe(404);
  }
  expect(state.fetch).not.toHaveBeenCalled();
});
it("drops private data if the allowlist is revoked during the host wait", async () => {
  signIn(101); state.fetch.mockImplementation(async () => {
    vi.stubEnv("OWNER_USER_IDS", ""); return Response.json({ version: 2, frames: [{ private: "fixture" }] });
  });
  const response = await get(true, "seat=1"); expect(response.status).toBe(404);
  expect(await response.json()).toMatchObject({ code: "ACCESS_DENIED" });
});
