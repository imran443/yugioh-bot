import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { migrate } from "@yugidraft/shared/db";
import { createDuelService } from "@yugidraft/shared/services";
import { seedIdentity } from "../../shared/tests/helpers/identity";

const state = vi.hoisted(() => ({ db: null as Database.Database | null, auth: vi.fn() }));
vi.mock("@/lib/session-identity", async () => {
  const { sessionFixture } = await import("./fixtures/session");
  return sessionFixture(state.auth);
});
vi.mock("@/lib/db", () => ({ getDb: () => state.db! }));

let sourceSlug: string;
let forkSlug: string;
const owner = { guildId: "test-guild", playerId: 61, userId: 101 };
const signIn = (userId: number) => state.auth.mockResolvedValue({ user: { id: String(userId), name: "Test actor" } });
const load = () => import("../src/lib/replay-fork-access");

beforeEach(() => {
  vi.resetModules();
  state.auth.mockReset();
  state.db = new Database(":memory:");
  migrate(state.db);
  for (const [playerId, userId] of [[61, 101], [62, 102], [63, 103], [64, 201]]) {
    seedIdentity(state.db, { guildId: owner.guildId, playerId, userId, name: "Test actor" });
  }
  const duels = createDuelService(state.db);
  const input = { guildId: owner.guildId, name: "Private bug-report source", mode: "normal" as const, settings: { visibility: "private" } };
  sourceSlug = duels.create({ ...input, organizerPlayerId: 64 }).slug;
  forkSlug = "fork-fixture";
  const setup = { replayFork: {
    ownerUserId: owner.userId, control: "all-manual",
    origin: { sourceSlug, sourceVersion: "version-fixture", frameId: "frame-0", step: 0, prefixCount: 0,
      prefixHash: "a".repeat(64), sourceSeats: [{ seat: 0, displayName: "A" }, { seat: 1, displayName: "B" }] },
  } };
  state.db.prepare(`insert into duels(guild_id,web_slug,name,organizer_player_id,mode,status,kind,setup_json)
    values(?,?,'Fork fixture',?,'normal','active','replay-fork',?)`)
    .run(owner.guildId, forkSlug, owner.playerId, JSON.stringify(setup));
  vi.stubEnv("DISCORD_GUILD_ID", owner.guildId);
  vi.stubEnv("OWNER_USER_IDS", "101,102");
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Unexpected external I/O"); }));
  signIn(owner.userId);
});

afterEach(() => { if (state.db?.open) state.db.close(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it.each([101, 102])("allows owner source access without a source grant: %s", async userId => {
  signIn(userId);
  const { requireOwnerReplaySource } = await load();
  const rows = () => state.db!.prepare("select * from duels order by id").all();
  const before = rows();
  const actor = await requireOwnerReplaySource(sourceSlug);
  expect(actor.ok).toBe(true);
  if (!actor.ok) throw new Error("Expected owner access");
  expect(actor.userId).toBe(userId);
  expect(actor.source).toMatchObject({ slug: sourceSlug, guildId: owner.guildId, kind: "play" });
  expect(() => actor.duels.room(sourceSlug, actor.guildId, actor.playerId)).toThrowError(expect.objectContaining({ status: 403 }));
  expect(rows()).toEqual(before);
  expect(state.db!.prepare("select * from duel_invite_grants").all()).toEqual([]);
  expect(fetch).not.toHaveBeenCalled();
});

it.each([undefined, "", "103", "01,abc,9007199254740992"])("fails closed for owner list %s", async ids => {
  vi.stubEnv("OWNER_USER_IDS", ids);
  const { requireOwnerReplaySource } = await load();
  const result = await requireOwnerReplaySource(sourceSlug);
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("Expected access denial");
  expect(result.response.status).toBe(404);
  expect(await result.response.json()).toMatchObject({ code: "ACCESS_DENIED" });
});

it("denies an alpha user without source data in the response", async () => {
  signIn(103);
  const { requireOwnerReplaySource } = await load();
  const result = await requireOwnerReplaySource(sourceSlug);
  if (result.ok) throw new Error("Expected access denial");
  expect(result.response.status).toBe(404);
  const text = await result.response.text();
  expect(text).not.toContain(sourceSlug);
  expect(text).not.toContain("bug-report");
  expect(fetch).not.toHaveBeenCalled();
});

it.each([401, 503])("preserves session failure status %s", async status => {
  if (status === 401) state.auth.mockResolvedValue(null);
  else state.auth.mockRejectedValue(new Error("Session unavailable"));
  const { requireOwnerReplaySource } = await load();
  const result = await requireOwnerReplaySource(sourceSlug);
  if (result.ok) throw new Error("Expected session failure");
  expect(result.response.status).toBe(status);
  expect(await result.response.json()).toMatchObject({ code: status === 401 ? "ACCESS_DENIED" : "ACCESS_UNAVAILABLE" });
});

it("denies sources outside the configured guild", async () => {
  state.db!.prepare("update duels set guild_id = 'other-guild' where web_slug = ?").run(sourceSlug);
  const { requireOwnerReplaySource } = await load();
  const result = await requireOwnerReplaySource(sourceSlug);
  if (result.ok) throw new Error("Expected guild denial");
  expect(result.response.status).toBe(404);
});

it("denies another approved developer's fork", async () => {
  signIn(102);
  const { requireOwnerReplaySource } = await load();
  const result = await requireOwnerReplaySource(forkSlug);
  if (result.ok) throw new Error("Expected creator denial");
  expect(result.response.status).toBe(404);
});

it("checks revocation again on a saved web actor", async () => {
  const { requireReplayOwnerActor, assertDuelForkAccess } = await load();
  const actor = await requireReplayOwnerActor();
  if (!actor.ok) throw new Error("Expected owner actor");
  expect(assertDuelForkAccess(forkSlug, actor).kind).toBe("replay-fork");
  vi.stubEnv("OWNER_USER_IDS", "102");
  expect(() => assertDuelForkAccess(forkSlug, actor)).toThrowError(expect.objectContaining({ status: 404, code: "ACCESS_DENIED" }));
});

it("denies a forged actor at the fork guard", async () => {
  const { requireReplayOwnerActor, assertDuelForkAccess } = await load();
  const actor = await requireReplayOwnerActor();
  if (!actor.ok) throw new Error("Expected owner actor");
  expect(() => assertDuelForkAccess(forkSlug, { ...actor, playerId: 63 })).toThrowError(expect.objectContaining({ status: 404 }));
});

it("returns a safe coded error for a fork guard failure", async () => {
  const { ReplayAccessError } = await import("@yugidraft/shared/access/owner-access");
  const { duelErrorResponse } = await import("../src/lib/duel-host");
  const response = duelErrorResponse(new ReplayAccessError());
  expect(response.status).toBe(404);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(await response.json()).toMatchObject({ code: "ACCESS_DENIED" });
});

it("returns 503 when the actor database is unavailable", async () => {
  state.db!.close();
  const { requireOwnerReplaySource } = await load();
  const result = await requireOwnerReplaySource(sourceSlug);
  if (result.ok) throw new Error("Expected unavailable access");
  expect(result.response.status).toBe(503);
  expect(result.response.headers.get("cache-control")).toBe("private, no-store");
  expect(await result.response.json()).toEqual({ error: "Replay access is unavailable", code: "ACCESS_UNAVAILABLE" });
});

it("returns 503 when the source access reader is unavailable", async () => {
  const host = await import("../src/lib/duel-host");
  const actor = await host.requireDuelActor();
  if (!actor.ok) throw new Error("Expected owner actor");
  vi.spyOn(host, "requireDuelActor").mockResolvedValue(actor);
  const originalPrepare = state.db!.prepare.bind(state.db!);
  vi.spyOn(state.db!, "prepare").mockImplementation(sql => {
    if (sql === "select * from duels where web_slug = ? and guild_id = ?") throw new Error("Private database detail");
    return originalPrepare(sql);
  });
  const { requireOwnerReplaySource } = await load();
  const result = await requireOwnerReplaySource(sourceSlug);
  if (result.ok) throw new Error("Expected unavailable source access");
  expect(result.response.status).toBe(503);
  expect(await result.response.json()).toEqual({ error: "Replay access is unavailable", code: "ACCESS_UNAVAILABLE" });
});

it("reports unavailable fork access for a saved actor when the database closes", async () => {
  const { requireReplayOwnerActor, assertDuelForkAccess } = await load();
  const actor = await requireReplayOwnerActor();
  if (!actor.ok) throw new Error("Expected owner actor");
  state.db!.close();
  expect(() => assertDuelForkAccess(forkSlug, actor)).toThrowError(expect.objectContaining({ status: 503, code: "ACCESS_UNAVAILABLE" }));
});
