import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.fn();
const tempDirs: string[] = [];
vi.mock("@/lib/auth", () => ({ auth }));

async function setup(configJson: string) {
  const tempDir = mkdtempSync(join(tmpdir(), "yugioh-drafts-pool-"));
  const dbPath = join(tempDir, "test.sqlite");
  tempDirs.push(tempDir);
  process.env.DATABASE_PATH = dbPath;
  process.env.DISCORD_GUILD_ID = "guild-1";
  const Database = (await import("better-sqlite3")).default;
  const { migrate } = await import("@yugidraft/shared/db");
  const db = new Database(dbPath);
  migrate(db);
  db.prepare(
    `insert into card_catalog (ygoprodeck_id, name, type, frame_type, effect_text, atk, def, attribute, level, image_url, image_url_small, card_sets_json, cached_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(46986414, "Dark Magician", "Spellcaster / Normal Monster", "normal", "x", 2500, 2100, "DARK", 7, "u1", "s1", JSON.stringify([{ set_name: "Metal Raiders" }]), new Date().toISOString());
  db.prepare(
    `insert into drafts (guild_id, channel_id, name, status, created_by_user_id, config_json, web_slug)
     values ('guild-1', 'ch1', 'D', 'pending', 'u', ?, 'slug-1')`,
  ).run(configJson);
  db.close();
}

describe("GET /api/drafts/[slug]/pool", () => {
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

  function req() { return new Request("http://localhost/api/drafts/slug-1/pool"); }
  function params() { return { params: Promise.resolve({ slug: "slug-1" }) }; }

  it("401 unauthenticated", async () => {
    await setup(JSON.stringify({ poolCardIds: [46986414] }));
    auth.mockResolvedValue(null);
    const { GET } = await import("../app/api/drafts/[slug]/pool/route");
    expect((await GET(req(), params())).status).toBe(401);
  });

  it("404 for unknown slug", async () => {
    await setup(JSON.stringify({ poolCardIds: [46986414] }));
    const { GET } = await import("../app/api/drafts/[slug]/pool/route");
    const res = await GET(new Request("http://localhost/api/drafts/nope/pool"), { params: Promise.resolve({ slug: "nope" }) });
    expect(res.status).toBe(404);
  });

  it("returns cards from poolCardIds", async () => {
    await setup(JSON.stringify({ poolCardIds: [46986414] }));
    const { GET } = await import("../app/api/drafts/[slug]/pool/route");
    const res = await GET(req(), params());
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.cards.map((c: { id: number }) => c.id)).toEqual([46986414]);
    expect(json.cards[0]).toMatchObject({ name: "Dark Magician", imageUrl: "u1" });
  });

  it("falls back to resolvePoolCardIds when poolCardIds absent", async () => {
    await setup(JSON.stringify({ setNames: ["Metal Raiders"] }));
    const { GET } = await import("../app/api/drafts/[slug]/pool/route");
    const json = await (await GET(req(), params())).json();
    expect(json.cards.map((c: { id: number }) => c.id)).toEqual([46986414]);
  });

  it("returns empty array for an unresolvable pool", async () => {
    await setup(JSON.stringify({ setNames: ["Nonexistent Set"] }));
    const { GET } = await import("../app/api/drafts/[slug]/pool/route");
    const json = await (await GET(req(), params())).json();
    expect(json.cards).toEqual([]);
  });
});
