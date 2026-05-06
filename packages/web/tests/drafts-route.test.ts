import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.fn();
const repoRoot = "/home/imran/yugioh-discord-bot";
const tempDirs: string[] = [];

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

    const { GET } = await import("../app/api/drafts/[slug]/route");

    const response = await GET(new Request("http://localhost/api/drafts/legendary-draft"), {
      params: Promise.resolve({ slug: "legendary-draft" }),
    });

    expect(response.status).toBe(200);

    const payload = await response.json();

    expect(payload.status).toBe("active");
    expect(payload.config.setNames).toBeDefined();
    expect(payload.currentPack).toBeDefined();
    expect(Array.isArray(payload.currentPack)).toBe(true);
    expect(payload.currentPack.length).toBeGreaterThan(0);
    expect(payload.currentPack[0]).toMatchObject({
      id: expect.any(Number),
      name: expect.any(String),
      type: expect.any(String),
      frameType: expect.any(String),
      imageUrl: expect.any(String),
      imageUrlSmall: expect.any(String),
    });
    expect(payload.seats).toBeDefined();
    expect(Array.isArray(payload.seats)).toBe(true);
    expect(payload.seats.length).toBeGreaterThan(0);
    expect(payload.pickSeconds).toBeGreaterThan(0);
    expect(typeof payload.isMyTurn).toBe("boolean");
  });
});
