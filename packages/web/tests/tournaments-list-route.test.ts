import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const tempDirs: string[] = [];
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

async function setupDb() {
  const tempDir = mkdtempSync(join(tmpdir(), "yugioh-tournaments-list-"));
  const dbPath = join(tempDir, "test.sqlite");
  tempDirs.push(tempDir);
  process.env.DATABASE_PATH = dbPath;
  const Database = (await import("better-sqlite3")).default;
  const { migrate } = await import("@yugidraft/shared/db");
  const db = new Database(dbPath);
  migrate(db);
  const ins = db.prepare(
    `insert into tournaments (guild_id, name, format, status, created_by_user_id, web_slug)
     values ('guild-1', ?, 'round_robin', ?, 'host', ?)`,
  );
  ins.run("Active Cup", "active", "slug-a");
  ins.run("Pending Cup", "pending", "slug-p");
  ins.run("Done Cup", "completed", "slug-c");
  ins.run("Aborted Cup", "cancelled", "slug-x");
  db.close();
}

describe("GET /api/tournaments includes completed", () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => {
    delete process.env.DATABASE_PATH;
    while (tempDirs.length) {
      const d = tempDirs.pop();
      if (d) rmSync(d, { recursive: true, force: true });
    }
  });

  it("returns pending, active, and completed but not cancelled", async () => {
    await setupDb();
    const { GET } = await import("../app/api/tournaments/route");
    const res = await GET();
    expect(res.status).toBe(200);
    const json = (await res.json()) as Array<{ name: string; status: string }>;
    const byStatus = Object.fromEntries(json.map((t) => [t.status, t.name]));
    expect(byStatus.active).toBe("Active Cup");
    expect(byStatus.pending).toBe("Pending Cup");
    expect(byStatus.completed).toBe("Done Cup");
    expect(json.some((t) => t.status === "cancelled")).toBe(false);
  });
});
