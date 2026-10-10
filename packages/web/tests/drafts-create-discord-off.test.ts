import { fixtureUserId, fixtureDiscordId, seedFixtureUsers } from "./fixtures/identity";
import Database from "better-sqlite3";
import type { NextRequest } from "next/server";
import { migrate } from "@yugidraft/shared/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { auth, getDb, announce } = vi.hoisted(() => ({
  auth: vi.fn(),
  getDb: vi.fn(),
  announce: vi.fn(),
}));

vi.mock("@/lib/session-identity", async () => {
  const { sessionFixture } = await import("./fixtures/session");
  return sessionFixture(auth);
});
vi.mock("@/lib/db", () => ({ getDb }));
vi.mock("@/lib/notify", () => ({
  announcer: { announce },
  broadcaster: { draft: vi.fn() },
}));

describe.each(["theme", "booster"] as const)("POST /api/drafts (%s Discord settings)", (mode) => {
  let db: Database.Database;

  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("THEME_DRAFTS", "1");
    vi.clearAllMocks();
    vi.stubEnv("DISCORD_GUILD_ID", "guild-1");
    vi.stubEnv("DISCORD_DEFAULT_CHANNEL_ID", "default-channel");
    vi.stubEnv("DISCORD_REMINDER_CHANNEL_ID", undefined);
    vi.stubEnv("DISCORD_BOT_ENABLED", "0");
    auth.mockResolvedValue({ user: { id: String(fixtureUserId("creator-user")), name: "Yugi" } });
    announce.mockResolvedValue({ ok: true });
    db = new Database(":memory:");
    migrate(db); seedFixtureUsers(db, FIXTURE_KEYS);
    getDb.mockReturnValue(db);
    const insert = db.prepare(`insert into card_catalog
      (ygoprodeck_id, name, type, frame_type, image_url, image_url_small, card_sets_json, cached_at)
      values (?, ?, 'Effect Monster', 'effect', 'image', 'small', '[]', '2026-10-07T00:00:00Z')`);
    for (const id of [46986414, 83764718]) insert.run(id, `Card ${id}`);
  });

  afterEach(() => {
    db.close();
    vi.unstubAllEnvs();
  });

  async function createDraft(channelId?: unknown) {
    const { POST } = await import("../app/api/drafts/route");
    const config = mode === "theme"
      ? { mode: "theme" }
      : { customCardIds: [46986414, 83764718], packSize: 8, packsPerPlayer: 5 };
    return POST(new Request("http://localhost/api/drafts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Discord Settings Draft", config, channelId }),
    }) as NextRequest);
  }

  it.each([undefined, "0"])("does not announce creation when DISCORD_BOT_ENABLED=%s", async (flag) => {
    vi.stubEnv("DISCORD_BOT_ENABLED", flag);

    const response = await createDraft();

    expect(response.status).toBe(201);
    expect(db.prepare("select count(*) as count from drafts").get()).toEqual({ count: 1 });
    expect(db.prepare("select channel_id from drafts").get()).toEqual({ channel_id: null });
    expect(announce).not.toHaveBeenCalled();
  });

  it("announces creation when Discord is enabled", async () => {
    vi.stubEnv("DISCORD_BOT_ENABLED", "1");

    const response = await createDraft();
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(db.prepare("select channel_id from drafts where id = ?").get(body.id))
      .toEqual({ channel_id: "default-channel" });
    expect(announce).toHaveBeenCalledExactlyOnceWith({
      kind: "draft-created",
      draftId: body.id,
      channelId: "default-channel",
      name: "Discord Settings Draft",
      webSlug: body.webSlug,
    });
  });

  it.each([undefined, "ignored-channel", null, 123])(
    "creates without a configured channel and ignores request channelId=%j when Discord is off",
    async (channelId) => {
      vi.stubEnv("DISCORD_DEFAULT_CHANNEL_ID", undefined);

      const response = await createDraft(channelId);
      const body = await response.json();

      expect(response.status).toBe(201);
      expect(db.prepare("select channel_id from drafts where id = ?").get(body.id))
        .toEqual({ channel_id: null });
      expect(db.prepare("select count(*) as count from draft_players where draft_id = ?").get(body.id))
        .toEqual({ count: 1 });
      expect(announce).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, "default-channel"])(
    "uses the request channel when Discord is on and the default is %s",
    async (defaultChannel) => {
      vi.stubEnv("DISCORD_BOT_ENABLED", "1");
      vi.stubEnv("DISCORD_DEFAULT_CHANNEL_ID", defaultChannel);

      const response = await createDraft("request-channel");
      const body = await response.json();

      expect(response.status).toBe(201);
      expect(db.prepare("select channel_id from drafts where id = ?").get(body.id))
        .toEqual({ channel_id: "request-channel" });
      expect(announce).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
        kind: "draft-created", draftId: body.id, channelId: "request-channel",
      }));
    },
  );

  it.each([undefined, ""])("creates without a channel when Discord is on (channelId=%j)", async (channelId) => {
    vi.stubEnv("DISCORD_BOT_ENABLED", "1");
    vi.stubEnv("DISCORD_DEFAULT_CHANNEL_ID", undefined);

    const response = await createDraft(channelId);
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(db.prepare("select channel_id from drafts where id = ?").get(body.id)).toEqual({ channel_id: null });
    expect(db.prepare("select count(*) as count from draft_players where draft_id = ?").get(body.id)).toEqual({ count: 1 });
    expect(announce).not.toHaveBeenCalled();
  });

  it.each([null, 123])("still rejects invalid channelId=%j when Discord is on", async (channelId) => {
    vi.stubEnv("DISCORD_BOT_ENABLED", "1");

    const response = await createDraft(channelId);

    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe("INVALID_BODY");
    expect(db.prepare("select count(*) as count from drafts").get()).toEqual({ count: 0 });
    expect(announce).not.toHaveBeenCalled();
  });

  it("keeps the reminder channel fallback when Discord is on", async () => {
    vi.stubEnv("DISCORD_BOT_ENABLED", "1");
    vi.stubEnv("DISCORD_DEFAULT_CHANNEL_ID", undefined);
    vi.stubEnv("DISCORD_REMINDER_CHANNEL_ID", "reminder-channel");

    const response = await createDraft();
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(db.prepare("select channel_id from drafts where id = ?").get(body.id))
      .toEqual({ channel_id: "reminder-channel" });
    expect(announce).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      kind: "draft-created", draftId: body.id, channelId: "reminder-channel",
    }));
  });

  it.each(["0", "1"])("still requires a guild when DISCORD_BOT_ENABLED=%s", async (flag) => {
    vi.stubEnv("DISCORD_BOT_ENABLED", flag);
    vi.stubEnv("DISCORD_GUILD_ID", undefined);

    const response = await createDraft();

    expect(response.status).toBe(500);
    expect(db.prepare("select count(*) as count from drafts").get()).toEqual({ count: 0 });
    expect(announce).not.toHaveBeenCalled();
  });
});

const FIXTURE_KEYS = ["bot_player_dev_table_1", "creator-user", "guest", "host", "joining", "member", "observer", "other", "p2", "p3", "second", "stranger", "viewer"] as const;
