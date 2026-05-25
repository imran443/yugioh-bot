import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.fn();
const broadcaster = { draft: vi.fn(), tournament: vi.fn() };
const tempDirs: string[] = [];

vi.mock("@/lib/auth", () => ({
  auth,
}));

vi.mock("@/lib/notify", () => ({
  broadcaster,
  announcer: { announce: vi.fn() },
}));

async function createPendingDraftDb() {
  const tempDir = mkdtempSync(join(tmpdir(), "yugioh-join-bot-route-"));
  const dbPath = join(tempDir, "join-bot-route.sqlite");
  tempDirs.push(tempDir);

  process.env.DATABASE_PATH = dbPath;
  process.env.DISCORD_GUILD_ID = "guild-1";
  process.env.WS_INTERNAL_URL = "http://ws:3001";
  process.env.WS_INTERNAL_SECRET = "secret";

  const Database = (await import("better-sqlite3")).default;
  const { migrate } = await import("@yugidraft/shared/db");
  const { createDraftService, createPlayerService } = await import("@yugidraft/shared/services");
  const db = new Database(dbPath);
  migrate(db);

  const players = createPlayerService(db);
  const creator = players.findOrCreate("guild-1", "creator-user", "Yugi");
  const drafts = createDraftService(db);
  const draft = drafts.create(
    "guild-1",
    "channel-1",
    "pending bot draft",
    { setNames: ["Metal Raiders"], packSize: 2, packsPerPlayer: 1 },
    "creator-user",
    creator.id,
  );

  db.close();

  return draft;
}

describe("POST /api/drafts/[slug]/join-bot", () => {
  beforeEach(() => {
    vi.resetModules();
    auth.mockReset();
    broadcaster.draft.mockReset();
    auth.mockResolvedValue({ user: { id: "creator-user", name: "Yugi" } });
  });

  afterEach(() => {
    delete process.env.DATABASE_PATH;
    delete process.env.DISCORD_GUILD_ID;
    delete process.env.WS_INTERNAL_URL;
    delete process.env.WS_INTERNAL_SECRET;

    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it("broadcasts seats after adding the dev bot", async () => {
    const draft = await createPendingDraftDb();
    const { POST } = await import("../app/api/drafts/[slug]/join-bot/route");

    const response = await POST(new Request(`http://localhost/api/drafts/${draft.webSlug}/join-bot`, { method: "POST" }), {
      params: Promise.resolve({ slug: draft.webSlug ?? "" }),
    });

    expect(response.status).toBe(200);
    expect(broadcaster.draft).toHaveBeenCalledOnce();
    expect(broadcaster.draft).toHaveBeenCalledWith(
      { kind: "seats", slug: draft.webSlug },
    );
  });

  it("adds multiple distinct bots to the same draft", async () => {
    const draft = await createPendingDraftDb();
    const { POST } = await import("../app/api/drafts/[slug]/join-bot/route");

    const makeRequest = () =>
      POST(new Request(`http://localhost/api/drafts/${draft.webSlug}/join-bot`, { method: "POST" }), {
        params: Promise.resolve({ slug: draft.webSlug ?? "" }),
      });

    const first = await makeRequest();
    const second = await makeRequest();
    const third = await makeRequest();

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(third.status).toBe(200);

    const firstBody = await first.json();
    const secondBody = await second.json();
    const thirdBody = await third.json();

    const playerIds = [firstBody.playerId, secondBody.playerId, thirdBody.playerId];
    expect(new Set(playerIds).size).toBe(3);

    const names = [firstBody.displayName, secondBody.displayName, thirdBody.displayName];
    expect(new Set(names).size).toBe(3);
  });
});
