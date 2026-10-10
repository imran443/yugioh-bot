import { fixtureUserId, fixtureDiscordId, seedFixtureUsers } from "./fixtures/identity";
import { finishTestLobbyStart } from "./drafts-lobby-routes.test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.fn();
const syncDraftPool = vi.fn();
const tempDirs: string[] = [];

vi.mock("@/lib/session-identity", async () => {
  const { sessionFixture } = await import("./fixtures/session");
  return sessionFixture(auth);
});
vi.mock("@/lib/notify", () => ({ announcer: { announce: vi.fn() }, broadcaster: { draft: vi.fn() } }));
vi.mock("@yugidraft/shared/services", async (importOriginal) => {
  const original = await importOriginal<typeof import("@yugidraft/shared/services")>();
  return {
    ...original,
    createCardCatalogService: (db: any) => ({
      ...original.createCardCatalogService(db),
      syncDraftPool,
    }),
  };
});

type SeedCube = { main: number; extra: number };

async function seedDraft(cubes: SeedCube[], configOverrides: Record<string, unknown> = {}) {
  const tempDir = mkdtempSync(join(tmpdir(), "yugioh-theme-lobby-"));
  const dbPath = join(tempDir, "lobby.sqlite");
  tempDirs.push(tempDir);
  process.env.DATABASE_PATH = dbPath;
  process.env.DISCORD_GUILD_ID = "guild-1";

  const Database = (await import("better-sqlite3")).default;
  const { migrate } = await import("@yugidraft/shared/db");
  const db = new Database(dbPath);
  migrate(db);
  seedFixtureUsers(db, FIXTURE_KEYS);
  db.exec("begin");

  const p1 = Number(db.prepare(`insert into players (guild_id, user_id, discord_user_id, display_name) values ('guild-1', ${fixtureUserId("u1")}, '${fixtureDiscordId("u1")}', 'P1')`).run().lastInsertRowid);
  const p2 = Number(db.prepare(`insert into players (guild_id, user_id, discord_user_id, display_name) values ('guild-1', ${fixtureUserId("u2")}, '${fixtureDiscordId("u2")}', 'P2')`).run().lastInsertRowid);

  const insCard = db.prepare(
    "insert into card_catalog (ygoprodeck_id,name,type,frame_type,image_url,image_url_small,card_sets_json,cached_at) values (?,?,?,?,?,?,?,?)",
  );
  let cardId = 1;
  const cubeIds: number[] = [];
  for (const t of cubes) {
    const cubeId = Number(db.prepare(`insert into cubes (guild_id, name, created_by_user_id, created_at, updated_at) values ('guild-1', ?, ${fixtureUserId("u")}, 't', 't')`).run(`Theme${cubeIds.length}`).lastInsertRowid);
    for (let i = 0; i < t.main; i++) {
      insCard.run(cardId, `M${cardId}`, "Normal Monster", "normal", "i", "i", "[]", "t");
      db.prepare("insert into cube_cards (cube_id, catalog_card_id, pool, max_copies) values (?, ?, 'main', 1)").run(cubeId, cardId);
      cardId++;
    }
    for (let i = 0; i < t.extra; i++) {
      insCard.run(cardId, `X${cardId}`, "XYZ Monster", "xyz", "i", "i", "[]", "t");
      db.prepare("insert into cube_cards (cube_id, catalog_card_id, pool, max_copies) values (?, ?, 'extra', 1)").run(cubeId, cardId);
      cardId++;
    }
    cubeIds.push(cubeId);
  }

  const config = {
    mode: "theme",
    allowedCubeIds: cubeIds,
    themeSelection: "player_pick",
    uniqueThemes: true,
    themePackSize: 3,
    cardsPerPlayer: 40,
    extraDeckEnabled: true,
    extraDeckSize: 15,
    burnUnpicked: false,
    pickSeconds: 45,
    ...configOverrides,
  };
  const draftId = Number(
    db
      .prepare(
        `insert into drafts (guild_id, channel_id, name, status, created_by_user_id, config_json, web_slug, current_wave_number, current_pick_step, visibility) values ('guild-1', 'c', 'Theme Night', 'pending', ${fixtureUserId("u1")}, ?, ?, 0, 0, 'open')`,
      )
      .run(JSON.stringify(config), "theme-slug").lastInsertRowid,
  );
  db.prepare("insert into draft_players (draft_id, player_id) values (?, ?)").run(draftId, p1);
  db.prepare("insert into draft_players (draft_id, player_id) values (?, ?)").run(draftId, p2);
  db.exec("commit");
  db.close();

  return { cubeIds, p1, p2, dbPath };
}

describe("theme lobby routes", () => {
  beforeEach(() => {
    vi.resetModules();
    auth.mockReset();
    syncDraftPool.mockReset();
    syncDraftPool.mockResolvedValue([]);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    delete process.env.DATABASE_PATH;
    delete process.env.DISCORD_GUILD_ID;
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each([undefined, { "1": 1 }])("rejects switching to host assignment without every player's assignment (%j)", async (themeAssignments) => {
    const { dbPath } = await seedDraft([{ main: 42, extra: 0 }, { main: 42, extra: 0 }]);
    auth.mockResolvedValue({ user: { id: String(fixtureUserId("u1")), discordUserId: fixtureDiscordId("u1"), name: "P1" } });
    const { PUT } = await import("../app/api/drafts/[slug]/route");
    const response = await PUT(new Request("http://localhost/api/drafts/theme-slug", {
      method: "PUT",
      body: JSON.stringify({ config: { themeSelection: "host_assigned", themeAssignments } }),
    }) as NextRequest, { params: Promise.resolve({ slug: "theme-slug" }) });

    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/assignment for every player/i);
    const Database = (await import("better-sqlite3")).default;
    const db = new Database(dbPath);
    const row = db.prepare("select config_json from drafts").get() as { config_json: string };
    expect(JSON.parse(row.config_json).themeSelection).toBe("player_pick");
    db.close();
  }, 30000);

  it("allows switching to fully assigned themes and starting without a booster pool", async () => {
    const { cubeIds, p1, p2 } = await seedDraft([{ main: 42, extra: 0 }, { main: 42, extra: 0 }], { extraDeckEnabled: false });
    auth.mockResolvedValue({ user: { id: String(fixtureUserId("u1")), discordUserId: fixtureDiscordId("u1"), name: "P1" } });
    const { PUT, POST } = await import("../app/api/drafts/[slug]/route");
    const themeAssignments = { [p1]: cubeIds[1], [p2]: cubeIds[0] };
    const response = await PUT(new Request("http://localhost/api/drafts/theme-slug", {
      method: "PUT",
      body: JSON.stringify({ config: { themeSelection: "host_assigned", themeAssignments } }),
    }) as NextRequest, { params: Promise.resolve({ slug: "theme-slug" }) });

    expect(response.status).toBe(200);
    expect((await response.json()).config).toMatchObject({ themeSelection: "host_assigned", themeAssignments });
    const { GET } = await import("../app/api/drafts/[slug]/preflight/route");
    const preflight = await GET(new Request("http://localhost"), { params: Promise.resolve({ slug: "theme-slug" }) });
    expect((await preflight.json()).errors).toEqual([]);
    const started = await POST(new Request("http://localhost", { method: "POST", body: JSON.stringify({ force: true }) }), { params: Promise.resolve({ slug: "theme-slug" }) });
    expect(started.status).toBe(202);
    expect((await finishTestLobbyStart(started)).status).toBe("active");
  }, 30000);

  it("rejects start when an assigned cube moves guild during catalog sync", async () => {
    const { cubeIds, p1, p2 } = await seedDraft([{ main: 42, extra: 0 }, { main: 42, extra: 0 }], {
      themeSelection: "host_assigned", themeAssignments: { "1": 1, "2": 2 }, extraDeckEnabled: false,
      setNames: ["Metal Raiders"],
    });
    auth.mockResolvedValue({ user: { id: String(fixtureUserId("u1")), discordUserId: fixtureDiscordId("u1"), name: "P1" } });
    const { getDb } = await import("@/lib/db");
    const db = getDb();
    seedFixtureUsers(db, FIXTURE_KEYS);
    let releaseCatalog!: (response: Response) => void;
    let catalogRequested!: () => void;
    const catalogResponse = new Promise<Response>((resolve) => { releaseCatalog = resolve; });
    const requested = new Promise<void>((resolve) => { catalogRequested = resolve; });
    vi.stubGlobal("fetch", vi.fn((input: string | URL) => {
      expect(new URL(String(input)).searchParams.get("cardset")).toBe("Metal Raiders");
      catalogRequested();
      return catalogResponse;
    }));
    const original = await vi.importActual<typeof import("@yugidraft/shared/services")>("@yugidraft/shared/services");
    syncDraftPool.mockImplementationOnce(original.createCardCatalogService(db).syncDraftPool);
    const { POST } = await import("../app/api/drafts/[slug]/route");
    const starting = POST(new Request("http://localhost", { method: "POST", body: JSON.stringify({ force: true }) }), { params: Promise.resolve({ slug: "theme-slug" }) });

    await requested;
    db.prepare("update cubes set guild_id = 'guild-2' where id = ?").run(cubeIds[1]);
    releaseCatalog(new Response(JSON.stringify({ data: [] }), { status: 200 }));
    const response = await starting;

    expect(response.status).toBe(404);
    expect((await response.json()).code).toBe("CUBE_NOT_FOUND");
    expect(db.prepare("select status, started_at from drafts").get()).toEqual({ status: "pending", started_at: null });
    expect(db.prepare("select seat_index from draft_players where player_id in (?, ?) order by player_id").all(p1, p2))
      .toEqual([{ seat_index: null }, { seat_index: null }]);
    expect(db.prepare("select * from draft_player_cube").all()).toEqual([]);
    expect(db.prepare("select * from draft_packs").all()).toEqual([]);
  }, 30000);

  describe.each(["edit", "preflight", "start"])("host assignment validation at %s", (entryPoint) => {
    it.each(["detached", "deleted", "duplicate"])("ignores an unjoined player's %s assignment", async (staleAssignment) => {
      const { cubeIds, p1, p2 } = await seedDraft([{ main: 42, extra: 0 }, { main: 42, extra: 0 }, { main: 0, extra: 0 }], {
        themeSelection: "host_assigned", themeAssignments: { "1": 1, "2": 2, "3": staleAssignment === "duplicate" ? 1 : 3 }, extraDeckEnabled: false,
      });
      const { getDb } = await import("@/lib/db");
      const db = getDb();
      seedFixtureUsers(db, FIXTURE_KEYS);
      db.prepare(`insert into players (guild_id, user_id, discord_user_id, display_name) values ('guild-1', ${fixtureUserId("u3")}, '${fixtureDiscordId("u3")}', 'P3')`).run();
      auth.mockResolvedValue({ user: { id: String(fixtureUserId("u1")), discordUserId: fixtureDiscordId("u1"), name: "P1" } });
      const params = { params: Promise.resolve({ slug: "theme-slug" }) };
      if (staleAssignment === "detached") {
        const { DELETE } = await import("../app/api/drafts/[slug]/cubes/route");
        const detached = await DELETE(new Request("http://localhost", {
          method: "DELETE", body: JSON.stringify({ cubeId: cubeIds[2] }),
        }), params);
        expect(detached.status).toBe(200);
        expect((await detached.json()).allowedCubeIds).toEqual(cubeIds.slice(0, 2));
      }
      if (staleAssignment === "deleted") db.prepare("delete from cubes where id = ?").run(cubeIds[2]);

      if (entryPoint === "preflight") {
        const { GET } = await import("../app/api/drafts/[slug]/preflight/route");
        const response = await GET(new Request("http://localhost"), params);
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ errors: [], warnings: [] });
      } else {
        const { PUT, POST } = await import("../app/api/drafts/[slug]/route");
        const response = entryPoint === "edit"
          ? await PUT(new Request("http://localhost", {
            method: "PUT", body: JSON.stringify({ name: "Renamed Night", config: { pickSeconds: 60 } }),
          }) as NextRequest, params)
          : await POST(new Request("http://localhost", { method: "POST", body: JSON.stringify({ force: true }) }), params);
        expect(response.status).toBe(entryPoint === "start" ? 202 : 200);
        const body = entryPoint === "start" ? await finishTestLobbyStart(response) : await response.json();
        if (entryPoint === "edit") expect(body).toMatchObject({ name: "Renamed Night", config: { pickSeconds: 60 } });
        else {
          expect(body.status).toBe("active");
          expect(db.prepare("select player_id, cube_id from draft_player_cube order by player_id").all())
            .toEqual([{ player_id: p1, cube_id: cubeIds[0] }, { player_id: p2, cube_id: cubeIds[1] }]);
        }
      }
    }, 30000);

    it("rejects an unused allowed theme from another guild", async () => {
      const { cubeIds } = await seedDraft([{ main: 42, extra: 0 }, { main: 42, extra: 0 }, { main: 42, extra: 0 }], {
        themeSelection: "host_assigned", themeAssignments: { "1": 1, "2": 2 }, extraDeckEnabled: false,
      });
      const { getDb } = await import("@/lib/db");
      const db = getDb();
      seedFixtureUsers(db, FIXTURE_KEYS);
      db.prepare("update cubes set guild_id = 'guild-2' where id = ?").run(cubeIds[2]);
      const before = db.prepare("select name, status, config_json from drafts").get();
      auth.mockResolvedValue({ user: { id: String(fixtureUserId("u1")), discordUserId: fixtureDiscordId("u1"), name: "P1" } });
      const params = { params: Promise.resolve({ slug: "theme-slug" }) };

      if (entryPoint === "preflight") {
        const { GET } = await import("../app/api/drafts/[slug]/preflight/route");
        const response = await GET(new Request("http://localhost"), params);
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ errors: [`Cube ${cubeIds[2]}: Cube not found`], warnings: [] });
      } else {
        const { PUT, POST } = await import("../app/api/drafts/[slug]/route");
        const response = entryPoint === "edit"
          ? await PUT(new Request("http://localhost", {
            method: "PUT", body: JSON.stringify({ name: "Renamed Night", config: { pickSeconds: 60 } }),
          }) as NextRequest, params)
          : await POST(new Request("http://localhost", { method: "POST", body: JSON.stringify({ force: true }) }), params);
        expect(response.status).toBe(404);
        expect(await response.json()).toEqual({ error: "Cube not found" });
      }

      expect(db.prepare("select name, status, config_json from drafts").get()).toEqual(before);
      expect(db.prepare("select count(*) as n from draft_player_cube").get()).toEqual({ n: 0 });
    }, 30000);

    it("allows an unused deleted allowed theme", async () => {
      const { cubeIds, p1, p2 } = await seedDraft([{ main: 42, extra: 0 }, { main: 42, extra: 0 }, { main: 42, extra: 0 }], {
        themeSelection: "host_assigned", themeAssignments: { "1": 1, "2": 2 }, extraDeckEnabled: false,
      });
      const { getDb } = await import("@/lib/db");
      const db = getDb();
      seedFixtureUsers(db, FIXTURE_KEYS);
      db.prepare("delete from cubes where id = ?").run(cubeIds[2]);
      auth.mockResolvedValue({ user: { id: String(fixtureUserId("u1")), discordUserId: fixtureDiscordId("u1"), name: "P1" } });
      const params = { params: Promise.resolve({ slug: "theme-slug" }) };

      if (entryPoint === "preflight") {
        const { GET } = await import("../app/api/drafts/[slug]/preflight/route");
        const response = await GET(new Request("http://localhost"), params);
        expect(response.status).toBe(200);
        expect((await response.json()).errors).toEqual([]);
      } else {
        const { PUT, POST } = await import("../app/api/drafts/[slug]/route");
        const response = entryPoint === "edit"
          ? await PUT(new Request("http://localhost", {
            method: "PUT", body: JSON.stringify({ config: { pickSeconds: 60 } }),
          }) as NextRequest, params)
          : await POST(new Request("http://localhost", { method: "POST", body: JSON.stringify({ force: true }) }), params);
        expect(response.status).toBe(entryPoint === "start" ? 202 : 200);
        const body = entryPoint === "start" ? await finishTestLobbyStart(response) : await response.json();
        if (entryPoint === "edit") expect(body.config).toMatchObject({ pickSeconds: 60, allowedCubeIds: cubeIds, themeAssignments: { [p1]: cubeIds[0], [p2]: cubeIds[1] } });
        else {
          expect(body.status).toBe("active");
          expect(db.prepare("select player_id, cube_id from draft_player_cube order by player_id").all())
            .toEqual([{ player_id: p1, cube_id: cubeIds[0] }, { player_id: p2, cube_id: cubeIds[1] }]);
        }
      }

      const row = db.prepare("select status, config_json from drafts").get() as { status: string; config_json: string };
      expect(row.status).toBe(entryPoint === "start" ? "active" : "pending");
      expect(JSON.parse(row.config_json).pickSeconds).toBe(entryPoint === "edit" ? 60 : 45);
    }, 30000);

    it.each(["foreign-guild", "deleted", "nonexistent"])("rejects a %s assigned theme", async (invalidCube) => {
      await seedDraft([{ main: 42, extra: 0 }, { main: 42, extra: 0 }], {
        themeSelection: "host_assigned",
        themeAssignments: { "1": 1, "2": invalidCube === "nonexistent" ? 999 : 2 },
        allowedCubeIds: [1, invalidCube === "nonexistent" ? 999 : 2],
        extraDeckEnabled: false,
      });
      const { getDb } = await import("@/lib/db");
      const db = getDb();
      seedFixtureUsers(db, FIXTURE_KEYS);
      if (invalidCube === "foreign-guild") db.prepare("update cubes set guild_id = 'guild-2' where id = 2").run();
      if (invalidCube === "deleted") db.prepare("delete from cubes where id = 2").run();
      auth.mockResolvedValue({ user: { id: String(fixtureUserId("u1")), discordUserId: fixtureDiscordId("u1"), name: "P1" } });
      const params = { params: Promise.resolve({ slug: "theme-slug" }) };

      if (entryPoint === "preflight") {
        const { GET } = await import("../app/api/drafts/[slug]/preflight/route");
        const response = await GET(new Request("http://localhost"), params);
        expect(response.status).toBe(200);
        expect((await response.json()).errors).toEqual(["Host-assigned themes must exist in the draft's guild. Choose valid themes or switch to Random or Players pick."]);
      } else {
        const { PUT, POST } = await import("../app/api/drafts/[slug]/route");
        const response = entryPoint === "edit"
          ? await PUT(new Request("http://localhost", {
            method: "PUT", body: JSON.stringify({ config: { pickSeconds: 60 } }),
          }) as NextRequest, params)
          : await POST(new Request("http://localhost", { method: "POST", body: JSON.stringify({ force: true }) }), params);
        expect(response.status).toBe(invalidCube === "foreign-guild" ? 404 : entryPoint === "start" ? 409 : 400);
        const failure = await response.json();
        if (invalidCube === "foreign-guild") expect(failure.error).toBe("Cube not found");
        else if (entryPoint === "start") {
          expect(failure.code).toBe("PREFLIGHT_FAILED");
          expect(failure.errors).toContain("Host-assigned themes require an allowed theme assignment for every player");
        } else expect(failure.error).toBe("Host-assigned themes must exist in the draft's guild. Choose valid themes or switch to Random or Players pick.");
      }

      const row = db.prepare("select status, config_json from drafts").get() as { status: string; config_json: string };
      expect(row.status).toBe("pending");
      expect(JSON.parse(row.config_json).pickSeconds).toBe(45);
      expect(db.prepare("select count(*) as n from draft_player_cube").get()).toEqual({ n: 0 });
    }, 30000);

    it.each([true, false])("enforces uniqueThemes=%s for duplicate assignments", async (uniqueThemes) => {
      await seedDraft([{ main: 42, extra: 0 }, { main: 42, extra: 0 }], {
        themeSelection: "host_assigned", themeAssignments: { "1": 1, "2": 1 }, uniqueThemes, extraDeckEnabled: false,
      });
      auth.mockResolvedValue({ user: { id: String(fixtureUserId("u1")), discordUserId: fixtureDiscordId("u1"), name: "P1" } });
      const params = { params: Promise.resolve({ slug: "theme-slug" }) };

      if (entryPoint === "preflight") {
        const { GET } = await import("../app/api/drafts/[slug]/preflight/route");
        const response = await GET(new Request("http://localhost"), params);
        expect(response.status).toBe(200);
        const body = await response.json();
        if (uniqueThemes) expect(body.errors).toContainEqual(expect.stringMatching(/distinct.*uniqueThemes/i));
        else expect(body.errors).toEqual([]);
      } else {
        const { PUT, POST } = await import("../app/api/drafts/[slug]/route");
        const response = entryPoint === "edit"
          ? await PUT(new Request("http://localhost", {
            method: "PUT", body: JSON.stringify({ config: { pickSeconds: 60 } }),
          }) as NextRequest, params)
          : await POST(new Request("http://localhost", { method: "POST", body: JSON.stringify({ force: true }) }), params);
        expect(response.status).toBe(uniqueThemes ? (entryPoint === "start" ? 409 : 400) : entryPoint === "start" ? 202 : 200);
        const body = entryPoint === "start" && response.status === 202 ? await finishTestLobbyStart(response) : await response.json();
        if (uniqueThemes) expect(body.error).toMatch(/distinct.*uniqueThemes/i);
        else if (entryPoint === "edit") expect(body.config).toMatchObject({ themeAssignments: { "1": 1, "2": 1 }, uniqueThemes: false });
        else {
          expect(body.status).toBe("active");
          const { getDb } = await import("@/lib/db");
          expect(getDb().prepare("select player_id, cube_id from draft_player_cube order by player_id").all())
            .toEqual([{ player_id: 1, cube_id: 1 }, { player_id: 2, cube_id: 1 }]);
        }
      }
    }, 30000);
  });

  it("preflight ignores an empty theme assigned only to an unjoined player", async () => {
    const { cubeIds, p1, p2 } = await seedDraft([{ main: 42, extra: 0 }, { main: 42, extra: 0 }, { main: 0, extra: 0 }], {
      themeSelection: "host_assigned", themeAssignments: { "1": 1, "2": 2, "3": 3 }, extraDeckEnabled: false,
    });
    const { getDb } = await import("@/lib/db");
    const db = getDb();
    seedFixtureUsers(db, FIXTURE_KEYS);
    db.prepare(`insert into players (guild_id, user_id, discord_user_id, display_name) values ('guild-1', ${fixtureUserId("u3")}, '${fixtureDiscordId("u3")}', 'P3')`).run();
    auth.mockResolvedValue({ user: { id: String(fixtureUserId("u1")), discordUserId: fixtureDiscordId("u1"), name: "P1" } });
    const params = { params: Promise.resolve({ slug: "theme-slug" }) };
    const { GET } = await import("../app/api/drafts/[slug]/preflight/route");
    const response = await GET(new Request("http://localhost"), params);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ errors: [], warnings: [] });
    const { POST } = await import("../app/api/drafts/[slug]/route");
    const started = await POST(new Request("http://localhost", { method: "POST", body: JSON.stringify({ force: true }) }), params);
    expect(started.status).toBe(202);
    expect((await finishTestLobbyStart(started)).status).toBe("active");
    expect(db.prepare("select player_id, cube_id from draft_player_cube order by player_id").all())
      .toEqual([{ player_id: p1, cube_id: cubeIds[0] }, { player_id: p2, cube_id: cubeIds[1] }]);
  }, 30000);

  it("rejects enabling uniqueThemes when the merged assignments contain duplicates", async () => {
    await seedDraft([{ main: 42, extra: 0 }, { main: 42, extra: 0 }], {
      themeSelection: "host_assigned", themeAssignments: { "1": 1, "2": 1 }, uniqueThemes: false,
    });
    auth.mockResolvedValue({ user: { id: String(fixtureUserId("u1")), discordUserId: fixtureDiscordId("u1"), name: "P1" } });
    const { PUT } = await import("../app/api/drafts/[slug]/route");
    const response = await PUT(new Request("http://localhost", {
      method: "PUT", body: JSON.stringify({ config: { uniqueThemes: true } }),
    }) as NextRequest, { params: Promise.resolve({ slug: "theme-slug" }) });

    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/distinct.*uniqueThemes/i);
    const { getDb } = await import("@/lib/db");
    const row = getDb().prepare("select config_json from drafts").get() as { config_json: string };
    expect(JSON.parse(row.config_json).uniqueThemes).toBe(false);
  }, 30000);

  it("validates stored host assignments on a rename-only edit", async () => {
    await seedDraft([{ main: 42, extra: 0 }, { main: 42, extra: 0 }], {
      themeSelection: "host_assigned", themeAssignments: { "1": 1, "2": 2 },
    });
    const { getDb } = await import("@/lib/db");
    getDb().prepare("delete from cubes where id = 2").run();
    auth.mockResolvedValue({ user: { id: String(fixtureUserId("u1")), discordUserId: fixtureDiscordId("u1"), name: "P1" } });
    const { PUT } = await import("../app/api/drafts/[slug]/route");
    const response = await PUT(new Request("http://localhost", {
      method: "PUT", body: JSON.stringify({ name: "Renamed Night" }),
    }) as NextRequest, { params: Promise.resolve({ slug: "theme-slug" }) });

    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/exist.*draft.*guild/i);
    expect(getDb().prepare("select name from drafts").get()).toEqual({ name: "Theme Night" });
  }, 30000);

  it("still starts random selection after discarding a deleted allowed theme", async () => {
    await seedDraft([{ main: 42, extra: 0 }, { main: 42, extra: 0 }, { main: 42, extra: 0 }], {
      themeSelection: "random", extraDeckEnabled: false,
    });
    const { getDb } = await import("@/lib/db");
    getDb().prepare("delete from cubes where id = 3").run();
    auth.mockResolvedValue({ user: { id: String(fixtureUserId("u1")), discordUserId: fixtureDiscordId("u1"), name: "P1" } });
    const { POST } = await import("../app/api/drafts/[slug]/route");
    const response = await POST(new Request("http://localhost", { method: "POST", body: JSON.stringify({ force: true }) }), { params: Promise.resolve({ slug: "theme-slug" }) });

    expect(response.status).toBe(202);
    expect((await finishTestLobbyStart(response)).status).toBe("active");
    expect(getDb().prepare("select cube_id from draft_player_cube order by cube_id").all()).toEqual([{ cube_id: 1 }, { cube_id: 2 }]);
  }, 30000);

  it("shows a preflight error for a legacy draft with missing host assignments and returns a clear start error", async () => {
    const { dbPath } = await seedDraft([{ main: 42, extra: 0 }, { main: 42, extra: 0 }], { themeSelection: "host_assigned", extraDeckEnabled: false });
    auth.mockResolvedValue({ user: { id: String(fixtureUserId("u1")), discordUserId: fixtureDiscordId("u1"), name: "P1" } });
    const { GET } = await import("../app/api/drafts/[slug]/preflight/route");
    const preflight = await GET(new Request("http://localhost"), { params: Promise.resolve({ slug: "theme-slug" }) });
    expect(preflight.status).toBe(200);
    expect((await preflight.json()).errors).toContainEqual(expect.stringMatching(/assignment for every player/i));

    const { GET: getDraft, POST } = await import("../app/api/drafts/[slug]/route");
    const lobby = await getDraft(new Request("http://localhost"), { params: Promise.resolve({ slug: "theme-slug" }) });
    expect(lobby.status).toBe(200);
    expect((await lobby.json()).status).toBe("pending");
    const started = await POST(new Request("http://localhost", { method: "POST", body: JSON.stringify({ force: true }) }), { params: Promise.resolve({ slug: "theme-slug" }) });
    expect(started.status).toBe(409);
    expect(await started.json()).toMatchObject({
      code: "PREFLIGHT_FAILED", errors: expect.arrayContaining(["Host-assigned themes require an allowed theme assignment for every player"]),
    });

    const Database = (await import("better-sqlite3")).default;
    const db = new Database(dbPath);
    expect(db.prepare("select status from drafts").get()).toEqual({ status: "pending" });
    expect(db.prepare("select count(*) as n from draft_player_cube").get()).toEqual({ n: 0 });
    db.close();
  }, 30000);

  it("allows a legacy draft to switch back to random selection", async () => {
    await seedDraft([{ main: 42, extra: 0 }, { main: 42, extra: 0 }], { themeSelection: "host_assigned" });
    auth.mockResolvedValue({ user: { id: String(fixtureUserId("u1")), discordUserId: fixtureDiscordId("u1"), name: "P1" } });
    const { PUT } = await import("../app/api/drafts/[slug]/route");
    const response = await PUT(new Request("http://localhost/api/drafts/theme-slug", {
      method: "PUT",
      body: JSON.stringify({ config: { themeSelection: "random" } }),
    }) as NextRequest, { params: Promise.resolve({ slug: "theme-slug" }) });
    expect(response.status).toBe(200);
    expect((await response.json()).config.themeSelection).toBe("random");
  }, 30000);

  it("claims a cube and rejects a second claim of the same cube (uniqueThemes)", async () => {
    const { cubeIds } = await seedDraft([{ main: 42, extra: 0 }, { main: 42, extra: 0 }]);
    const { POST } = await import("../app/api/drafts/[slug]/claim-cube/route");

    auth.mockResolvedValue({ user: { id: String(fixtureUserId("u1")), discordUserId: fixtureDiscordId("u1"), name: "P1" } });
    const res1 = await POST(new Request("http://localhost/api/drafts/theme-slug/claim-cube", { method: "POST", body: JSON.stringify({ cubeId: cubeIds[0] }) }) as any, { params: Promise.resolve({ slug: "theme-slug" }) });
    expect(res1.status).toBe(200);

    auth.mockResolvedValue({ user: { id: String(fixtureUserId("u2")), discordUserId: fixtureDiscordId("u2"), name: "P2" } });
    const res2 = await POST(new Request("http://localhost/api/drafts/theme-slug/claim-cube", { method: "POST", body: JSON.stringify({ cubeId: cubeIds[0] }) }) as any, { params: Promise.resolve({ slug: "theme-slug" }) });
    expect(res2.status).toBe(409);
  }, 30000);

  it.each(["pending", "active"])("preflight returns host-assigned warnings only to the creator when the draft is %s", async (status) => {
    await seedDraft([{ main: 42, extra: 17 }, { main: 42, extra: 0 }], {
      themeSelection: "host_assigned", themeAssignments: { "1": 1, "2": 2 },
    });
    if (status === "active") {
      const { getDb } = await import("@/lib/db");
      const { createDraftService } = await import("@yugidraft/shared/services");
      createDraftService(getDb()).start(1);
    }
    const { GET } = await import("../app/api/drafts/[slug]/preflight/route");
    const params = { params: Promise.resolve({ slug: "theme-slug" }) };
    // u2 joined the draft and can read it, but cannot see host assignment warnings.
    auth.mockResolvedValue({ user: { id: String(fixtureUserId("u2")), discordUserId: fixtureDiscordId("u2") } });
    const participantResponse = await GET(new Request("http://localhost"), params);
    expect(participantResponse.status).toBe(200);
    expect(await participantResponse.json()).toEqual({ errors: [], warnings: [] });
    auth.mockResolvedValue({ user: { id: String(fixtureUserId("observer")), discordUserId: fixtureDiscordId("observer") } });
    expect((await GET(new Request("http://localhost"), params)).status).toBe(status === "pending" ? 200 : 404);
    auth.mockResolvedValue({ user: { id: String(fixtureUserId("u1")), discordUserId: fixtureDiscordId("u1") } });
    const response = await GET(new Request("http://localhost"), params);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      errors: [], warnings: [expect.stringMatching(/^Theme1: Extra pool/i)],
    });
  }, 30000);

  it("preflight hides host assignment validation errors from a non-creator", async () => {
    await seedDraft([{ main: 42, extra: 0 }, { main: 42, extra: 0 }], { themeSelection: "host_assigned" });
    auth.mockResolvedValue({ user: { id: String(fixtureUserId("u2")), discordUserId: fixtureDiscordId("u2") } });
    const { GET } = await import("../app/api/drafts/[slug]/preflight/route");
    const response = await GET(new Request("http://localhost"), { params: Promise.resolve({ slug: "theme-slug" }) });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ errors: [], warnings: [] });
  }, 30000);

  it.each(["player_pick", "random"])("preflight still analyzes every allowed theme for a non-creator in %s mode", async (themeSelection) => {
    await seedDraft([{ main: 5, extra: 17 }, { main: 42, extra: 0 }], { themeSelection });
    auth.mockResolvedValue({ user: { id: String(fixtureUserId("u2")), discordUserId: fixtureDiscordId("u2") } });
    const { GET } = await import("../app/api/drafts/[slug]/preflight/route");
    const response = await GET(new Request("http://localhost"), { params: Promise.resolve({ slug: "theme-slug" }) });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      errors: [expect.stringMatching(/^Theme0: Main pool/i)],
      warnings: [expect.stringMatching(/^Theme1: Extra pool/i)],
    });
  }, 30000);

  it("preflight reports an error for a main-short cube and a warning for a thin-extra cube", async () => {
    await seedDraft([{ main: 5, extra: 0 }, { main: 42, extra: 0 }]);
    auth.mockResolvedValue({ user: { id: String(fixtureUserId("u1")), discordUserId: fixtureDiscordId("u1"), name: "P1" } });
    const { GET } = await import("../app/api/drafts/[slug]/preflight/route");
    const res = await GET(new Request("http://x") as any, { params: Promise.resolve({ slug: "theme-slug" }) });
    const body = await res.json();
    expect(body.errors.length).toBeGreaterThan(0); // Theme0 main-short
    expect(body.errors.some((e: string) => /main/i.test(e))).toBe(true);
    expect(body.warnings.length).toBeGreaterThan(0); // Theme1 has 0 extra but extra enabled
  }, 30000);

  it("does not let a player who has not joined reserve a cube", async () => {
    const { cubeIds } = await seedDraft([{ main: 42, extra: 0 }]);
    const { getDb } = await import("../src/lib/db");
    getDb().prepare(`insert into players (guild_id, user_id, discord_user_id, display_name) values ('guild-1', ${fixtureUserId("outsider")}, '${fixtureDiscordId("outsider")}', 'Other')`).run();
    auth.mockResolvedValue({ user: { id: String(fixtureUserId("outsider")), discordUserId: fixtureDiscordId("outsider") } });
    const { POST } = await import("../app/api/drafts/[slug]/claim-cube/route");
    const res = await POST(new Request("http://x", { method: "POST", body: JSON.stringify({ cubeId: cubeIds[0] }) }), {
      params: Promise.resolve({ slug: "theme-slug" }),
    });
    expect(res.status).toBe(403);
    expect(getDb().prepare("select count(*) as n from draft_player_cube").get()).toEqual({ n: 0 });
  }, 30000);

  describe.each(["random", "player_pick"])("deleted attachments (%s)", (themeSelection) => {
    it.each(["timer-only", "config round-trip"])("allows a %s edit", async (edit) => {
      const { cubeIds } = await seedDraft([{ main: 42, extra: 0 }, { main: 42, extra: 0 }], {
        themeSelection, extraDeckEnabled: false,
      });
      const { getDb } = await import("../src/lib/db");
      const { createCubeService, createCardCatalogService } = await import("@yugidraft/shared/services");
      const db = getDb();
      seedFixtureUsers(db, FIXTURE_KEYS);
      createCubeService(db, createCardCatalogService(db)).deleteCube(cubeIds[0]);
      auth.mockResolvedValue({ user: { id: String(fixtureUserId("u1")), discordUserId: fixtureDiscordId("u1"), name: "P1" } });
      const { GET, PUT } = await import("../app/api/drafts/[slug]/route");
      const context = { params: Promise.resolve({ slug: "theme-slug" }) };
      const current = await (await GET(new Request("http://x"), context)).json();
      expect(current.config.allowedCubeIds).toEqual(cubeIds);
      expect(current.allowedCubes.map((cube: { id: number }) => cube.id)).toEqual([cubeIds[1]]);
      const body = { config: { ...(edit === "config round-trip" ? current.config : {}), pickSeconds: 60 } };

      const response = await PUT(new Request("http://x", {
        method: "PUT", body: JSON.stringify(body),
      }) as NextRequest, context);

      expect(response.status).toBe(200);
      const updated = await response.json();
      expect(updated.config.allowedCubeIds).toEqual(cubeIds);
      expect(updated.config.themeSelection).toBe(themeSelection);
      expect(updated.config.pickSeconds).toBe(60);
      expect(updated.name).toBe("Theme Night");
      const stored = db.prepare("select name, config_json, status from drafts where id = 1").get() as {
        name: string; config_json: string; status: string;
      };
      expect(stored.name).toBe(updated.name);
      expect(JSON.parse(stored.config_json)).toEqual(updated.config);
      expect(stored.status).toBe("pending");
    }, 30000);

    it("preflight skips deleted attachments", async () => {
      const { cubeIds } = await seedDraft([{ main: 42, extra: 0 }, { main: 42, extra: 0 }], {
        themeSelection, extraDeckEnabled: false,
      });
      const { getDb } = await import("../src/lib/db");
      const { createCubeService, createCardCatalogService } = await import("@yugidraft/shared/services");
      const db = getDb();
      seedFixtureUsers(db, FIXTURE_KEYS);
      createCubeService(db, createCardCatalogService(db)).deleteCube(cubeIds[0]);
      auth.mockResolvedValue({ user: { id: String(fixtureUserId("u1")), discordUserId: fixtureDiscordId("u1"), name: "P1" } });
      const { GET } = await import("../app/api/drafts/[slug]/preflight/route");
      const response = await GET(new Request("http://x"), { params: Promise.resolve({ slug: "theme-slug" }) });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ errors: [], warnings: [] });
    }, 30000);

    it("starts using surviving cubes after an attachment is deleted", async () => {
      const { cubeIds } = await seedDraft([
        { main: 42, extra: 0 }, { main: 42, extra: 0 }, { main: 42, extra: 0 },
      ], { themeSelection, extraDeckEnabled: false });
      const { getDb } = await import("../src/lib/db");
      const { createCubeService, createCardCatalogService } = await import("@yugidraft/shared/services");
      const db = getDb();
      seedFixtureUsers(db, FIXTURE_KEYS);
      createCubeService(db, createCardCatalogService(db)).deleteCube(cubeIds[0]);
      auth.mockResolvedValue({ user: { id: String(fixtureUserId("u1")), discordUserId: fixtureDiscordId("u1"), name: "P1" } });
      const { POST } = await import("../app/api/drafts/[slug]/route");
      const response = await POST(new Request("http://x", { method: "POST", body: JSON.stringify({ force: true }) }), {
        params: Promise.resolve({ slug: "theme-slug" }),
      });
      expect(response.status).toBe(202);
      await finishTestLobbyStart(response, db);
      expect(db.prepare("select status from drafts where id = 1").get()).toEqual({ status: "active" });
      expect(db.prepare("select cube_id from draft_player_cube where draft_id = 1 order by cube_id").all())
        .toEqual([{ cube_id: cubeIds[1] }, { cube_id: cubeIds[2] }]);
    }, 30000);
  });

  describe.each(["random", "player_pick"])("attachments moved to another guild (%s)", (themeSelection) => {
    it.each(["timer-only", "config round-trip"])("rejects a %s edit before changing the draft", async (edit) => {
      const { cubeIds } = await seedDraft([{ main: 42, extra: 0 }, { main: 42, extra: 0 }], {
        themeSelection, extraDeckEnabled: false,
      });
      const { getDb } = await import("../src/lib/db");
      const db = getDb();
      seedFixtureUsers(db, FIXTURE_KEYS);
      db.prepare("update cubes set guild_id = 'other-guild' where id = ?").run(cubeIds[0]);
      const before = db.prepare("select name, config_json from drafts where id = 1").get();
      auth.mockResolvedValue({ user: { id: String(fixtureUserId("u1")), discordUserId: fixtureDiscordId("u1"), name: "P1" } });
      const { PUT } = await import("../app/api/drafts/[slug]/route");
      const response = await PUT(new Request("http://x", {
        method: "PUT", body: JSON.stringify({ name: "Renamed", config: {
          pickSeconds: 60, ...(edit === "config round-trip" ? { allowedCubeIds: cubeIds } : {}),
        } }),
      }) as NextRequest, { params: Promise.resolve({ slug: "theme-slug" }) });
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "Cube not found" });
      expect(db.prepare("select name, config_json from drafts where id = 1").get()).toEqual(before);
    }, 30000);

    it("rejects start before dealing cards", async () => {
      const { cubeIds } = await seedDraft([{ main: 42, extra: 0 }, { main: 42, extra: 0 }], {
        themeSelection, extraDeckEnabled: false,
      });
      const { getDb } = await import("../src/lib/db");
      const db = getDb();
      seedFixtureUsers(db, FIXTURE_KEYS);
      db.prepare("update cubes set guild_id = 'other-guild' where id = ?").run(cubeIds[0]);
      auth.mockResolvedValue({ user: { id: String(fixtureUserId("u1")), discordUserId: fixtureDiscordId("u1"), name: "P1" } });
      const { POST } = await import("../app/api/drafts/[slug]/route");
      const response = await POST(new Request("http://x", { method: "POST", body: JSON.stringify({ force: true }) }), {
        params: Promise.resolve({ slug: "theme-slug" }),
      });
      expect(response.status).toBe(404);
      expect(db.prepare("select status from drafts where id = 1").get()).toEqual({ status: "pending" });
      expect(db.prepare("select count(*) as n from draft_cards").get()).toEqual({ n: 0 });
    }, 30000);
  });

  it("allows claiming a surviving cube but rejects claiming the deleted attachment", async () => {
    const { cubeIds, p1 } = await seedDraft([{ main: 42, extra: 0 }, { main: 42, extra: 0 }]);
    const { getDb } = await import("../src/lib/db");
    const { createCubeService, createCardCatalogService } = await import("@yugidraft/shared/services");
    const db = getDb();
    seedFixtureUsers(db, FIXTURE_KEYS);
    createCubeService(db, createCardCatalogService(db)).deleteCube(cubeIds[0]);
    auth.mockResolvedValue({ user: { id: String(fixtureUserId("u1")), discordUserId: fixtureDiscordId("u1"), name: "P1" } });
    const { POST } = await import("../app/api/drafts/[slug]/claim-cube/route");
    const context = { params: Promise.resolve({ slug: "theme-slug" }) };
    const claim = (cubeId: number) => POST(new Request("http://x", {
      method: "POST", body: JSON.stringify({ cubeId }),
    }), context);
    expect((await claim(cubeIds[1])).status).toBe(200);
    expect((await claim(cubeIds[0])).status).toBe(404);
    expect(db.prepare("select cube_id from draft_player_cube where draft_id = 1 and player_id = ?").get(p1))
      .toEqual({ cube_id: cubeIds[1] });
  }, 30000);

  it("creation still rejects a deleted cube ID", async () => {
    vi.stubEnv("THEME_DRAFTS", "1");
    const { cubeIds } = await seedDraft([{ main: 42, extra: 0 }]);
    const { getDb } = await import("../src/lib/db");
    const { createCubeService, createCardCatalogService } = await import("@yugidraft/shared/services");
    const db = getDb();
    seedFixtureUsers(db, FIXTURE_KEYS);
    createCubeService(db, createCardCatalogService(db)).deleteCube(cubeIds[0]);
    auth.mockResolvedValue({ user: { id: String(fixtureUserId("u1")), discordUserId: fixtureDiscordId("u1"), name: "P1" } });
    const { POST } = await import("../app/api/drafts/route");
    const response = await POST(new Request("http://x", {
      method: "POST", body: JSON.stringify({ name: "New Draft", channelId: "c", config: {
        mode: "theme", allowedCubeIds: cubeIds,
      } }),
    }) as NextRequest);
    expect(response.status).toBe(404);
    expect(db.prepare("select count(*) as n from drafts").get()).toEqual({ n: 1 });
  }, 30000);

  it.each(["foreign", "unallowed-local"])("rejects a poisoned %s player claim before start", async (kind) => {
    const { cubeIds, p1, p2 } = await seedDraft([{ main: 42, extra: 0 }, { main: 42, extra: 0 }], { extraDeckEnabled: false });
    const { getDb } = await import("../src/lib/db");
    const db = getDb();
    seedFixtureUsers(db, FIXTURE_KEYS);
    const poisonedId = Number(db.prepare(`insert into cubes (guild_id, name, created_by_user_id) values (?, 'Poisoned', ${fixtureUserId("u1")})`).run(kind === "foreign" ? "other-guild" : "guild-1").lastInsertRowid);
    db.prepare("insert into cube_cards (cube_id, catalog_card_id, pool, max_copies) select ?, catalog_card_id, pool, max_copies from cube_cards where cube_id = ?").run(poisonedId, cubeIds[0]);
    db.prepare("insert into draft_player_cube (draft_id, player_id, cube_id) values (1, ?, ?), (1, ?, ?)").run(p1, poisonedId, p2, cubeIds[1]);
    auth.mockResolvedValue({ user: { id: String(fixtureUserId("u1")), discordUserId: fixtureDiscordId("u1"), name: "P1" } });
    const { POST } = await import("../app/api/drafts/[slug]/route");
    const response = await POST(new Request("http://x", { method: "POST", body: JSON.stringify({ force: true }) }), { params: Promise.resolve({ slug: "theme-slug" }) });
    expect(response.status).toBe(kind === "foreign" ? 404 : 400);
    expect(db.prepare("select status from drafts where id = 1").get()).toEqual({ status: "pending" });
    expect(db.prepare("select count(*) as n from draft_cards").get()).toEqual({ n: 0 });
  }, 30000);

});

const FIXTURE_KEYS = ["u1", "u2", "u", "u3", "observer", "outsider"] as const;

// Session resolution is mocked; authorization still runs through the real web boundary.
