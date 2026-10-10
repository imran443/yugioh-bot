import { seedFixtureUsers, fixtureUserId, fixtureDiscordId } from "./fixtures/identity";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { getDb } from "../src/lib/db";

const auth = vi.fn();
vi.mock("@/lib/session-identity", async () => {
  const { sessionFixture } = await import("./fixtures/session");
  return sessionFixture(auth);
});
let tempDir: string;
let db: ReturnType<typeof getDb>;

describe("resource reads stay in the configured guild", () => {
  beforeEach(async () => {
    vi.resetModules();
    auth.mockResolvedValue({ user: { id: String(fixtureUserId("host")), discordUserId: fixtureDiscordId("host"), name: "Host" } });
    tempDir = mkdtempSync(join(tmpdir(), "yugioh-guild-reads-"));
    vi.stubEnv("DATABASE_PATH", join(tempDir, "test.sqlite"));
    vi.stubEnv("DISCORD_GUILD_ID", "local");
    db = (await import("../src/lib/db")).getDb();
    seedFixtureUsers(db, FIXTURE_KEYS);
    // Foreign rows go first, including the same Discord user in both guilds.
    for (const guild of ["foreign", "local"]) {
      const player = Number(db.prepare(`insert into players (guild_id, user_id, discord_user_id, display_name) values (?, ${fixtureUserId("host")}, '${fixtureDiscordId("host")}', ?)`).run(guild, `${guild} player`).lastInsertRowid);
      const opponent = Number(db.prepare(`insert into players (guild_id, user_id, discord_user_id, display_name) values (?, ${fixtureUserId("guest")}, '${fixtureDiscordId("guest")}', ?)`).run(guild, `${guild} guest`).lastInsertRowid);
      for (const status of ["pending", "active", "completed"]) {
        const tournament = Number(db.prepare(`insert into tournaments (guild_id, name, format, status, created_by_user_id, web_slug) values (?, ?, 'round_robin', ?, ${fixtureUserId("host")}, ?)`).run(guild, `${guild} tournament ${status}`, status, `${guild}-${status}`).lastInsertRowid);
        db.prepare("insert into tournament_participants (tournament_id, player_id) values (?, ?)").run(tournament, player);
        const draft = Number(db.prepare(`insert into drafts (guild_id, channel_id, name, status, created_by_user_id, config_json, web_slug) values (?, 'c', ?, ?, ${fixtureUserId("host")}, '{}', ?)`).run(guild, `${guild} draft ${status}`, status, `${guild}-${status}`).lastInsertRowid);
        db.prepare("insert into draft_players (draft_id, player_id) values (?, ?)").run(draft, player);
      }
      db.prepare("insert into matches (guild_id, player_one_id, player_two_id, winner_id, reporter_id, status, source) values (?, ?, ?, ?, ?, 'approved', 'casual')").run(guild, player, opponent, player, player);
    }
  }, 30000);
  afterEach(() => {
    db?.close();
    vi.unstubAllEnvs();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("lists only configured-guild tournaments in the API", async () => {
    const { GET } = await import("../app/api/tournaments/route");
    const response = await GET(new Request("http://localhost/api/tournaments"));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.items).toHaveLength(3);
    expect(body.nextCursor).toBeNull();
    expect(body.items.every((row: { guildId: string }) => row.guildId === "local")).toBe(true);
    expect(body.items.map((row: { status: string }) => row.status).sort()).toEqual(["active", "completed", "pending"]);
  });

  it.each(["tournaments", "drafts", "dashboard"])("excludes foreign resources from the %s page", async (page) => {
    const { default: Page } = await import(`../app/(app)/${page}/page.tsx`);
    const html = renderToStaticMarkup(await Page());
    expect(html).toContain("local");
    expect(html).not.toContain("foreign");
  });

  it("returns local standings and 404 for foreign standings", async () => {
    const { GET } = await import("../app/api/tournaments/[slug]/standings/route");
    const foreign = await GET(new Request("http://x"), { params: Promise.resolve({ slug: "foreign-active" }) });
    expect(foreign.status).toBe(404);
    const local = await GET(new Request("http://x"), { params: Promise.resolve({ slug: "local-active" }) });
    expect(local.status).toBe(200);
    expect(await local.json()).toEqual([{ playerId: 3, displayName: "local player", wins: 0, losses: 0 }]);
  });

  it("excludes foreign drafts from the draft listing API", async () => {
    const { GET } = await import("../app/api/drafts/route");
    const response = await GET(new Request("http://localhost/api/drafts"));
    const body = await response.json();
    expect(body.items).toHaveLength(3);
    expect(body.nextCursor).toBeNull();
    expect(body.items.map((row: { guildId: string }) => row.guildId)).toEqual(["local", "local", "local"]);
    expect(body.items.map((row: { status: string }) => row.status).sort()).toEqual(["active", "completed", "pending"]);
    expect(JSON.stringify(body)).not.toContain("foreign");
  });

  it("excludes foreign tournaments, drafts and match statistics from the dashboard API", async () => {
    const { GET } = await import("../app/api/dashboard/route");
    const body = await (await GET()).json();
    expect(body.tournaments).toHaveLength(2);
    expect(body.drafts).toHaveLength(2);
    expect(body.stats).toEqual({ wins: 1, losses: 0 });
    expect(JSON.stringify(body)).not.toContain("foreign");
  });

  it("looks up the current player's configured-guild identity", async () => {
    const { GET } = await import("../app/api/player/me/route");
    expect(await (await GET()).json()).toEqual({ playerId: 3 });
  });

  it("hides a foreign player's profile", async () => {
    const { GET } = await import("../app/api/player/[id]/route");
    expect((await GET(new Request("http://x"), { params: Promise.resolve({ id: "1" }) })).status).toBe(404);
  });
  it("omits a foreign draft link from tournament details", async () => {
    db.prepare("update drafts set tournament_id = 4 where id = 1").run();
    const { GET } = await import("../app/api/tournaments/[slug]/route");
    const response = await GET(new Request("http://x"), { params: Promise.resolve({ slug: "local-pending" }) });
    expect(response.status).toBe(200);
    expect((await response.json()).draftSlug).toBeNull();
  });

  it("omits a foreign draft link from the tournament deck read", async () => {
    db.prepare("update drafts set tournament_id = 4 where id = 1").run();
    const { GET } = await import("../app/api/tournaments/[slug]/deck/route");
    const response = await GET(new Request("http://x") as import("next/server").NextRequest, { params: Promise.resolve({ slug: "local-pending" }) });
    expect(response.status).toBe(200);
    expect((await response.json()).draft).toBeNull();
  });

});

const FIXTURE_KEYS = ["host", "guest"] as const;

// Session resolution is mocked; authorization still runs through the real web boundary.
