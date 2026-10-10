import type Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fixtureUserId, seedFixtureUsers } from "./fixtures/identity";

const auth = vi.fn();
const broadcast = vi.fn();
vi.mock("@/lib/session-identity", async () => {
  const { sessionFixture } = await import("./fixtures/session");
  return sessionFixture(auth);
});
vi.mock("@/lib/notify", () => ({ broadcaster: { draft: broadcast }, announcer: { announce: vi.fn() } }));

let db: Database.Database;
let directory: string;
const userId = fixtureUserId("host");
const context = { params: Promise.resolve({ slug: "draft" }) };
const request = (method: string, body?: unknown) => new Request("http://localhost/api/drafts/draft", {
  method, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
}) as NextRequest;
const closed = { error: "Theme drafts are not open yet." };

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  auth.mockResolvedValue({ user: { id: String(userId), name: "Host" } });
  directory = mkdtempSync(join(tmpdir(), "theme-drafts-flag-"));
  vi.stubEnv("DATABASE_PATH", join(directory, "test.sqlite"));
  vi.stubEnv("DISCORD_GUILD_ID", "guild");
  vi.stubEnv("DISCORD_BOT_ENABLED", "0");
  vi.stubEnv("THEME_DRAFTS", "0");
  db = (await import("@/lib/db")).getDb();
  seedFixtureUsers(db, ["host", "guest"]);
  db.prepare("insert into players (guild_id, user_id, display_name) values ('guild', ?, 'Host')").run(userId);
  db.prepare("insert into cubes (guild_id, name, created_by_user_id) values ('guild', 'First', ?), ('guild', 'Second', ?)").run(userId, userId);
});

afterEach(() => {
  db?.close();
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

function seedDraft(mode: "theme" | "booster" = "theme", status = "pending") {
  db.prepare(`insert into drafts (guild_id, name, status, config_json, created_by_user_id, web_slug)
    values ('guild', 'Draft', ?, ?, ?, 'draft')`).run(status, JSON.stringify({
    mode, allowedCubeIds: [1], themeSelection: "player_pick", extraDeckEnabled: false,
  }), userId);
  db.prepare("insert into draft_players (draft_id, player_id) values (1, 1)").run();
}

describe("new theme drafts", () => {
  it.each([undefined, "0", "false", "TRUE"])("refuses POST when THEME_DRAFTS=%j", async (value) => {
    vi.stubEnv("THEME_DRAFTS", value);
    const { POST } = await import("../app/api/drafts/route");
    const response = await POST(request("POST", { name: "New theme", config: { mode: "theme" } }));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual(closed);
    expect(db.prepare("select count(*) as n from drafts").get()).toEqual({ n: 0 });
    expect(db.prepare("select count(*) as n from draft_players").get()).toEqual({ n: 0 });
  });

  it.each(["1", "true", "on"])("creates a theme with THEME_DRAFTS=%j", async (value) => {
    vi.stubEnv("THEME_DRAFTS", value);
    const { POST } = await import("../app/api/drafts/route");
    const response = await POST(request("POST", { name: "New theme", config: { mode: "theme" } }));
    expect(response.status).toBe(201);
    const row = db.prepare("select config_json from drafts").get() as { config_json: string };
    expect(JSON.parse(row.config_json).mode).toBe("theme");
  });

  it("refuses a PUT that changes a cube draft to a theme draft", async () => {
    seedDraft("booster");
    const before = db.prepare("select * from drafts").get();
    const { PUT } = await import("../app/api/drafts/[slug]/route");
    const response = await PUT(request("PUT", { name: "New theme", config: { mode: "theme" } }), context);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual(closed);
    expect(db.prepare("select * from drafts").get()).toEqual(before);
    expect(broadcast).not.toHaveBeenCalled();
  });

  it("allows a PUT that changes a cube draft to a theme draft when on", async () => {
    seedDraft("booster");
    vi.stubEnv("THEME_DRAFTS", "1");
    const { PUT } = await import("../app/api/drafts/[slug]/route");
    const response = await PUT(request("PUT", { config: { mode: "theme" } }), context);
    expect(response.status).toBe(200);
    expect((await response.json()).config.mode).toBe("theme");
  });
});

describe("theme setup routes", () => {
  it.each(["cubes", "claim-cube"])("refuses new theme work through %s on a cube draft when off", async (path) => {
    seedDraft("booster");
    const { POST } = path === "cubes"
      ? await import("../app/api/drafts/[slug]/cubes/route")
      : await import("../app/api/drafts/[slug]/claim-cube/route");
    const before = db.prepare("select * from drafts").get();
    const response = await POST(request("POST", { kind: "blank", name: "New cube", cubeId: 1 }), context);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual(closed);
    expect(db.prepare("select * from drafts").get()).toEqual(before);
    expect(db.prepare("select count(*) as n from cubes").get()).toEqual({ n: 2 });
    expect(db.prepare("select count(*) as n from draft_player_cube").get()).toEqual({ n: 0 });
  });

  it("lets an existing theme lobby edit, attach, claim, release, detach and preflight when off", async () => {
    seedDraft();
    const { PUT } = await import("../app/api/drafts/[slug]/route");
    expect((await PUT(request("PUT", { name: "Still open", config: { mode: "theme", pickSeconds: 60 } }), context)).status).toBe(200);
    const cubes = await import("../app/api/drafts/[slug]/cubes/route");
    expect((await cubes.POST(request("POST", { kind: "existing", cubeId: 2 }), context)).status).toBe(201);
    const claims = await import("../app/api/drafts/[slug]/claim-cube/route");
    expect((await claims.POST(request("POST", { cubeId: 1 }), context)).status).toBe(200);
    const { GET } = await import("../app/api/drafts/[slug]/preflight/route");
    expect((await GET(request("GET"), context)).status).toBe(200);
    expect((await claims.DELETE(request("DELETE"), context)).status).toBe(200);
    expect((await cubes.DELETE(request("DELETE", { cubeId: 2 }), context)).status).toBe(200);
  });

  it("keeps preflight available for an active theme draft when off", async () => {
    seedDraft("theme", "active");
    const { GET } = await import("../app/api/drafts/[slug]/preflight/route");
    expect((await GET(request("GET"), context)).status).toBe(200);
  });

  it("refuses a new theme preflight after the lobby and game have ended", async () => {
    seedDraft("theme", "completed");
    const { GET } = await import("../app/api/drafts/[slug]/preflight/route");
    const response = await GET(request("GET"), context);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual(closed);
  });

  it("keeps cube-draft preflight available when off", async () => {
    seedDraft("booster");
    const { GET } = await import("../app/api/drafts/[slug]/preflight/route");
    expect((await GET(request("GET"), context)).status).toBe(200);
  });
});

describe("create-flow capabilities", () => {
  it.each(["0", "on"])("returns themeDraftsEnabled from the server with THEME_DRAFTS=%s", async (value) => {
    vi.stubEnv("THEME_DRAFTS", value);
    const drafts = await import("../app/api/drafts/route");
    const cubes = await import("../app/api/cubes/route");
    expect((await (await drafts.GET(new Request("http://localhost/api/drafts"))).json()).themeDraftsEnabled).toBe(value === "on");
    expect((await (await cubes.GET()).json()).themeDraftsEnabled).toBe(value === "on");
  });
});
