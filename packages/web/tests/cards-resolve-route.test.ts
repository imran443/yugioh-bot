// packages/web/tests/cards-resolve-route.test.ts
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.fn();
const tempDirs: string[] = [];
vi.mock("@/lib/auth", () => ({ auth }));

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
  });
});
