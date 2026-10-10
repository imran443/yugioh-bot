import type Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fixtureUserId, seedFixtureUsers } from "./fixtures/identity";

const auth = vi.fn();
vi.mock("@/lib/session-identity", async () => {
  const { sessionFixture } = await import("./fixtures/session");
  return sessionFixture(auth);
});
vi.mock("@/lib/notify", () => ({ announcer: { announce: vi.fn() } }));

let db: Database.Database;
let directory: string;
const hostId = fixtureUserId("host");
const otherId = fixtureUserId("other");

beforeEach(async () => {
  vi.resetModules();
  vi.stubEnv("THEME_DRAFTS", "1");
  auth.mockReset();
  auth.mockResolvedValue({ user: { id: String(hostId), name: "Host" } });
  directory = mkdtempSync(join(tmpdir(), "draft-create-names-"));
  process.env.DATABASE_PATH = join(directory, "test.sqlite");
  process.env.DISCORD_GUILD_ID = "guild-1";
  process.env.DISCORD_BOT_ENABLED = "0";
  db = (await import("@/lib/db")).getDb();
  seedFixtureUsers(db, ["host", "other"]);
  const insert = db.prepare(`insert into card_catalog
    (ygoprodeck_id,name,type,frame_type,image_url,image_url_small,card_sets_json,cached_at)
    values (?,?,'Normal Monster','normal','i','i','[]',?)`);
  for (const id of [46986414, 83764718]) insert.run(id, `Card ${id}`, new Date().toISOString());
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  db?.close();
  delete process.env.DATABASE_PATH;
  delete process.env.DISCORD_GUILD_ID;
  delete process.env.DISCORD_BOT_ENABLED;
  if (directory) rmSync(directory, { recursive: true, force: true });
});

describe.each(["theme", "booster"] as const)("POST /api/drafts %s names", mode => {
  function insertCurrent(userId: number, status = "pending") {
    db.prepare(`insert into drafts (guild_id,name,status,created_by_user_id)
      values ('guild-1','Friday Cup',?,?)`).run(status, userId);
  }

  async function create() {
    const { POST } = await import("../app/api/drafts/route");
    return POST(new Request("http://localhost/api/drafts", {
      method: "POST",
      body: JSON.stringify({
        name: "Friday Cup",
        config: mode === "theme" ? { mode: "theme" } : {
          customCardIds: [46986414, 83764718], packSize: 8, packsPerPlayer: 5,
        },
      }),
    }) as NextRequest);
  }

  it.each(["pending", "active"])("returns 400 for the host's own %s name", async status => {
    insertCurrent(hostId, status);
    const response = await create();
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "You already have a draft called this that hasn't finished." });
    expect(db.prepare("select count(*) as n from drafts").get()).toEqual({ n: 1 });
  });

  it.each(["pending", "active"])("returns 201 when a different host has the same %s name", async status => {
    insertCurrent(otherId, status);
    const response = await create();
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ name: "Friday Cup", status: "pending" });
    expect(db.prepare("select created_by_user_id from drafts order by id").all())
      .toEqual([{ created_by_user_id: otherId }, { created_by_user_id: hostId }]);
  });

  it("returns 400 with host-only copy when a duplicate wins the insert race", async () => {
    const prepare = db.prepare.bind(db);
    const prepareSpy = vi.spyOn(db, "prepare").mockImplementation(sql => {
      const statement = prepare(sql);
      if (sql.includes("select id from drafts")) {
        const get = statement.get.bind(statement);
        vi.spyOn(statement, "get").mockImplementation((...params: unknown[]) => {
          const row = get(...params);
          prepareSpy.mockRestore();
          // Insert a real competing row after the read, keeping the unique index active.
          insertCurrent(hostId);
          return row;
        });
      }
      return statement;
    });
    const response = await create();
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "You already have a draft called this that hasn't finished." });
    expect(db.prepare("select count(*) as n from drafts").get()).toEqual({ n: 1 });
  });
});
