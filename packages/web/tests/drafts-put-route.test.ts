import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.fn();
const tempDirs: string[] = [];

vi.mock("@/lib/auth", () => ({ auth }));

// Prevent syncDraftPool from making real network calls — the route calls it to
// refresh the catalog but our test data is already in the DB.
vi.mock("@yugidraft/shared/services", async (importOriginal) => {
  const original = await importOriginal<typeof import("@yugidraft/shared/services")>();
  return {
    ...original,
    createCardCatalogService: (db: any) => ({
      ...original.createCardCatalogService(db),
      syncDraftPool: vi.fn().mockResolvedValue([]),
    }),
  };
});

describe("PUT /api/drafts/[slug]", () => {
  beforeEach(() => {
    vi.resetModules();
    auth.mockReset();
    auth.mockResolvedValue({ user: { id: "creator-user", name: "Yugi" } });
  });

  afterEach(() => {
    delete process.env.DATABASE_PATH;
    delete process.env.DISCORD_GUILD_ID;
    delete process.env.DISCORD_DEFAULT_CHANNEL_ID;
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  async function setupDraftWithCustomPool() {
    const tempDir = mkdtempSync(join(tmpdir(), "yugioh-put-route-"));
    const dbPath = join(tempDir, "test.sqlite");
    tempDirs.push(tempDir);
    process.env.DATABASE_PATH = dbPath;
    process.env.DISCORD_GUILD_ID = "guild-1";
    process.env.DISCORD_DEFAULT_CHANNEL_ID = "channel-1";

    const Database = (await import("better-sqlite3")).default;
    const { migrate } = await import("@yugidraft/shared/db");
    const db = new Database(dbPath);
    migrate(db);

    // Seed catalog cards (enough distinct to pass the create/edit feasibility check)
    for (let i = 1; i <= 30; i++) {
      db.prepare(
        `insert into card_catalog (ygoprodeck_id, name, type, frame_type, image_url, image_url_small, card_sets_json, cached_at)
         values (?, ?, 'Effect Monster', 'effect', '', '', '[]', current_timestamp)`,
      ).run(i, `Card ${i}`);
    }

    db.prepare("insert into players (guild_id, discord_user_id, display_name) values ('guild-1', 'creator-user', 'Yugi')").run();
    const playerRow = db.prepare("select id from players where discord_user_id = 'creator-user'").get() as { id: number };

    const customCardIds = Array.from({ length: 30 }, (_, i) => i + 1);
    db.prepare(
      `insert into drafts (guild_id, channel_id, name, status, created_by_user_id, config_json, web_slug)
       values ('guild-1', 'channel-1', 'My Draft', 'pending', 'creator-user', ?, 'test-slug')`,
    ).run(JSON.stringify({
      customCardIds,
      setNames: [],
      packsPerPlayer: 5,
      packSize: 8,
      pickSeconds: 45,
      poolCardIds: customCardIds,
    }));
    db.prepare("insert into draft_players (draft_id, player_id) values (1, ?)").run(playerRow.id);
    db.close();

    return dbPath;
  }

  it("merges config without dropping customCardIds when only numeric fields sent", async () => {
    await setupDraftWithCustomPool();
    const { PUT } = await import("../app/api/drafts/[slug]/route");
    const request = new Request("http://localhost/api/drafts/test-slug", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ config: { packsPerPlayer: 3 } }),
    }) as NextRequest;

    const response = await PUT(request, { params: Promise.resolve({ slug: "test-slug" }) });
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.config.customCardIds).toEqual(Array.from({ length: 30 }, (_, i) => i + 1));
    expect(data.config.packsPerPlayer).toBe(3);
    expect(data.config.packSize).toBe(14); // ceil(40/3)
  });

  it("recomputes the pool from the new selection instead of reusing the stale snapshot", async () => {
    await setupDraftWithCustomPool(); // seeded with poolCardIds = [1..30]
    const { PUT } = await import("../app/api/drafts/[slug]/route");
    const reduced = Array.from({ length: 20 }, (_, i) => i + 1);
    const request = new Request("http://localhost/api/drafts/test-slug", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ config: { setNames: [], customCardIds: reduced } }),
    }) as NextRequest;

    const response = await PUT(request, { params: Promise.resolve({ slug: "test-slug" }) });
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.config.customCardIds).toEqual(reduced);
    // Materialized cube reflects the reduced selection, not the stale 30-card snapshot.
    expect(data.config.cubeCardIds).toEqual(reduced);
    expect(data.config.poolCardIds).toBeUndefined();
  });

  it("allows editing when 0 sets but customCardIds are present", async () => {
    await setupDraftWithCustomPool();
    const { PUT } = await import("../app/api/drafts/[slug]/route");
    // packsPerPlayer defaults to 5 => packSize 8 => 2 players need 16 distinct.
    const customCardIds = Array.from({ length: 16 }, (_, i) => i + 1);
    const request = new Request("http://localhost/api/drafts/test-slug", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ config: { setNames: [], customCardIds, pickSeconds: 60 } }),
    }) as NextRequest;

    const response = await PUT(request, { params: Promise.resolve({ slug: "test-slug" }) });
    expect(response.status).toBe(200);
  });

  it("rejects when merged config has no pool", async () => {
    await setupDraftWithCustomPool();
    const { PUT } = await import("../app/api/drafts/[slug]/route");
    const request = new Request("http://localhost/api/drafts/test-slug", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ config: { setNames: [], customCardIds: [] } }),
    }) as NextRequest;

    const response = await PUT(request, { params: Promise.resolve({ slug: "test-slug" }) });
    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toMatch(/at least one set/i);
  });
});
