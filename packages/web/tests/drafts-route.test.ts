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

  it("prefers the current guild draft when another guild has the same slug", async () => {
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
});
