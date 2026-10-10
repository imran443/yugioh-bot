import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";
import { verifyDuelConnectionToken } from "@yugidraft/shared/ws";
import { forkEventFixture } from "../../shared/tests/helpers/replay-fork-events.js";

const mocks = vi.hoisted(() => ({ db: vi.fn(), actor: vi.fn(), host: vi.fn(), announce: vi.fn(), post: vi.fn() }));
vi.mock("@/lib/db", () => ({ getDb: mocks.db }));
vi.mock("@/lib/env", () => ({ env: { discordBotEnabled: true, webUrl: "https://duel.example", wsInternalSecret: "fork-test", wsInternalUrl: "https://ws.example" } }));
vi.mock("@/lib/notify", () => ({ announcer: { announce: mocks.announce } }));
vi.mock("@yugidraft/shared/notify", async importOriginal => ({ ...await importOriginal<object>(), httpTransport: () => ({ post: mocks.post }) }));
vi.mock("@/lib/duel-host", () => ({ requireDuelActor: mocks.actor, callDuelHost: mocks.host,
  duelErrorResponse: (error: { status?: number }) => NextResponse.json({ error: "Denied" }, { status: error.status ?? 400 }) }));
import { sendDuelInvite, announceDuelInvite } from "../src/lib/announce-bot";
import { notifyDuelChange } from "../src/lib/notify-duel";
import { GET } from "../app/api/duels/[slug]/connection/route";

let app: ReturnType<typeof forkEventFixture>;
beforeEach(() => {
  vi.clearAllMocks(); app = forkEventFixture(); vi.stubEnv("OWNER_USER_IDS", "101,102"); mocks.db.mockReturnValue(app.db);
  mocks.announce.mockResolvedValue({ ok: true }); mocks.post.mockResolvedValue({ ok: true });
  mocks.actor.mockResolvedValue({ ok: true, ...app.owner, duels: app.duels });
});
afterEach(() => { app.db.close(); vi.unstubAllEnvs(); });
const invite = (slug: string) => ({ slug, guildId: app.guildId, opponentDiscordUserId: "fixture-recipient", challengerName: "Test",
  duelName: "Test", bestOf: 1 as const, ranked: false, tournamentName: null });
const connection = (query = "") => GET(new Request(`https://duel.example/api/duels/${app.forkSlug}/connection${query}`),
  { params: Promise.resolve({ slug: app.forkSlug }) });

it.each(["active", "completed", "interrupted", "cancelled"])("sends no fork invite in status %s, including retry", async status => {
  app.db.prepare("update duels set status=? where id=?").run(status, app.forkId);
  expect(await sendDuelInvite(invite(app.forkSlug))).toBe(false);
  announceDuelInvite(invite(app.forkSlug));
  expect(await sendDuelInvite(invite(app.forkSlug))).toBe(false);
  expect(mocks.announce).not.toHaveBeenCalled();
});
it("sends a stored reference for a normal duel", async () => {
  expect(await sendDuelInvite(invite(app.source.slug))).toBe(true);
  expect(mocks.announce).toHaveBeenCalledWith(expect.objectContaining({ kind: "duel-invite", duelId: app.source.id, slug: app.source.slug,
    url: `https://duel.example/duels/${app.source.slug}` }));
});
it("routes fork change messages only to the stored fork slug", async () => {
  await notifyDuelChange(app.forkSlug, app.guildId);
  expect(mocks.post.mock.calls).toEqual([["/internal/duel/changed", JSON.stringify({ slug: app.forkSlug, guildId: app.guildId })]]);
  await notifyDuelChange(app.forkSlug, "other-guild");
  await notifyDuelChange("missing", app.guildId);
  expect(mocks.post).toHaveBeenCalledTimes(1);
});
it("keeps the fork token at creator seat 0 and returns no-store headers", async () => {
  const response = await connection();
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(verifyDuelConnectionToken(body.token, "fork-test")).toMatchObject({ slug: app.forkSlug, playerId: app.owner.playerId, seat: 0 });
  expect(response.headers.get("cache-control")).toBe("private, no-store");
});
it.each(["alpha", "dev", "sourcePlayer"] as const)("refuses a fork token for %s before reading room data", async actor => {
  const room = vi.fn(() => app.duels.room(app.forkSlug, app.guildId, app.owner.playerId));
  mocks.actor.mockResolvedValue({ ok: true, ...app[actor], duels: { room } });
  const response = await connection();
  expect(response.status).toBe(404);
  expect(await response.json()).not.toHaveProperty("token");
  expect(room).not.toHaveBeenCalled();
});
it("refuses a revoked creator, including after completion", async () => {
  app.db.prepare("update duels set status='completed' where id=?").run(app.forkId);
  vi.stubEnv("OWNER_USER_IDS", "102");
  expect((await connection()).status).toBe(404);
});
it.each(["?as=3", "?spectate=1"])("rejects identity overrides %s for a fork", async query => {
  expect((await connection(query)).status).toBe(400);
  expect(mocks.host).not.toHaveBeenCalled();
});
