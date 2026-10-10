import { seedFixtureUsers, fixtureUserId, fixtureDiscordId } from "./fixtures/identity";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { NextRequest } from "next/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
vi.mock("@/lib/session-identity", async () => {
  const { sessionFixture } = await import("./fixtures/session");
  return sessionFixture((() => ({ auth: vi.fn().mockResolvedValue({ user: { id: String(fixtureUserId("host")), discordUserId: fixtureDiscordId("host"), name: "Host" } }) }))().auth);
});
vi.mock("@/lib/notify", () => ({ announcer: { announce: vi.fn() }, broadcaster: { draft: vi.fn() } }));
let directory: string;
beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("THEME_DRAFTS", "1");
  directory = mkdtempSync(join(tmpdir(), "draft-theme-numbers-"));
  vi.stubEnv("DATABASE_PATH", join(directory, "test.sqlite"));
  vi.stubEnv("DISCORD_GUILD_ID", "g");
  vi.stubEnv("DISCORD_DEFAULT_CHANNEL_ID", "c");
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(directory, { recursive: true, force: true }); });
it.each([{ themePackSize: 0 }, { themePackSize: 2.5 }, { cardsPerPlayer: 0 }, { extraDeckSize: -1 }])("rejects invalid theme numbers on POST and PUT: %j", async (invalid) => {
  const { POST } = await import("../app/api/drafts/route");
  const created = await POST(new Request("http://x", { method: "POST", body: JSON.stringify({ name: "Bad", config: { mode: "theme", ...invalid } }) }) as NextRequest);
  expect(created.status).toBe(400);
  const { getDb } = await import("../src/lib/db");
  const db = getDb();
  seedFixtureUsers(db, FIXTURE_KEYS);
  expect(db.prepare("select count(*) as n from drafts").get()).toEqual({ n: 0 });
  const { createDraftService, createPlayerService } = await import("@yugidraft/shared/services");
  const host = createPlayerService(db).findOrCreate("g", fixtureUserId("host"), "Host");
  const draft = createDraftService(db).create("g", "c", "Good", { mode: "theme", cardsPerPlayer: 1, extraDeckSize: 0, themePackSize: 3 }, fixtureUserId("host"), host.id);
  const { PUT } = await import("../app/api/drafts/[slug]/route");
  const edited = await PUT(new Request("http://x", { method: "PUT", body: JSON.stringify({ config: invalid }) }) as NextRequest, { params: Promise.resolve({ slug: draft.webSlug! }) });
  expect(edited.status).toBe(400);
  expect(createDraftService(db).findById(draft.id).config).toEqual(draft.config);
});

const FIXTURE_KEYS = ["host"] as const;

// Session resolution is mocked; authorization still runs through the real web boundary.
