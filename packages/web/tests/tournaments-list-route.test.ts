import { fixtureUserId, seedFixtureUsers } from "./fixtures/identity";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const tempDirs: string[] = [];
vi.mock("@/lib/session-identity", async () => {
  const { sessionFixture } = await import("./fixtures/session");
  return sessionFixture(() => ({ user: { id: String(fixtureUserId("host")), name: "Host" } }));
});

async function setupDb() {
  const tempDir = mkdtempSync(join(tmpdir(), "yugioh-tournaments-list-"));
  const dbPath = join(tempDir, "test.sqlite");
  tempDirs.push(tempDir);
  process.env.DATABASE_PATH = dbPath;
  process.env.DISCORD_GUILD_ID = "guild-1";
  const Database = (await import("better-sqlite3")).default;
  const { migrate } = await import("@yugidraft/shared/db");
  const db = new Database(dbPath);
  migrate(db);
  seedFixtureUsers(db, FIXTURE_KEYS);
  const ins = db.prepare(
    `insert into tournaments (guild_id, name, format, status, created_by_user_id, web_slug) values ('guild-1', ?, 'round_robin', ?, ${fixtureUserId("host")}, ?)`,
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
    delete process.env.DISCORD_GUILD_ID;
    while (tempDirs.length) {
      const d = tempDirs.pop();
      if (d) rmSync(d, { recursive: true, force: true });
    }
  });

  it("returns pending, active, and completed but not cancelled", async () => {
    await setupDb();
    const { GET } = await import("../app/api/tournaments/route");
    const res = await GET(new Request("http://localhost/api/tournaments"));
    expect(res.status).toBe(200);
    const { items: json } = (await res.json()) as { items: Array<{ name: string; status: string }> };
    const byStatus = Object.fromEntries(json.map((t) => [t.status, t.name]));
    expect(byStatus.active).toBe("Active Cup");
    expect(byStatus.pending).toBe("Pending Cup");
    expect(byStatus.completed).toBe("Done Cup");
    expect(json.some((t) => t.status === "cancelled")).toBe(false);
  });
});

const FIXTURE_KEYS = ["host"] as const;

// Session resolution is mocked; authorization still runs through the real web boundary.
