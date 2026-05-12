import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.fn();
const tempDirs: string[] = [];

vi.mock("@/lib/auth", () => ({ auth }));

describe("POST /api/drafts/[slug]/tournament", () => {
  beforeEach(() => {
    vi.resetModules();
    auth.mockReset();
    auth.mockResolvedValue({ user: { id: "creator-user", name: "Yugi" } });
  });

  afterEach(() => {
    delete process.env.DATABASE_PATH;
    delete process.env.DISCORD_GUILD_ID;
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  async function setupCompletedDraft() {
    const tempDir = mkdtempSync(join(tmpdir(), "yugioh-tournament-route-"));
    const dbPath = join(tempDir, "test.sqlite");
    tempDirs.push(tempDir);
    process.env.DATABASE_PATH = dbPath;
    process.env.DISCORD_GUILD_ID = "guild-1";

    const Database = (await import("better-sqlite3")).default;
    const { migrate } = await import("@yugidraft/shared/db");
    const db = new Database(dbPath);
    migrate(db);

    db.prepare("insert into players (guild_id, discord_user_id, display_name) values ('guild-1', 'creator-user', 'Yugi')").run();
    db.prepare("insert into players (guild_id, discord_user_id, display_name) values ('guild-1', 'other-user', 'Kaiba')").run();
    const p1 = db.prepare("select id from players where discord_user_id = 'creator-user'").get() as { id: number };
    const p2 = db.prepare("select id from players where discord_user_id = 'other-user'").get() as { id: number };

    db.prepare(
      `insert into drafts (guild_id, channel_id, name, status, created_by_user_id, config_json, web_slug)
       values ('guild-1', 'ch1', 'My Draft', 'completed', 'creator-user', '{}', 'test-slug')`,
    ).run();
    db.prepare("insert into draft_players (draft_id, player_id) values (1, ?)").run(p1.id);
    db.prepare("insert into draft_players (draft_id, player_id) values (1, ?)").run(p2.id);
    db.close();
  }

  it("creates a round-robin tournament seeded with draft players", async () => {
    await setupCompletedDraft();
    const { POST } = await import("../app/api/drafts/[slug]/tournament/route");
    const request = new Request("http://localhost/api/drafts/test-slug/tournament", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ format: "round_robin" }),
    }) as NextRequest;

    const response = await POST(request, { params: Promise.resolve({ slug: "test-slug" }) });
    expect(response.status).toBe(201);
    const data = await response.json();
    expect(data.format).toBe("round_robin");
    expect(data.name).toBe("My Draft");
  });

  it("returns 409 when tournament already linked", async () => {
    await setupCompletedDraft();
    const { POST } = await import("../app/api/drafts/[slug]/tournament/route");
    const req = () => new Request("http://localhost/api/drafts/test-slug/tournament", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ format: "round_robin" }),
    }) as NextRequest;

    await POST(req(), { params: Promise.resolve({ slug: "test-slug" }) });
    const response2 = await POST(req(), { params: Promise.resolve({ slug: "test-slug" }) });
    expect(response2.status).toBe(409);
  });

  it("returns 403 when non-creator calls the route", async () => {
    await setupCompletedDraft();
    auth.mockResolvedValue({ user: { id: "other-user", name: "Kaiba" } });
    const { POST } = await import("../app/api/drafts/[slug]/tournament/route");
    const request = new Request("http://localhost/api/drafts/test-slug/tournament", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ format: "round_robin" }),
    }) as NextRequest;

    const response = await POST(request, { params: Promise.resolve({ slug: "test-slug" }) });
    expect(response.status).toBe(403);
  });

  it("returns 400 for invalid format", async () => {
    await setupCompletedDraft();
    const { POST } = await import("../app/api/drafts/[slug]/tournament/route");
    const request = new Request("http://localhost/api/drafts/test-slug/tournament", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ format: "invalid" }),
    }) as NextRequest;

    const response = await POST(request, { params: Promise.resolve({ slug: "test-slug" }) });
    expect(response.status).toBe(400);
  });
});
