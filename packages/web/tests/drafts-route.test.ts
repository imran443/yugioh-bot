import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.fn();
const repoRoot = "/home/imran/yugioh-discord-bot";
const tempDirs: string[] = [];
const testTimeoutMs = 40000;

vi.mock("@/lib/auth", () => ({
  auth,
}));

describe("GET /api/drafts/[slug]", () => {
  beforeEach(() => {
    vi.resetModules();
    auth.mockReset();
    auth.mockResolvedValue({
      user: { id: "196382527131222016", name: "imran443" },
    });
  });

  afterEach(() => {
    delete process.env.DATABASE_PATH;
    delete process.env.DISCORD_GUILD_ID;
    delete process.env.DISCORD_DEFAULT_CHANNEL_ID;
    vi.unstubAllGlobals();

    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it("returns initial active draft-room state for the seeded legendary draft", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "yugioh-draft-route-"));
    const dbPath = join(tempDir, "draft-route.sqlite");

    tempDirs.push(tempDir);

    execFileSync(process.execPath, ["--import", "tsx", "scripts/seed.ts"], {
      cwd: repoRoot,
      env: {
        ...process.env,
        DATABASE_PATH: dbPath,
        DISCORD_USER_ID: "196382527131222016",
        DISCORD_GUILD_ID: "196382772699332609",
      },
      stdio: "pipe",
    });

    process.env.DATABASE_PATH = dbPath;
    process.env.DISCORD_GUILD_ID = "196382772699332609";

    const { GET } = await import("../app/api/drafts/[slug]/route");

    const response = await GET(new Request("http://localhost/api/drafts/legendary-draft"), {
      params: Promise.resolve({ slug: "legendary-draft" }),
    });

    expect(response.status).toBe(200);

    const payload = await response.json();

    expect(payload.status).toBe("pending");
    expect(payload.config.setNames).toBeDefined();
    expect(Array.isArray(payload.config.setNames)).toBe(true);
    expect(payload.config.setNames.length).toBeGreaterThan(0);
    expect(payload.players).toBeDefined();
    expect(Array.isArray(payload.players)).toBe(true);
    expect(payload.players.length).toBeGreaterThan(0);
    expect(payload.pickSeconds).toBeGreaterThan(0);
  }, testTimeoutMs);

  it("prefers the current guild draft for the requested slug", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "yugioh-draft-route-"));
    const dbPath = join(tempDir, "draft-route.sqlite");

    tempDirs.push(tempDir);

    execFileSync(process.execPath, ["--import", "tsx", "scripts/seed.ts"], {
      cwd: repoRoot,
      env: {
        ...process.env,
        DATABASE_PATH: dbPath,
        DISCORD_USER_ID: "111111111111111111",
        DISCORD_GUILD_ID: "987654321098765432",
      },
      stdio: "pipe",
    });

    const Database = (await import("better-sqlite3")).default;
    const db = new Database(dbPath);


    db.prepare(
      "update drafts set status = 'active', current_wave_number = 1, current_pick_step = 1, started_at = datetime('now') where web_slug = ? and guild_id = ?"
    ).run("legendary-draft", "987654321098765432");
    db.prepare("update drafts set web_slug = 'other-' || web_slug where guild_id = ?").run("987654321098765432");
    db.prepare("update tournaments set web_slug = 'other-' || web_slug where guild_id = ?").run("987654321098765432");

    execFileSync(process.execPath, ["--import", "tsx", "scripts/seed.ts"], {
      cwd: repoRoot,
      env: {
        ...process.env,
        DATABASE_PATH: dbPath,
        DISCORD_USER_ID: "196382527131222016",
        DISCORD_GUILD_ID: "196382772699332609",
      },
      stdio: "pipe",
    });

    process.env.DATABASE_PATH = dbPath;
    process.env.DISCORD_GUILD_ID = "196382772699332609";

    const { GET } = await import("../app/api/drafts/[slug]/route");

    const response = await GET(new Request("http://localhost/api/drafts/legendary-draft"), {
      params: Promise.resolve({ slug: "legendary-draft" }),
    });

    expect(response.status).toBe(200);

    const payload = await response.json();

    expect(payload.guildId).toBe("196382772699332609");
    expect(payload.status).toBe("pending");
    expect(payload.currentPack.length).toBe(0);
  }, testTimeoutMs);

  it("returns active draft cards with complete metadata", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "yugioh-draft-route-"));
    const dbPath = join(tempDir, "draft-route.sqlite");

    tempDirs.push(tempDir);

    execFileSync(process.execPath, ["--import", "tsx", "scripts/seed.ts"], {
      cwd: repoRoot,
      env: {
        ...process.env,
        DATABASE_PATH: dbPath,
        DISCORD_USER_ID: "196382527131222016",
        DISCORD_GUILD_ID: "196382772699332609",
      },
      stdio: "pipe",
    });

    process.env.DATABASE_PATH = dbPath;
    process.env.DISCORD_GUILD_ID = "196382772699332609";

    const Database = (await import("better-sqlite3")).default;
    const db = new Database(dbPath);

    const { POST: startDraft, GET } = await import("../app/api/drafts/[slug]/route");

    const startResponse = await startDraft(new Request("http://localhost/api/drafts/legendary-draft", { method: "POST" }), {
      params: Promise.resolve({ slug: "legendary-draft" }),
    });

    expect(startResponse.status).toBe(200);

    const response = await GET(new Request("http://localhost/api/drafts/legendary-draft"), {
      params: Promise.resolve({ slug: "legendary-draft" }),
    });

    expect(response.status).toBe(200);

    const payload = await response.json();

    expect(payload.status).toBe("active");
    expect(payload.currentPack.length).toBeGreaterThan(0);
    expect(
      payload.currentPack.every(
        (card: { name: string; imageUrl: string; imageUrlSmall: string; effectText: string }) =>
          card.name.length > 0 &&
          card.imageUrl.length > 0 &&
          card.imageUrlSmall.length > 0 &&
          card.effectText.length > 0
      )
    ).toBe(true);
  }, testTimeoutMs);

  it("syncs the selected set before starting a draft from the web route", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "yugioh-draft-route-"));
    const dbPath = join(tempDir, "draft-route.sqlite");
    const guildId = "196382772699332609";
    const creatorUserId = "196382527131222016";

    tempDirs.push(tempDir);
    process.env.DATABASE_PATH = dbPath;
    process.env.DISCORD_GUILD_ID = guildId;
    process.env.DISCORD_DEFAULT_CHANNEL_ID = "channel-1";

    const Database = (await import("better-sqlite3")).default;
    const { migrate } = await import("@yugidraft/shared/db");
    const { createDraftService, createPlayerService } = await import("@yugidraft/shared/services");
    const db = new Database(dbPath);
    migrate(db);
    const players = createPlayerService(db);
    const creator = players.findOrCreate(guildId, creatorUserId, "imran443");
    const opponent = players.findOrCreate(guildId, "opponent-user", "Kaiba");
    const drafts = createDraftService(db);
    const draft = drafts.create(
      guildId,
      "channel-1",
      "uncached metal draft",
      { setNames: ["Metal Raiders"], packSize: 1, packsPerPlayer: 1 },
      creatorUserId,
      creator.id,
    );
    drafts.join(draft.id, opponent.id);
    db.close();

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = new URL(String(input));
        expect(url.searchParams.get("cardset")).toBe("Metal Raiders");
        return {
          ok: true,
          async json() {
            return {
              data: [
                {
                  id: 70781052,
                  name: "Summoned Skull",
                  type: "Fiend / Normal Monster",
                  frameType: "normal",
                  desc: "A fiend with dark powers for confusing the enemy.",
                  card_images: [{ image_url: "https://img/full/summoned-skull", image_url_small: "https://img/small/summoned-skull" }],
                  card_sets: [{ set_name: "Metal Raiders" }],
                },
                {
                  id: 89631139,
                  name: "Blue-Eyes White Dragon",
                  type: "Dragon / Normal Monster",
                  frameType: "normal",
                  desc: "The ultimate Dragon warrior.",
                  card_images: [{ image_url: "https://img/full/bewd", image_url_small: "https://img/small/bewd" }],
                  card_sets: [{ set_name: "Metal Raiders" }],
                },
              ],
            };
          },
        };
      }),
    );

    const { POST: startDraft } = await import("../app/api/drafts/[slug]/route");
    const response = await startDraft(new Request(`http://localhost/api/drafts/${draft.webSlug}`, { method: "POST" }), {
      params: Promise.resolve({ slug: draft.webSlug ?? "" }),
    });

    expect(response.status).toBe(200);

    const verifyDb = new Database(dbPath);
    expect(verifyDb.prepare("select count(*) as count from card_catalog").get()).toEqual({ count: 2 });
    expect(verifyDb.prepare("select count(*) as count from draft_cards where draft_id = ?").get(draft.id)).toEqual({ count: 2 });
    verifyDb.close();
  }, testTimeoutMs);

  it("create returns analyzeCube warnings when a card exceeds the wave count", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "yugioh-draft-route-"));
    const dbPath = join(tempDir, "draft-route.sqlite");
    const guildId = "196382772699332609";
    const creatorUserId = "196382527131222016";

    tempDirs.push(tempDir);
    process.env.DATABASE_PATH = dbPath;
    process.env.DISCORD_GUILD_ID = guildId;
    process.env.DISCORD_DEFAULT_CHANNEL_ID = "channel-1";

    // card 1 has 5 copies > 3 waves; plus cards 2..19 for 19 distinct total.
    const range = (start: number, end: number) =>
      Array.from({ length: end - start }, (_, i) => start + i);
    const customCardIds = [1, 1, 1, 1, 1, ...range(2, 20)];
    const distinctIds = [...new Set(customCardIds)];

    const Database = (await import("better-sqlite3")).default;
    const { migrate } = await import("@yugidraft/shared/db");
    const db = new Database(dbPath);
    migrate(db);
    const ins = db.prepare(
      `insert into card_catalog (ygoprodeck_id, name, type, frame_type, image_url, image_url_small, card_sets_json, cached_at)
       values (?, ?, 'Spellcaster / Normal Monster', 'normal', '', '', '[]', '2026-01-01T00:00:00Z')`,
    );
    for (const id of distinctIds) ins.run(id, `Card ${id}`);
    db.close();

    // syncDraftPool is called by the route; the cards already exist so the fetch
    // (if any) returns the same data.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        async json() {
          return {
            data: distinctIds.map((id) => ({
              id,
              name: `Card ${id}`,
              type: "Spellcaster / Normal Monster",
              frameType: "normal",
              desc: "x",
              card_images: [{ image_url: "u", image_url_small: "s" }],
              card_sets: [],
            })),
          };
        },
      })),
    );

    const { POST } = await import("../app/api/drafts/route");
    const res = await POST(
      new Request("http://localhost/api/drafts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "warns draft",
          channelId: "channel-1",
          config: { customCardIds, packSize: 4, packsPerPlayer: 3 },
        }),
      }) as any,
    );

    const body = await res.json();
    expect(res.status).toBe(201);
    expect(body.warnings.join(" ")).toMatch(/card 1/i);
  }, testTimeoutMs);

  it("syncs custom card ids before starting a custom pool draft from the web route", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "yugioh-draft-route-"));
    const dbPath = join(tempDir, "draft-route.sqlite");
    const guildId = "196382772699332609";
    const creatorUserId = "196382527131222016";

    tempDirs.push(tempDir);
    process.env.DATABASE_PATH = dbPath;
    process.env.DISCORD_GUILD_ID = guildId;

    const Database = (await import("better-sqlite3")).default;
    const { migrate } = await import("@yugidraft/shared/db");
    const { createDraftService, createPlayerService } = await import("@yugidraft/shared/services");
    const db = new Database(dbPath);
    migrate(db);
    const players = createPlayerService(db);
    const creator = players.findOrCreate(guildId, creatorUserId, "imran443");
    const opponent = players.findOrCreate(guildId, "opponent-user", "Kaiba");
    const drafts = createDraftService(db);
    // 2 players × packSize 1 => 2 distinct cards required to start.
    const draft = drafts.create(
      guildId,
      "channel-1",
      "uncached custom draft",
      { customCardIds: [70781052, 89631139], packSize: 1, packsPerPlayer: 1 },
      creatorUserId,
      creator.id,
    );
    drafts.join(draft.id, opponent.id);
    db.close();

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = new URL(String(input));
        const requestedId = url.searchParams.get("id");
        expect(["70781052", "89631139"]).toContain(requestedId);
        const cards: Record<string, any> = {
          "70781052": {
            id: 70781052,
            name: "Summoned Skull",
            type: "Fiend / Normal Monster",
            frameType: "normal",
            desc: "A fiend with dark powers for confusing the enemy.",
            card_images: [
              { image_url: "https://img/full/summoned-skull", image_url_small: "https://img/small/summoned-skull" },
            ],
            card_sets: [{ set_name: "Metal Raiders" }],
          },
          "89631139": {
            id: 89631139,
            name: "Blue-Eyes White Dragon",
            type: "Dragon / Normal Monster",
            frameType: "normal",
            desc: "The ultimate Dragon warrior.",
            card_images: [
              { image_url: "https://img/full/bewd", image_url_small: "https://img/small/bewd" },
            ],
            card_sets: [{ set_name: "Metal Raiders" }],
          },
        };
        return {
          ok: true,
          async json() {
            return { data: requestedId && cards[requestedId] ? [cards[requestedId]] : [] };
          },
        };
      }),
    );

    const { POST: startDraft } = await import("../app/api/drafts/[slug]/route");
    const response = await startDraft(new Request(`http://localhost/api/drafts/${draft.webSlug}`, { method: "POST" }), {
      params: Promise.resolve({ slug: draft.webSlug ?? "" }),
    });

    expect(response.status).toBe(200);

    const verifyDb = new Database(dbPath);
    expect(verifyDb.prepare("select count(*) as count from card_catalog").get()).toEqual({ count: 2 });
    expect(verifyDb.prepare("select count(*) as count from draft_cards where draft_id = ?").get(draft.id)).toEqual({ count: 2 });
    verifyDb.close();
  }, testTimeoutMs);
});
