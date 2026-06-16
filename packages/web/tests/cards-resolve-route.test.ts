// packages/web/tests/cards-resolve-route.test.ts
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.fn();
const tempDirs: string[] = [];
vi.mock("@/lib/auth", () => ({ auth }));

const syncDraftPool = vi.fn();
const syncCardByName = vi.fn();
const syncCardsByFuzzyName = vi.fn();

vi.mock("@yugidraft/shared/services", async (importOriginal) => {
  const original = await importOriginal<typeof import("@yugidraft/shared/services")>();
  return {
    ...original,
    createCardCatalogService: (db: any) => ({
      ...original.createCardCatalogService(db),
      syncDraftPool,
      syncCardByName,
      syncCardsByFuzzyName,
    }),
  };
});

async function setupDb() {
  const tempDir = mkdtempSync(join(tmpdir(), "yugioh-cards-resolve-"));
  const dbPath = join(tempDir, "test.sqlite");
  tempDirs.push(tempDir);
  process.env.DATABASE_PATH = dbPath;
  process.env.DISCORD_GUILD_ID = "guild-1";
  const Database = (await import("better-sqlite3")).default;
  const { migrate } = await import("@yugidraft/shared/db");
  const db = new Database(dbPath);
  migrate(db);
  // two catalog cards: one in "Metal Raiders", one not in any set
  db.prepare(
    `insert into card_catalog (ygoprodeck_id, name, type, frame_type, effect_text, atk, def, attribute, level, image_url, image_url_small, card_sets_json, cached_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(46986414, "Dark Magician", "Spellcaster / Normal Monster", "normal", "The ultimate wizard.", 2500, 2100, "DARK", 7, "u1", "s1", JSON.stringify([{ set_name: "Metal Raiders" }]), new Date().toISOString());
  db.prepare(
    `insert into card_catalog (ygoprodeck_id, name, type, frame_type, effect_text, atk, def, attribute, level, image_url, image_url_small, card_sets_json, cached_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(83764718, "Monster Reborn", "Spell Card", "spell", "Target 1 monster...", null, null, null, null, "u2", "s2", JSON.stringify([]), new Date().toISOString());
  db.close();
}

describe("POST /api/cards/resolve", () => {
  beforeEach(() => {
    vi.resetModules();
    auth.mockReset();
    auth.mockResolvedValue({ user: { id: "u", name: "Yugi" } });
    syncDraftPool.mockReset();
    syncDraftPool.mockResolvedValue([]);
    syncCardByName.mockReset();
    syncCardByName.mockResolvedValue(undefined);
    syncCardsByFuzzyName.mockReset();
    syncCardsByFuzzyName.mockResolvedValue([]);
  });
  afterEach(() => {
    delete process.env.DATABASE_PATH;
    delete process.env.DISCORD_GUILD_ID;
    while (tempDirs.length) { const d = tempDirs.pop(); if (d) rmSync(d, { recursive: true, force: true }); }
  });

  it("401 when unauthenticated", async () => {
    await setupDb();
    auth.mockResolvedValue(null);
    const { POST } = await import("../app/api/cards/resolve/route");
    const res = await POST(new Request("http://localhost/api/cards/resolve", { method: "POST", body: JSON.stringify({}) }));
    expect(res.status).toBe(401);
  });

  it("resolves set names and custom ids, dedupes, returns unknownIds", async () => {
    await setupDb();
    const { POST } = await import("../app/api/cards/resolve/route");
    const res = await POST(new Request("http://localhost/api/cards/resolve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ setNames: ["Metal Raiders"], customCardIds: [83764718, 46986414, 99999999] }),
    }));
    expect(res.status).toBe(200);
    const json = await res.json();
    const ids = json.cards.map((c: { id: number }) => c.id).sort((a: number, b: number) => a - b);
    expect(ids).toEqual([46986414, 83764718]);
    expect(json.unknownIds).toEqual([99999999]);
    const dm = json.cards.find((c: { id: number }) => c.id === 46986414);
    expect(dm).toMatchObject({ name: "Dark Magician", type: "Spellcaster / Normal Monster", frameType: "normal", imageUrl: "u1", imageUrlSmall: "s1" });
    expect(syncDraftPool).toHaveBeenCalledWith({
      setNames: ["Metal Raiders"],
      customCardIds: [83764718, 46986414, 99999999],
      includeNames: [],
      excludeNames: [],
    });
  });

  it("resolves one exact card name", async () => {
    await setupDb();
    syncCardByName.mockResolvedValue({
      ygoprodeckId: 83764718,
      name: "Monster Reborn",
      type: "Spell Card",
      frameType: "spell",
      effectText: "Target 1 monster...",
      atk: undefined,
      def: undefined,
      attribute: undefined,
      level: undefined,
      imageUrl: "u2",
      imageUrlSmall: "s2",
    });
    const { POST } = await import("../app/api/cards/resolve/route");

    const res = await POST(new Request("http://localhost/api/cards/resolve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cardName: "  Monster Reborn  " }),
    }));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      cards: [expect.objectContaining({ id: 83764718, name: "Monster Reborn", imageUrl: "u2", imageUrlSmall: "s2" })],
      unknownIds: [],
    });
    expect(syncCardByName).toHaveBeenCalledWith("Monster Reborn");
    expect(syncDraftPool).not.toHaveBeenCalled();
  });

  it("returns 404 when exact card name is not found", async () => {
    await setupDb();
    const { POST } = await import("../app/api/cards/resolve/route");

    const res = await POST(new Request("http://localhost/api/cards/resolve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cardName: "Pot of Greeddd" }),
    }));

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: "No card found for \"Pot of Greeddd\"." });
    expect(syncCardByName).toHaveBeenCalledWith("Pot of Greeddd");
  });

  it("resolves fuzzy name search", async () => {
    await setupDb();
    syncCardsByFuzzyName.mockResolvedValue([
      {
        ygoprodeckId: 89631139,
        name: "Blue-Eyes White Dragon",
        type: "Dragon / Normal Monster",
        frameType: "normal",
        effectText: "",
        atk: 3000,
        def: 2500,
        attribute: "LIGHT",
        level: 8,
        imageUrl: "u3",
        imageUrlSmall: "s3",
      },
    ]);
    const { POST } = await import("../app/api/cards/resolve/route");

    const res = await POST(new Request("http://localhost/api/cards/resolve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fuzzyName: "  blue-eyes  " }),
    }));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      cards: [expect.objectContaining({ id: 89631139, name: "Blue-Eyes White Dragon" })],
      unknownIds: [],
    });
    expect(syncCardsByFuzzyName).toHaveBeenCalledWith("blue-eyes");
    expect(syncDraftPool).not.toHaveBeenCalled();
    expect(syncCardByName).not.toHaveBeenCalled();
  });
});
