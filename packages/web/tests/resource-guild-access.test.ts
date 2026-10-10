import { seedFixtureUsers, fixtureUserId, fixtureDiscordId } from "./fixtures/identity";
import { finishTestLobbyStart } from "./drafts-lobby-routes.test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.fn();
vi.mock("@/lib/session-identity", async () => {
  const { sessionFixture } = await import("./fixtures/session");
  return sessionFixture(auth);
});
vi.mock("@/lib/notify", () => ({ broadcaster: { tournament: vi.fn(), draft: vi.fn() }, announcer: { announce: vi.fn() } }));
vi.mock("@/lib/notify-duel", () => ({ notifyDuelChange: vi.fn() }));
vi.mock("@/lib/duel-host", () => ({
  callDuelHost: vi.fn(async () => ({
    ok: true,
    data: { deck: { main: [1001, 1002, 1003], extra: [], side: [] }, report: { issues: [] } },
  })),
}));
let tempDir: string;

describe("mutations are limited to the configured guild", () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.stubEnv("THEME_DRAFTS", "1");
    auth.mockResolvedValue({ user: { id: String(fixtureUserId("host")), discordUserId: fixtureDiscordId("host"), name: "Host" } });
    tempDir = mkdtempSync(join(tmpdir(), "yugioh-resource-access-"));
    vi.stubEnv("DATABASE_PATH", join(tempDir, "test.sqlite"));
    vi.stubEnv("DISCORD_GUILD_ID", "configured-guild");
    const { getDb } = await import("../src/lib/db");
    const db = getDb();
    seedFixtureUsers(db, FIXTURE_KEYS);
    db.prepare(`insert into tournaments (guild_id, name, format, status, created_by_user_id, web_slug) values ('other-guild', 'Foreign', 'round_robin', 'active', ${fixtureUserId("host")}, 'foreign')`).run();
    db.prepare(`insert into players (guild_id, user_id, discord_user_id, display_name) values ('other-guild', ${fixtureUserId("reporter")}, '${fixtureDiscordId("reporter")}', 'Reporter'), ('other-guild', ${fixtureUserId("host")}, '${fixtureDiscordId("host")}', 'Host')`).run();
    db.prepare("insert into tournament_participants (tournament_id, player_id) values (1,1), (1,2)").run();
    db.prepare("insert into tournament_matches (tournament_id, player_one_id, player_two_id, round_number, status) values (1,1,2,1,'open')").run();
    db.prepare("insert into matches (guild_id, player_one_id, player_two_id, winner_id, reporter_id, status, source) values ('other-guild',1,2,1,1,'pending','casual')").run();
    const { createSavedDeckService } = await import("@yugidraft/shared/services");
    createSavedDeckService(db).create("other-guild", fixtureUserId("host"), {
      name: "Foreign deck", mode: "normal", deck: { main: [1001, 1002, 1003], extra: [], side: [] },
    });
    db.prepare(`insert into cubes (guild_id, name, created_by_user_id) values ('other-guild', 'Foreign cube', ${fixtureUserId("host")}), ('configured-guild', 'Library cube', ${fixtureUserId("other-owner")})`).run();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(tempDir, { recursive: true, force: true });
  });

  const body = { playerId: 2, tournamentMatchId: 1, result: "win", winnerPlayerId: 1 };

  it.each(["POST", "PUT", "PATCH", "DELETE"] as const)("tournament %s hides another guild's tournament from its creator", async (method) => {
    const route = await import("../app/api/tournaments/[slug]/route");
    const res = await route[method](new Request("http://x", { method, body: method === "DELETE" ? undefined : JSON.stringify(body) }) as NextRequest, {
      params: Promise.resolve({ slug: "foreign" }),
    });
    expect(res.status).toBe(404);
  });

  it.each(["announce", "complete", "join-bot", "join", "kick", "leave", "reopen", "report"])("%s hides another guild's tournament", async (operation) => {
    const { POST } = await import(`../app/api/tournaments/[slug]/${operation}/route.ts`);
    const res = await POST(new Request("http://x", { method: "POST", body: JSON.stringify(body) }), { params: Promise.resolve({ slug: "foreign" }) });
    expect(res.status).toBe(404);
  });

  it("result overrides cannot target another guild", async () => {
    const { POST } = await import("../app/api/tournaments/[slug]/matches/[tmId]/result/route");
    const res = await POST(new Request("http://x", { method: "POST", body: JSON.stringify(body) }), {
      params: Promise.resolve({ slug: "foreign", tmId: "1" }),
    });
    expect(res.status).toBe(404);
  });

  it("deck registration cannot target another guild", async () => {
    const { PUT } = await import("../app/api/tournaments/[slug]/deck/route");
    const res = await PUT(new Request("http://x", { method: "PUT", body: JSON.stringify({ savedDeckId: 1 }) }) as NextRequest, {
      params: Promise.resolve({ slug: "foreign" }),
    });
    expect(res.status).toBe(404);
  });

  it.each(["approve", "deny"])("%s cannot resolve a match in another guild even as the opponent", async (operation) => {
    const { POST } = await import(`../app/api/matches/[id]/${operation}/route.ts`);
    const res = await POST(new Request("http://x", { method: "POST" }), { params: Promise.resolve({ id: "1" }) });
    expect(res.status).toBe(404);
  });

  it("theme creation cannot attach another guild's cube", async () => {
    const { POST } = await import("../app/api/drafts/route");
    const res = await POST(new Request("http://x", {
      method: "POST", body: JSON.stringify({ name: "Theme", channelId: "c", config: { mode: "theme", allowedCubeIds: [1] } }),
    }) as NextRequest);
    expect(res.status).toBe(404);
    const { getDb } = await import("../src/lib/db");
    expect(getDb().prepare("select count(*) as n from drafts").get()).toEqual({ n: 0 });
  });

  it("theme creation can use another member's cube in the configured guild", async () => {
    const { POST } = await import("../app/api/drafts/route");
    const res = await POST(new Request("http://x", {
      method: "POST", body: JSON.stringify({ name: "Theme", channelId: "c", config: { mode: "theme", allowedCubeIds: [2] } }),
    }) as NextRequest);
    expect(res.status).toBe(201);
  });

  it("draft config edits cannot attach another guild's cube", async () => {
    const { getDb } = await import("../src/lib/db");
    const db = getDb();
    seedFixtureUsers(db, FIXTURE_KEYS);
    db.prepare("insert into card_catalog (ygoprodeck_id, name, type, frame_type, image_url, image_url_small, card_sets_json, cached_at) values (1001,'Card','Normal Monster','normal','i','i','[]',?)").run(new Date().toISOString());
    db.prepare(`insert into drafts (guild_id, channel_id, name, status, created_by_user_id, config_json, web_slug) values ('configured-guild', 'c', 'Owned', 'pending', ${fixtureUserId("host")}, ?, 'owned')`).run(JSON.stringify({ customCardIds: [1001] }));
    const { PUT } = await import("../app/api/drafts/[slug]/route");
    const res = await PUT(new Request("http://x", {
      method: "PUT", body: JSON.stringify({ config: { allowedCubeIds: [1] } }),
    }) as NextRequest, { params: Promise.resolve({ slug: "owned" }) });
    expect(res.status).toBe(404);
    expect(JSON.parse((db.prepare("select config_json from drafts where web_slug = 'owned'").get() as { config_json: string }).config_json)).toEqual({ customCardIds: [1001] });
  });

  it("claiming a cube rejects a foreign cube in a legacy draft config", async () => {
    const { getDb } = await import("../src/lib/db");
    const db = getDb();
    seedFixtureUsers(db, FIXTURE_KEYS);
    const playerId = Number(db.prepare(`insert into players (guild_id, user_id, discord_user_id, display_name) values ('configured-guild', ${fixtureUserId("host")}, '${fixtureDiscordId("host")}', 'Host')`).run().lastInsertRowid);
    const draftId = Number(db.prepare(`insert into drafts (guild_id, channel_id, name, status, created_by_user_id, config_json, web_slug) values ('configured-guild', 'c', 'Owned', 'pending', ${fixtureUserId("host")}, ?, 'owned')`).run(JSON.stringify({ mode: "theme", allowedCubeIds: [1] })).lastInsertRowid);
    db.prepare("insert into draft_players (draft_id, player_id) values (?,?)").run(draftId, playerId);
    const { POST } = await import("../app/api/drafts/[slug]/claim-cube/route");
    const res = await POST(new Request("http://x", { method: "POST", body: JSON.stringify({ cubeId: 1 }) }), { params: Promise.resolve({ slug: "owned" }) });
    expect(res.status).toBe(404);
    expect(db.prepare("select count(*) as n from draft_player_cube").get()).toEqual({ n: 0 });
  });

  it.each([
    { label: "starting a legacy theme draft cannot consume a foreign cube", cubeId: 1, allowedCubeIds: [1], status: 404, draftStatus: "pending" },
    { label: "starting a draft still drops deleted cube references", cubeId: 2, allowedCubeIds: [2, 99999], status: 202, draftStatus: "active" },
  ])("$label", async ({ cubeId, allowedCubeIds, status, draftStatus }) => {
    const { getDb } = await import("../src/lib/db");
    const { createDraftService, createPlayerService } = await import("@yugidraft/shared/services");
    const db = getDb();
    seedFixtureUsers(db, FIXTURE_KEYS);
    db.transaction(() => {
      // Forty picks with three choices and burn disabled need 42 authored copies.
      for (let id = 1; id <= 42; id++) {
        db.prepare("insert into card_catalog (ygoprodeck_id, name, type, frame_type, image_url, image_url_small, card_sets_json, cached_at) values (?,?,'Normal Monster','normal','i','i','[]','t')").run(id, `Card ${id}`);
        db.prepare("insert into cube_cards (cube_id, catalog_card_id, pool, max_copies) values (?,?,'main',1)").run(cubeId, id);
      }
    })();
    const players = createPlayerService(db);
    const host = players.findOrCreate("configured-guild", fixtureUserId("host"), "Host");
    const guest = players.findOrCreate("configured-guild", fixtureUserId("guest"), "Guest");
    const drafts = createDraftService(db);
    const draft = drafts.create("configured-guild", "c", "Legacy", {
      mode: "theme", allowedCubeIds, uniqueThemes: false,
      themeSelection: "random", extraDeckEnabled: false,
    }, fixtureUserId("host"), host.id);
    drafts.join(draft.id, guest.id);
    const { POST } = await import("../app/api/drafts/[slug]/route");
    const res = await POST(new Request("http://x", { method: "POST", body: JSON.stringify({ force: true }) }), { params: Promise.resolve({ slug: draft.webSlug! }) });
    expect(res.status).toBe(status);
    if (status === 202) await finishTestLobbyStart(res, db);
    expect(drafts.findById(draft.id).status).toBe(draftStatus);
  });
  it("booster creation rejects foreign cube references before caching its card pool", async () => {
    const { getDb } = await import("../src/lib/db");
    getDb().prepare("insert into card_catalog (ygoprodeck_id, name, type, frame_type, image_url, image_url_small, card_sets_json, cached_at) values (1001,'Card','Normal Monster','normal','i','i','[]',?)").run(new Date().toISOString());
    const { POST } = await import("../app/api/drafts/route");
    const response = await POST(new Request("http://x", { method: "POST", body: JSON.stringify({
      name: "Booster", channelId: "c", config: { mode: "booster", customCardIds: [1001], allowedCubeIds: [1] },
    }) }) as NextRequest);
    expect(response.status).toBe(404);
    expect(getDb().prepare("select count(*) as n from drafts").get()).toEqual({ n: 0 });
  });

  it("rejects a booster-to-theme edit that retains a legacy foreign cube reference", async () => {
    const { getDb } = await import("../src/lib/db");
    const db = getDb();
    seedFixtureUsers(db, FIXTURE_KEYS);
    const config = { mode: "booster", customCardIds: [1001], allowedCubeIds: [1] };
    db.prepare("insert into card_catalog (ygoprodeck_id, name, type, frame_type, image_url, image_url_small, card_sets_json, cached_at) values (1001,'Card','Normal Monster','normal','i','i','[]',?)").run(new Date().toISOString());
    db.prepare(`insert into drafts (guild_id, channel_id, name, status, created_by_user_id, config_json, web_slug) values ('configured-guild', 'c', 'Legacy', 'pending', ${fixtureUserId("host")}, ?, 'legacy')`).run(JSON.stringify(config));
    const { PUT } = await import("../app/api/drafts/[slug]/route");
    const response = await PUT(new Request("http://x", { method: "PUT", body: JSON.stringify({ name: "Renamed", config: { mode: "theme" } }) }) as NextRequest, { params: Promise.resolve({ slug: "legacy" }) });
    expect(response.status).toBe(404);
    expect(db.prepare("select name, config_json from drafts where web_slug = 'legacy'").get()).toEqual({ name: "Legacy", config_json: JSON.stringify(config) });
  });

  it("legacy theme reads omit foreign cube names, counts and images", async () => {
    const { getDb } = await import("../src/lib/db");
    const db = getDb();
    seedFixtureUsers(db, FIXTURE_KEYS);
    db.prepare(`insert into drafts (guild_id, channel_id, name, status, created_by_user_id, config_json, web_slug) values ('configured-guild', 'c', 'Legacy', 'pending', ${fixtureUserId("host")}, ?, 'legacy')`).run(JSON.stringify({ mode: "theme", allowedCubeIds: [1, 2] }));
    const { GET } = await import("../app/api/drafts/[slug]/route");
    const response = await GET(new Request("http://x"), { params: Promise.resolve({ slug: "legacy" }) });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.allowedCubes).toEqual([{ id: 2, name: "Library cube", archetype: null, mainCount: 0, extraCount: 0, mainDistinct: 0, extraDistinct: 0, mainCopies: 0, extraCopies: 0, sampleImages: [] }]);
    expect(JSON.stringify(body)).not.toContain("Foreign cube");
  });

  it("preflight never analyzes another guild's legacy cube reference", async () => {
    const { getDb } = await import("../src/lib/db");
    getDb().prepare(`insert into drafts (guild_id, channel_id, name, status, created_by_user_id, config_json, web_slug) values ('configured-guild', 'c', 'Legacy', 'pending', ${fixtureUserId("host")}, ?, 'legacy')`).run(JSON.stringify({ mode: "theme", allowedCubeIds: [1, 2] }));
    const { GET } = await import("../app/api/drafts/[slug]/preflight/route");
    const response = await GET(new Request("http://x"), { params: Promise.resolve({ slug: "legacy" }) });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.errors).toContain("Cube 1: Cube not found");
    expect(JSON.stringify(body)).not.toContain("Foreign cube");
    expect(body.errors.some((error: string) => error.startsWith("Library cube:"))).toBe(true);
  });

});

const FIXTURE_KEYS = ["reporter", "host", "other-owner", "guest"] as const;

// Session resolution is mocked; authorization still runs through the real web boundary.
