import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.fn();
const tempDirs: string[] = [];

vi.mock("@/lib/auth", () => ({ auth }));

function seedActive(dbPath: string) {
  return import("better-sqlite3").then(async ({ default: Database }) => {
    const { migrate } = await import("../../../shared/src/db/schema");
    const seedDb = new Database(dbPath);
    migrate(seedDb);
    seedDb
      .prepare(
        "insert into tournaments (guild_id, name, format, status, created_by_user_id, web_slug) values ('g1','T','round_robin','active','u-org','slug-1')",
      )
      .run();
    seedDb.close();
  });
}

describe("POST /api/tournaments/[slug]/complete", () => {
  beforeEach(() => {
    vi.resetModules();
    auth.mockReset();
    auth.mockResolvedValue({ user: { id: "u-org", name: "Org" } });
  });

  afterEach(() => {
    delete process.env.DATABASE_PATH;
    while (tempDirs.length > 0) {
      const d = tempDirs.pop();
      if (d) rmSync(d, { recursive: true, force: true });
    }
  });

  it("completes an active tournament and returns status completed", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "tourney-complete-"));
    const dbPath = join(tempDir, "t.sqlite");
    tempDirs.push(tempDir);
    process.env.DATABASE_PATH = dbPath;
    await seedActive(dbPath);

    const { POST } = await import("../../app/api/tournaments/[slug]/complete/route");
    const res = await POST(
      new Request("http://localhost/api/tournaments/slug-1/complete", { method: "POST" }),
      { params: Promise.resolve({ slug: "slug-1" }) },
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("completed");

    const Database = (await import("better-sqlite3")).default;
    const check = new Database(dbPath);
    const row = check.prepare("select status, ended_at from tournaments where web_slug = 'slug-1'").get() as {
      status: string;
      ended_at: string | null;
    };
    check.close();
    expect(row.status).toBe("completed");
    expect(row.ended_at).not.toBeNull();
  });

  it("returns 400 when the tournament is not active", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "tourney-complete-"));
    const dbPath = join(tempDir, "t.sqlite");
    tempDirs.push(tempDir);
    process.env.DATABASE_PATH = dbPath;

    const Database = (await import("better-sqlite3")).default;
    const { migrate } = await import("../../../shared/src/db/schema");
    const seedDb = new Database(dbPath);
    migrate(seedDb);
    seedDb
      .prepare(
        "insert into tournaments (guild_id, name, format, status, created_by_user_id, web_slug) values ('g1','T','round_robin','pending','u-org','slug-1')",
      )
      .run();
    seedDb.close();

    const { POST } = await import("../../app/api/tournaments/[slug]/complete/route");
    const res = await POST(
      new Request("http://localhost/api/tournaments/slug-1/complete", { method: "POST" }),
      { params: Promise.resolve({ slug: "slug-1" }) },
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/cannot end a pending/i);
  });

  it("returns 403 when the caller is not the creator", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "tourney-complete-"));
    const dbPath = join(tempDir, "t.sqlite");
    tempDirs.push(tempDir);
    process.env.DATABASE_PATH = dbPath;
    await seedActive(dbPath);
    auth.mockResolvedValue({ user: { id: "u-someone-else", name: "Nope" } });

    const { POST } = await import("../../app/api/tournaments/[slug]/complete/route");
    const res = await POST(
      new Request("http://localhost/api/tournaments/slug-1/complete", { method: "POST" }),
      { params: Promise.resolve({ slug: "slug-1" }) },
    );
    expect(res.status).toBe(403);
  });
});
