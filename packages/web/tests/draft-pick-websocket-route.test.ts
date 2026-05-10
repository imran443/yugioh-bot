import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.fn();
const notifyWs = vi.fn();
const tempDirs: string[] = [];

vi.mock("@/lib/auth", () => ({
  auth,
}));

vi.mock("@/lib/notify-ws", () => ({
  notifyWs,
}));

async function createStartedDraftDb() {
  const tempDir = mkdtempSync(join(tmpdir(), "yugioh-draft-pick-ws-"));
  const dbPath = join(tempDir, "draft-pick-websocket-route.sqlite");
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

  const insertCard = db.prepare(
    `
      insert into card_catalog (
        ygoprodeck_id,
        name,
        type,
        frame_type,
        image_url,
        image_url_small,
        card_sets_json,
        cached_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?)
    `,
  );

  for (let id = 1; id <= 4; id += 1) {
    insertCard.run(
      id,
      `Card ${id}`,
      "Spellcaster / Normal Monster",
      "normal",
      `https://img/full/${id}`,
      `https://img/small/${id}`,
      JSON.stringify([{ set_name: "Metal Raiders" }]),
      "2026-01-01T00:00:00Z",
    );
  }

  const players = createPlayerService(db);
  const yugi = players.findOrCreate("guild-1", "user-1", "Yugi");
  const kaiba = players.findOrCreate("guild-1", "user-2", "Kaiba");
  const drafts = createDraftService(db);
  const draft = drafts.create(
    "guild-1",
    "channel-1",
    "socket draft",
    { setNames: ["Metal Raiders"], packSize: 2, packsPerPlayer: 1, pickSeconds: 60 },
    "user-1",
    yugi.id,
  );
  drafts.join(draft.id, kaiba.id);
  drafts.start(draft.id, new Date("2026-05-09T20:00:00.000Z"));

  const yugiCard = drafts.currentPackOptions(draft.id, yugi.id)[0];
  drafts.pickCard(draft.id, yugi.id, yugiCard.id, "manual", new Date("2026-05-09T20:00:01.000Z"));

  const kaibaCard = drafts.currentPackOptions(draft.id, kaiba.id)[0];

  db.close();

  return {
    draft,
    kaiba,
    kaibaCard,
  };
}

describe("POST /api/drafts/[slug]/pick websocket events", () => {
  beforeEach(() => {
    vi.resetModules();
    auth.mockReset();
    notifyWs.mockReset();
    auth.mockResolvedValue({ user: { id: "user-2", name: "Kaiba" } });
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

  it("emits the current-step pick before resyncing to the next step", async () => {
    const { draft, kaibaCard } = await createStartedDraftDb();
    const { POST } = await import("../app/api/drafts/[slug]/pick/route");

    const response = await POST(
      new NextRequest(`http://localhost/api/drafts/${draft.webSlug}/pick`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cardId: kaibaCard.id }),
      }),
      { params: Promise.resolve({ slug: draft.webSlug ?? "" }) },
    );

    expect(response.status).toBe(200);
    expect(notifyWs).toHaveBeenCalledTimes(2);
    expect(notifyWs).toHaveBeenNthCalledWith(
      1,
      { url: "http://ws:3001", secret: "secret" },
      { kind: "pick", slug: draft.webSlug, playerId: 2, packRound: 1, pickStep: 1 },
    );
    expect(notifyWs).toHaveBeenNthCalledWith(
      2,
      { url: "http://ws:3001", secret: "secret" },
      { kind: "resync", slug: draft.webSlug, packRound: 1, pickStep: 2 },
    );
  });
});
