import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { migrate } from "@yugidraft/shared/db";
import { createUserService } from "@yugidraft/shared/services";

const state = vi.hoisted(() => ({ db: null as Database.Database | null, auth: vi.fn() }));
vi.mock("@/lib/session-identity", async () => {
  const { sessionFixture } = await import("./fixtures/session");
  return sessionFixture(state.auth);
});
vi.mock("@/lib/db", () => ({ getDb: () => state.db! }));

const discordUserId = "900000000000000007";
let userId: number;

beforeEach(() => {
  vi.resetModules();
  state.auth.mockReset();
  state.db = new Database(":memory:");
  migrate(state.db);
  userId = createUserService(state.db).ensureDiscord({ discordUserId, displayName: "Yugi" }).id;
  state.auth.mockResolvedValue({ user: { id: String(userId), discordUserId, name: "Yugi" } });
  vi.stubEnv("DISCORD_GUILD_ID", "guild-1");
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Unexpected Discord I/O"); }));
});
afterEach(() => {
  state.db?.close();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const playerCount = () => state.db!.prepare("select count(*) as c from players").get();

describe("requireDuelActor signed-in access", () => {
  it("creates the signed-in player, preserving independent player and user IDs", async () => {
    state.db!.prepare("insert into players(id,guild_id,user_id,discord_user_id,display_name) values(61,?,?,?,?)")
      .run("historical-guild", userId, discordUserId, "Old Yugi");
    const { requireDuelActor } = await import("../src/lib/duel-host");
    const actor = await requireDuelActor();
    expect(actor.ok).toBe(true);
    if (!actor.ok) throw new Error("expected signed-in actor");
    expect(actor.guildId).toBe("guild-1");
    expect(actor.userId).toBe(userId);
    expect(actor.playerId).toBe(62);
    expect(actor.playerId).not.toBe(userId);
    expect(state.db!.prepare("select user_id,discord_user_id from players where id=?").get(actor.playerId))
      .toEqual({ user_id: userId, discord_user_id: discordUserId });
    expect(state.db!.prepare("select id,display_name from players where guild_id='historical-guild'").get())
      .toEqual({ id: 61, display_name: "Old Yugi" });
    expect((await requireDuelActor()).ok).toBe(true);
    expect(playerCount()).toEqual({ c: 2 });
    expect(fetch).not.toHaveBeenCalledWith(`https://discord.com/api/v10/guilds/guild-1/members/${userId}`, expect.any(Object));
  });

  it("does not create a player when signed out", async () => {
    state.auth.mockResolvedValue(null);
    const { requireDuelActor } = await import("../src/lib/duel-host");
    const actor = await requireDuelActor();
    expect(actor.ok).toBe(false);
    if (actor.ok) throw new Error("expected signed-out actor to fail");
    expect(actor.response.status).toBe(401);
    expect(playerCount()).toEqual({ c: 0 });
  });

  it("does not create a player when account resolution is unavailable", async () => {
    state.auth.mockRejectedValue(new Error("Session unavailable"));
    const { requireDuelActor } = await import("../src/lib/duel-host");
    const actor = await requireDuelActor();
    expect(actor.ok).toBe(false);
    if (actor.ok) throw new Error("expected unavailable session to fail");
    expect(actor.response.status).toBe(503);
    expect(fetch).not.toHaveBeenCalled();
    expect(playerCount()).toEqual({ c: 0 });
  });
});

describe("common web actor boundary", () => {
  it.each([101, null, undefined, "", "0", "01", " 1", "+1", "1.0", "1e3", "-1", "9007199254740992", discordUserId])("rejects malformed session ID %s before player creation", async (id) => {
    state.auth.mockResolvedValue({ user: { id, discordUserId, name: "Yugi" } });
    const { requireDuelActor } = await import("../src/lib/duel-host");
    const actor = await requireDuelActor();
    expect(actor.ok).toBe(false);
    if (actor.ok) throw new Error("expected invalid identity to fail");
    expect(actor.response.status).toBe(401);
    expect(fetch).not.toHaveBeenCalled();
    expect(playerCount()).toEqual({ c: 0 });
  });

  it.each([null, undefined, ""])("allows an email-only identity %s", async discordId => {
    state.auth.mockResolvedValue({ user: { id: String(userId), discordUserId: discordId, name: "Yugi" } });
    const { requireWebAccess } = await import("../src/lib/web-access");
    expect(await requireWebAccess()).toEqual({ ok: true, userId, discordUserId: null, userName: "Yugi" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("returns the integer application identity without Discord calls", async () => {
    const { requireWebAccess } = await import("../src/lib/web-access");
    expect(await requireWebAccess()).toEqual({ ok: true, userId, discordUserId, userName: "Yugi" });
    expect(fetch).not.toHaveBeenCalledWith(`https://discord.com/api/v10/guilds/guild-1/members/${userId}`, expect.any(Object));
  });

  it("returns 503 when the session is unavailable", async () => {
    state.auth.mockRejectedValue(new Error("Session unavailable"));
    const { requireWebAccess } = await import("../src/lib/web-access");
    const actor = await requireWebAccess();
    expect(actor.ok).toBe(false);
    if (actor.ok) throw new Error("expected admin denial");
    expect(actor.response.status).toBe(503);
  });
});

describe("saved-deck actor", () => {
  it("resolves an integer owner through the common signed-in guard without creating a player", async () => {
    const { requireSavedDeckActor, loadDeckRegistrations } = await import("../src/lib/saved-decks");
    const actor = await requireSavedDeckActor();
    expect(actor.ok).toBe(true);
    if (!actor.ok) throw new Error("expected saved-deck actor");
    expect(actor).toMatchObject({ guildId: "guild-1", ownerUserId: userId, discordUserId });
    expect(loadDeckRegistrations("guild-1", actor.ownerUserId)).toEqual([]);
    expect(playerCount()).toEqual({ c: 0 });
  });

  it.each([401, 503])("blocks deck access on session failure %s", async (status) => {
    if (status === 401) state.auth.mockResolvedValue(null);
    else state.auth.mockRejectedValue(new Error("Session unavailable"));
    const { requireSavedDeckActor } = await import("../src/lib/saved-decks");
    const actor = await requireSavedDeckActor();
    expect(actor.ok).toBe(false);
    if (actor.ok) throw new Error("expected deck access denial");
    expect(actor.response.status).toBe(status);
    expect(playerCount()).toEqual({ c: 0 });
  });

  it("rejects a numeric JSON session ID before accessing saved decks", async () => {
    state.auth.mockResolvedValue({ user: { id: userId, discordUserId } });
    const { requireSavedDeckActor } = await import("../src/lib/saved-decks");
    const actor = await requireSavedDeckActor();
    expect(actor.ok).toBe(false);
    if (actor.ok) throw new Error("expected invalid owner denial");
    expect(actor.response.status).toBe(401);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("cube creator ownership", () => {
  function cube(guildId = "guild-1") {
    return Number(state.db!.prepare("insert into cubes(guild_id,name,created_by_user_id) values(?,?,?)")
      .run(guildId, "Owner cube", userId).lastInsertRowid);
  }

  it("compares integer owner IDs without asking Discord for owner writes", async () => {
    const cubeId = cube();
    const { cubeWriteAccess } = await import("../src/lib/cube-access");
    expect(await cubeWriteAccess(state.db!, cubeId, { userId, discordUserId })).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects a former admin who is not the creator", async () => {
    const cubeId = cube();
    const admin = createUserService(state.db!).ensureDiscord({ discordUserId: "900000000000000102", displayName: "Admin" });
    const { cubeWriteAccess } = await import("../src/lib/cube-access");
    expect((await cubeWriteAccess(state.db!, cubeId, { userId: admin.id, discordUserId: admin.discordUserId! }))?.status).toBe(403);
    expect(fetch).not.toHaveBeenCalledWith(`https://discord.com/api/v10/guilds/guild-1/members/${admin.id}`, expect.any(Object));
  });

  it("denies a non-creator without external checks", async () => {
    const cubeId = cube();

    const { cubeWriteAccess } = await import("../src/lib/cube-access");
    const response = await cubeWriteAccess(state.db!, cubeId, { userId: userId + 1, discordUserId: "900000000000000102" });
    expect(response?.status).toBe(403);
  });

  it("denies a non-creator even without Discord", async () => {
    const cubeId = cube();

    const { cubeWriteAccess } = await import("../src/lib/cube-access");
    const response = await cubeWriteAccess(state.db!, cubeId, { userId: userId + 1, discordUserId: null });
    expect(response?.status).toBe(403);
  });

  it("does not expose a cube from a historical guild even to its owner", async () => {
    const cubeId = cube("historical-guild");
    const { cubeWriteAccess } = await import("../src/lib/cube-access");
    expect((await cubeWriteAccess(state.db!, cubeId, { userId, discordUserId }))?.status).toBe(404);
    expect(fetch).not.toHaveBeenCalled();
  });
});
