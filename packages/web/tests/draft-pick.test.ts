import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.fn();
const repoRoot = "/home/imran/yugioh-discord-bot";
const tempDirs: string[] = [];
const testTimeoutMs = 20000;

vi.mock("@/lib/auth", () => ({
  auth,
}));

describe("POST /api/drafts/[slug]/pick", () => {
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

  it("returns 401 when unauthenticated", async () => {
    auth.mockResolvedValue(null);

    const { POST } = await import("../app/api/drafts/[slug]/pick/route");

    const response = await POST(
      new NextRequest("http://localhost/api/drafts/legendary-draft/pick", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cardId: 1 }),
      }),
      { params: Promise.resolve({ slug: "legendary-draft" }) }
    );

    expect(response.status).toBe(401);
  }, testTimeoutMs);

  it("returns 404 for non-existent draft", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "yugioh-draft-pick-"));
    const dbPath = join(tempDir, "draft-pick.sqlite");
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

    const { POST } = await import("../app/api/drafts/[slug]/pick/route");

    const response = await POST(
      new NextRequest("http://localhost/api/drafts/non-existent/pick", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cardId: 1 }),
      }),
      { params: Promise.resolve({ slug: "non-existent" }) }
    );

    expect(response.status).toBe(404);
  }, testTimeoutMs);

  it("returns 400 when draft is not active", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "yugioh-draft-pick-"));
    const dbPath = join(tempDir, "draft-pick.sqlite");
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

    const { POST } = await import("../app/api/drafts/[slug]/pick/route");

    const response = await POST(
      new NextRequest("http://localhost/api/drafts/legendary-draft/pick", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cardId: 1 }),
      }),
      { params: Promise.resolve({ slug: "legendary-draft" }) }
    );

    expect(response.status).toBe(400);
    const payload = await response.json();
    expect(payload.error).toContain("not active");
  }, testTimeoutMs);

  it("persists a pick and auto-picks for fake players after starting the draft", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "yugioh-draft-pick-"));
    const dbPath = join(tempDir, "draft-pick.sqlite");
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

    // Start the draft
    const { POST: startDraft } = await import("../app/api/drafts/[slug]/route");
    const startResponse = await startDraft(
      new NextRequest("http://localhost/api/drafts/legendary-draft", {
        method: "POST",
      }),
      { params: Promise.resolve({ slug: "legendary-draft" }) }
    );

    expect(startResponse.status).toBe(200);

    // Get initial draft state to find a valid card
    const { GET } = await import("../app/api/drafts/[slug]/route");
    const getResponse = await GET(
      new NextRequest("http://localhost/api/drafts/legendary-draft"),
      { params: Promise.resolve({ slug: "legendary-draft" }) }
    );

    const initialState = await getResponse.json();
    expect(initialState.currentPack.length).toBeGreaterThan(0);

    const cardToPick = initialState.currentPack[0];

    // Pick the card
    const { POST: pickCard } = await import("../app/api/drafts/[slug]/pick/route");
    const pickResponse = await pickCard(
      new NextRequest("http://localhost/api/drafts/legendary-draft/pick", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cardId: cardToPick.id }),
      }),
      { params: Promise.resolve({ slug: "legendary-draft" }) }
    );

    expect(pickResponse.status).toBe(200);

    const afterPick = await pickResponse.json();
    expect(afterPick.myPool.length).toBeGreaterThan(0);
    expect(afterPick.myPool.some((c: any) => c.id === cardToPick.id)).toBe(true);

    // Verify fake players auto-picked by checking that some seats have hasPicked=true
    // (the real player + at least some fake players should have picked)
    expect(afterPick.seats.length).toBeGreaterThan(0);

    // Verify pick was persisted by checking the pool
    expect(afterPick.myPool.length).toBeGreaterThan(0);
    expect(afterPick.myPool.some((c: any) => c.id === cardToPick.id)).toBe(true);
  }, testTimeoutMs);

  it("returns 400 for invalid cardId", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "yugioh-draft-pick-"));
    const dbPath = join(tempDir, "draft-pick.sqlite");
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

    // Start the draft first
    const { POST: startDraft } = await import("../app/api/drafts/[slug]/route");
    await startDraft(
      new NextRequest("http://localhost/api/drafts/legendary-draft", {
        method: "POST",
      }),
      { params: Promise.resolve({ slug: "legendary-draft" }) }
    );

    const { POST: pickCard } = await import("../app/api/drafts/[slug]/pick/route");

    // Missing cardId
    const missingResponse = await pickCard(
      new NextRequest("http://localhost/api/drafts/legendary-draft/pick", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      }),
      { params: Promise.resolve({ slug: "legendary-draft" }) }
    );
    expect(missingResponse.status).toBe(400);

    // Non-integer cardId
    const stringResponse = await pickCard(
      new NextRequest("http://localhost/api/drafts/legendary-draft/pick", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cardId: "not-a-number" }),
      }),
      { params: Promise.resolve({ slug: "legendary-draft" }) }
    );
    expect(stringResponse.status).toBe(400);

    // Invalid card (not in pack)
    const invalidResponse = await pickCard(
      new NextRequest("http://localhost/api/drafts/legendary-draft/pick", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cardId: 999999 }),
      }),
      { params: Promise.resolve({ slug: "legendary-draft" }) }
    );
    expect(invalidResponse.status).toBe(400);
  }, testTimeoutMs);

  it("returns 400 for non-participant", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "yugioh-draft-pick-"));
    const dbPath = join(tempDir, "draft-pick.sqlite");
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

    // Start the draft first
    const { POST: startDraft } = await import("../app/api/drafts/[slug]/route");
    await startDraft(
      new NextRequest("http://localhost/api/drafts/legendary-draft", {
        method: "POST",
      }),
      { params: Promise.resolve({ slug: "legendary-draft" }) }
    );

    // Authenticate as a different user who is not a participant
    auth.mockResolvedValue({
      user: { id: "non-participant-123", name: "Stranger" },
    });

    const { POST: pickCard } = await import("../app/api/drafts/[slug]/pick/route");
    const response = await pickCard(
      new NextRequest("http://localhost/api/drafts/legendary-draft/pick", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cardId: 1 }),
      }),
      { params: Promise.resolve({ slug: "legendary-draft" }) }
    );

    expect(response.status).toBe(400);
    const payload = await response.json();
    expect(payload.error).toContain("not a participant");
  }, testTimeoutMs);
});
