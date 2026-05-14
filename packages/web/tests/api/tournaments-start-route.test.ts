import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.fn();
const tempDirs: string[] = [];

vi.mock("@/lib/auth", () => ({ auth }));

describe("POST /api/tournaments/[slug] (start)", () => {
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

  it("returns the actual validation error with 400 when starting fails", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "tourney-start-"));
    const dbPath = join(tempDir, "t.sqlite");
    tempDirs.push(tempDir);
    process.env.DATABASE_PATH = dbPath;

    const Database = (await import("better-sqlite3")).default;
    const { migrate } = await import("../../../shared/src/db/schema");
    const seedDb = new Database(dbPath);
    migrate(seedDb);
    seedDb
      .prepare("insert into tournaments (guild_id, name, format, status, created_by_user_id, web_slug) values ('g1','T','round_robin','pending','u-org','slug-1')")
      .run();
    seedDb.close();

    const { POST } = await import("../../app/api/tournaments/[slug]/route");
    const res = await POST(new Request("http://localhost/api/tournaments/slug-1", { method: "POST" }), {
      params: Promise.resolve({ slug: "slug-1" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/at least two/i);
  });
});
