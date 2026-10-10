import Database from "better-sqlite3";
import type { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { migrate } from "../../shared/src/db/schema";

const { actor, database, broadcast, environment } = vi.hoisted(() => ({
  actor: { userId: 101 as number | null }, database: { current: null as Database.Database | null }, broadcast: vi.fn(),
  environment: { discordGuildId: "g", webUrl: "https://draft.example", discordBotEnabled: false },
}));
vi.mock("@/lib/web-access", () => ({ requireWebAccess: async () => actor.userId === null
  ? { ok: false, response: Response.json({ error: "Unauthorized" }, { status: 401 }) }
  : { ok: true, userId: actor.userId, userName: "Guest", discordUserId: null } }));
vi.mock("@/lib/db", () => ({ getDb: () => database.current! }));
vi.mock("@/lib/env", () => ({ env: environment }));
vi.mock("@/lib/notify", () => ({ broadcaster: { draft: broadcast }, announcer: { announce: vi.fn() } }));

function request(method: string, body?: unknown) {
  return new Request("https://draft.example/api/drafts/draft/invite", {
    method, headers: { "content-type": "application/json", "x-forwarded-for": "127.0.0.1" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }) as NextRequest;
}
function context(slug = "draft") { return { params: Promise.resolve({ slug }) }; }
async function invite(method: "GET" | "POST", body?: unknown, slug = "draft") {
  const route = await import("../app/api/drafts/[slug]/invite/route");
  return route[method](request(method, body), context(slug));
}
async function reset(slug = "draft") {
  return (await import("../app/api/drafts/[slug]/invite/reset/route")).POST(request("POST"), context(slug));
}
async function visibility(value: unknown, slug = "draft") {
  return (await import("../app/api/drafts/[slug]/visibility/route")).PATCH(request("PATCH", { visibility: value }), context(slug));
}
async function join() {
  return (await import("../app/api/drafts/[slug]/join/route")).POST(request("POST"), context());
}
async function detail() {
  return (await import("../app/api/drafts/[slug]/route")).GET(request("GET"), context());
}

beforeEach(() => {
  vi.resetModules(); broadcast.mockReset(); broadcast.mockResolvedValue(undefined); actor.userId = 101;
  environment.discordBotEnabled = false;
  // These routes must stay offline, including creation from already-cached cards.
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Unexpected network request"); }));
  database.current = new Database(":memory:"); migrate(database.current); database.current.pragma("foreign_keys=on");
  database.current.exec(`insert into users(id,username,display_name) values(101,'creator','Creator'),(102,'seated','Seated'),(103,'grant','Grant'),(104,'stranger','Stranger');
    insert into players(id,guild_id,user_id,display_name) values(1,'g',102,'Seated');
    insert into drafts(id,guild_id,name,status,created_by_user_id,web_slug) values(1,'g','Draft','pending',101,'draft');
    insert into draft_players(draft_id,player_id) values(1,1);
    insert into draft_invite_grants(draft_id,user_id) values(1,103);`);
});
afterEach(() => { database.current?.close(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("draft invites", () => {
  it("rate limits redemption across draft slugs before code comparison", async () => {
    actor.userId = 104;
    for (let i = 0; i < 10; i++) expect((await invite("POST", { code: "wrong" }, `unknown-${i}`)).status).toBe(404);
    const limited = await invite("POST", { code: "wrong" });
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
  });
  it("lazily creates and reuses the host link without exposing it to guests", async () => {
    expect(database.current!.prepare("select invite_code from drafts").get()).toEqual({ invite_code: null });
    const response = await invite("GET");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const first = await response.json();
    expect(first.inviteCode).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(first.inviteUrl).toBe(`https://draft.example/draft/draft?invite=${first.inviteCode}`);
    expect(await (await invite("GET")).json()).toEqual(first);
    expect(broadcast).not.toHaveBeenCalled();
  });

  it("records an application-user grant on a matching link, retains grants on reset and rejects the old code", async () => {
    const old = await (await invite("GET")).json();
    actor.userId = 104;
    expect((await detail()).status).toBe(404);
    expect((await invite("POST", { code: old.inviteCode })).status).toBe(200);
    expect(await (await invite("POST", { code: old.inviteCode })).json()).toEqual({ ok: true });
    expect(database.current!.prepare("select user_id from draft_invite_grants order by user_id").all()).toEqual([{ user_id: 103 }, { user_id: 104 }]);
    expect(database.current!.prepare("select id from players where user_id=104").get()).toBeUndefined();
    expect(await (await detail()).json()).toMatchObject({ visibility: "private", canJoin: true });
    actor.userId = 101;
    const rotated = await (await reset()).json();
    expect(rotated.inviteCode).not.toBe(old.inviteCode);
    expect(rotated.inviteUrl).toBe(`https://draft.example/draft/draft?invite=${rotated.inviteCode}`);
    actor.userId = 104;
    expect((await invite("POST", { code: old.inviteCode })).status).toBe(404);
    expect((await detail()).status).toBe(200);
    expect((await join()).status).toBe(200);
    expect((await invite("POST", { code: rotated.inviteCode })).status).toBe(200);
    expect(broadcast.mock.calls).toEqual([[{ kind: "seats", slug: "draft" }]]);
  });

  it.each(["wrong", "x".repeat(43), "", null, 123, {}, undefined])("hides a mismatched or invalid invite (%j)", async (code) => {
    await invite("GET"); actor.userId = 104;
    const response = await invite("POST", { code });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Draft not found" });
    expect(database.current!.prepare("select user_id from draft_invite_grants where user_id=104").get()).toBeUndefined();
  });

  it("does not admit an uninitialized, missing or other-guild draft", async () => {
    actor.userId = 104;
    expect((await invite("POST", { code: "unknown" })).status).toBe(404);
    expect((await invite("POST", { code: "unknown" }, "missing")).status).toBe(404);
    database.current!.exec("update drafts set guild_id='other',invite_code='known'");
    expect((await invite("POST", { code: "known" })).status).toBe(404);
  });

  it("returns the same 404 for malformed JSON", async () => {
    actor.userId = 104;
    const route = await import("../app/api/drafts/[slug]/invite/route");
    expect((await route.POST(new Request("http://localhost", { method: "POST", body: "{" }), context())).status).toBe(404);
  });
});

describe("creator endpoints", () => {
  for (const [name, call] of [["read link", () => invite("GET")], ["reset link", () => reset()], ["visibility", () => visibility("open")]] as const) {
    it.each([102, 103, 104])(`${name} returns 404 for noncreator %s`, async (userId) => {
      actor.userId = userId;
      expect((await call()).status).toBe(404);
      expect(database.current!.prepare("select visibility,invite_code from drafts").get()).toEqual({ visibility: "private", invite_code: null });
    });
    it(`${name} requires a session and hides another guild`, async () => {
      actor.userId = null; expect((await call()).status).toBe(401);
      actor.userId = 101; database.current!.exec("update drafts set guild_id='other'");
      expect((await call()).status).toBe(404);
    });
  }
  it("invite redemption requires a session", async () => { actor.userId = null; expect((await invite("POST", { code: "a" })).status).toBe(401); });
});

describe("visibility", () => {
  it("changes pending visibility and sends only a lobby invalidation", async () => {
    expect((await visibility("open")).status).toBe(200);
    expect(await (await visibility("private")).json()).toEqual({ visibility: "private" });
    expect(broadcast.mock.calls).toEqual([[{ kind: "seats", slug: "draft" }], [{ kind: "seats", slug: "draft" }]]);
    expect(database.current!.prepare("select invite_code from drafts").get()).toEqual({ invite_code: null });
  });
  it.each(["public", "", null, 123, {}])("validates the visibility value (%j)", async (value) => {
    expect((await visibility(value)).status).toBe(400);
    expect(database.current!.prepare("select visibility from drafts").get()).toEqual({ visibility: "private" });
  });
  it.each(["active", "completed", "cancelled"])("keeps the access policy fixed after start (%s)", async (status) => {
    database.current!.prepare("update drafts set status=?").run(status);
    expect((await visibility("open")).status).toBe(409);
    expect(broadcast).not.toHaveBeenCalled();
  });
});

describe("seat admission", () => {
  it("hides a private draft from an uninvited stranger before creating a player", async () => {
    actor.userId = 104; const response = await join();
    expect(response.status).toBe(404);
    expect(database.current!.prepare("select id from players where user_id=104").get()).toBeUndefined();
  });
  it("lets the private creator leave and rejoin without a grant", async () => {
    expect((await join()).status).toBe(200);
    expect((await (await detail()).json()).canJoin).toBe(false);
    const route = await import("../app/api/drafts/[slug]/join/route");
    expect((await route.DELETE(request("DELETE"), context())).status).toBe(200);
    expect(await (await detail()).json()).toMatchObject({ visibility: "private", canJoin: true });
    expect((await join()).status).toBe(200);
    expect(database.current!.prepare("select p.user_id from draft_players dp join players p on p.id=dp.player_id where p.user_id=101").all()).toEqual([{ user_id: 101 }]);
    expect(database.current!.prepare("select 1 from draft_invite_grants where user_id=101").get()).toBeUndefined();
  });
  it("lets a grant holder take a pending private seat", async () => {
    actor.userId = 103; expect((await join()).status).toBe(200);
    expect(database.current!.prepare("select p.user_id from draft_players dp join players p on p.id=dp.player_id where p.user_id=103").get()).toEqual({ user_id: 103 });
    expect((await join()).status).toBe(400);
  });
  it("keeps open pending drafts joinable", async () => {
    database.current!.exec("update drafts set visibility='open'"); actor.userId = 104;
    expect((await join()).status).toBe(200);
  });
  it.each(["open", "private"])("rejects active %s seat admission", async (value) => {
    database.current!.prepare("update drafts set status='active',visibility=?").run(value);
    actor.userId = 103; expect((await join()).status).toBe(409);
    actor.userId = 104; expect((await join()).status).toBe(404);
  });
});

describe("private mutation existence", () => {
  it("Nudge hides a private draft when Discord effects are enabled", async () => {
    environment.discordBotEnabled = true;
    actor.userId = 104;
    const { POST } = await import("../app/api/drafts/[slug]/nudge/route");
    expect((await POST(request("POST", { invalid: true }), context())).status).toBe(404);
  });
  const mutations = [
    ["draft", "DELETE"], ["draft", "PUT"], ["draft", "POST"],
    ["join", "DELETE"], ["start", "POST"], ["start", "DELETE"], ["auto-start", "PUT"],
    ["ready", "POST"], ["players", "DELETE"], ["cubes", "POST"], ["cubes", "DELETE"],
    ["claim-cube", "POST"], ["claim-cube", "DELETE"], ["join-bot", "POST"], ["pick", "POST"], ["talk", "POST"],
  ] as const;
  const modules = {
    draft: () => import("../app/api/drafts/[slug]/route"),
    join: () => import("../app/api/drafts/[slug]/join/route"),
    start: () => import("../app/api/drafts/[slug]/start/route"),
    "auto-start": () => import("../app/api/drafts/[slug]/auto-start/route"),
    ready: () => import("../app/api/drafts/[slug]/ready/route"),
    players: () => import("../app/api/drafts/[slug]/players/[playerId]/route"),
    cubes: () => import("../app/api/drafts/[slug]/cubes/route"),
    "claim-cube": () => import("../app/api/drafts/[slug]/claim-cube/route"),
    "join-bot": () => import("../app/api/drafts/[slug]/join-bot/route"),
    pick: () => import("../app/api/drafts/[slug]/pick/route"),
    talk: () => import("../app/api/drafts/[slug]/talk/route"),
  };
  it.each(mutations)("%s %s hides an inaccessible private draft before body/status validation", async (name, method) => {
    actor.userId = 104;
    type Mutation = (request: NextRequest, ctx: { params: Promise<{ slug: string; playerId: string }> }) => Promise<Response>;
    const route: Partial<Record<"POST" | "PUT" | "DELETE", Mutation>> = await modules[name]();
    const ctx = { params: Promise.resolve({ slug: "draft", playerId: "1" }) };
    const response = await route[method]!(request(method, {}), ctx);
    expect(response.status).toBe(404);
    expect((await response.json()).error).toBe("Draft not found");
    expect(broadcast).not.toHaveBeenCalled();
  });
});

describe("detail and creation contracts", () => {
  it("shows visibility and join eligibility, with a creator-only invite capability", async () => {
    const host = await (await detail()).json();
    expect(host).toMatchObject({ visibility: "private", canJoin: true, canManageInvite: true });
    expect(host).not.toHaveProperty("inviteCode");
    actor.userId = 103; const guest = await (await detail()).json();
    expect(guest).toMatchObject({ visibility: "private", canJoin: true });
    expect(guest).not.toHaveProperty("canManageInvite"); expect(guest).not.toHaveProperty("inviteUrl"); expect(guest).not.toHaveProperty("inviteCode");
  });
  it("flags the host and an owner, and nobody else, as able to cancel", async () => {
    const host = await (await detail()).json();
    expect(host).toMatchObject({ canCancel: true });
    expect(host).not.toHaveProperty("canEndOrCancel");
    actor.userId = 103;
    expect(await (await detail()).json()).not.toHaveProperty("canCancel");
    vi.stubEnv("OWNER_USER_IDS", "103");
    try { expect(await (await detail()).json()).toMatchObject({ canCancel: true }); }
    finally { vi.unstubAllEnvs(); }
  });
  for (const mode of ["booster", "theme"] as const) {
    it.each([undefined, "private", "open"])(`${mode} creation persists visibility (%s)`, async (value) => {
      if (mode === "theme") vi.stubEnv("THEME_DRAFTS", "1");
      database.current!.prepare("insert into card_catalog(ygoprodeck_id,name,type,frame_type,image_url,image_url_small,card_sets_json,cached_at) values(100,'Card','Normal Monster','normal','i','i','[]',?)").run(new Date().toISOString());
      const route = await import("../app/api/drafts/route");
      const response = await route.POST(request("POST", { name: "New", visibility: value, config: { mode, customCardIds: [100] } }));
      expect(response.status).toBe(201);
      expect(await response.json()).toMatchObject({ visibility: value ?? "private" });
      expect(database.current!.prepare("select visibility from drafts where name='New'").get()).toEqual({ visibility: value ?? "private" });
    });
  }
  it.each(["public", null, {}, 1])("rejects invalid creation visibility before creating a draft (%j)", async (value) => {
    const route = await import("../app/api/drafts/route");
    expect((await route.POST(request("POST", { name: "New", visibility: value, config: { mode: "theme" } }))).status).toBe(400);
    expect(database.current!.prepare("select count(*) as n from drafts").get()).toEqual({ n: 1 });
  });
});
