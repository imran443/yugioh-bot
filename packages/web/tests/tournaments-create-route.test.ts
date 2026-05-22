// packages/web/tests/tournaments-create-route.test.ts
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.fn();
const tempDirs: string[] = [];
vi.mock("@/lib/auth", () => ({ auth }));

async function setupDb() {
  const tempDir = mkdtempSync(join(tmpdir(), "yugioh-tournaments-create-"));
  const dbPath = join(tempDir, "test.sqlite");
  tempDirs.push(tempDir);
  process.env.DATABASE_PATH = dbPath;
  process.env.DISCORD_GUILD_ID = "guild-1";
  const Database = (await import("better-sqlite3")).default;
  const { migrate } = await import("@yugidraft/shared/db");
  const db = new Database(dbPath);
  migrate(db);
  db.close();
}

function readDb<T>(fn: (db: import("better-sqlite3").Database) => T): Promise<T> {
  return (async () => {
    const Database = (await import("better-sqlite3")).default;
    const db = new Database(process.env.DATABASE_PATH as string);
    try {
      return fn(db);
    } finally {
      db.close();
    }
  })();
}

const futureIso = () => new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
const pastIso = () => new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

describe("POST /api/tournaments timing options", () => {
  beforeEach(() => {
    vi.resetModules();
    auth.mockReset();
    auth.mockResolvedValue({ user: { id: "host", name: "Yugi" } });
  });
  afterEach(() => {
    delete process.env.DATABASE_PATH;
    delete process.env.DISCORD_GUILD_ID;
    while (tempDirs.length) {
      const d = tempDirs.pop();
      if (d) rmSync(d, { recursive: true, force: true });
    }
  });

  it("persists deadlineAt and reportConfirmWindowHours when valid", async () => {
    await setupDb();
    const deadlineAt = futureIso();
    const { POST } = await import("../app/api/tournaments/route");
    const res = await POST(
      new Request("http://localhost/api/tournaments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Cup", format: "round_robin", deadlineAt, reportConfirmWindowHours: 6 }),
      }) as any,
    );
    expect(res.status).toBe(201);
    const row = await readDb((db) =>
      db
        .prepare("select deadline_at, report_confirm_window_hours from tournaments where name = 'Cup'")
        .get() as { deadline_at: string | null; report_confirm_window_hours: number | null },
    );
    expect(row.deadline_at).toBe(deadlineAt);
    expect(row.report_confirm_window_hours).toBe(6);
  });

  it("creates with null timing columns when options omitted", async () => {
    await setupDb();
    const { POST } = await import("../app/api/tournaments/route");
    const res = await POST(
      new Request("http://localhost/api/tournaments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Cup", format: "round_robin" }),
      }) as any,
    );
    expect(res.status).toBe(201);
    const row = await readDb((db) =>
      db
        .prepare("select deadline_at, report_confirm_window_hours from tournaments where name = 'Cup'")
        .get() as { deadline_at: string | null; report_confirm_window_hours: number | null },
    );
    expect(row.deadline_at).toBeNull();
    expect(row.report_confirm_window_hours).toBeNull();
  });

  it("rejects a deadline in the past with 400", async () => {
    await setupDb();
    const { POST } = await import("../app/api/tournaments/route");
    const res = await POST(
      new Request("http://localhost/api/tournaments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Cup", format: "round_robin", deadlineAt: pastIso() }),
      }) as any,
    );
    expect(res.status).toBe(400);
  });

  it("rejects an out-of-range confirm window with 400", async () => {
    await setupDb();
    const { POST } = await import("../app/api/tournaments/route");
    const low = await POST(
      new Request("http://localhost/api/tournaments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Low", format: "round_robin", reportConfirmWindowHours: 0 }),
      }) as any,
    );
    expect(low.status).toBe(400);

    const high = await POST(
      new Request("http://localhost/api/tournaments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "High", format: "round_robin", reportConfirmWindowHours: 721 }),
      }) as any,
    );
    expect(high.status).toBe(400);
  });
});
