import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { migrate } from "@yugidraft/shared/db";
import { createDuelService, createDraftLobbyService, createDraftService, createTournamentService } from "@yugidraft/shared/services";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fixtureUserId, fixtureDiscordId, seedFixtureUsers } from "./fixtures/identity";

const { auth, announce, draft, tournament, duelChange, transport } = vi.hoisted(() => ({
  auth: vi.fn(), announce: vi.fn(async (..._args: unknown[]) => ({ ok: true })), draft: vi.fn(),
  tournament: vi.fn(), duelChange: vi.fn(async () => {}), transport: vi.fn(),
}));
vi.mock("@/lib/session-identity", async () => {
  const { sessionFixture } = await import("./fixtures/session");
  return sessionFixture(auth);
});
vi.mock("@/lib/notify", () => ({ announcer: { announce }, broadcaster: { draft, tournament } }));
vi.mock("@/lib/notify-duel", () => ({ notifyDuelChange: duelChange }));
vi.mock("@yugidraft/shared/notify", async (original) => {
  const actual = await original<typeof import("@yugidraft/shared/notify")>();
  return { ...actual, httpTransport: (...args: Parameters<typeof actual.httpTransport>) => {
    transport(...args);
    return actual.httpTransport(...args);
  } };
});

let dir: string;
let db: Database.Database;
let a: number;
let b: number;
const post = (body: unknown = {}) => new Request("https://request.example/api/x", { method: "POST", body: JSON.stringify(body) });
const ctx = (slug: string) => ({ params: Promise.resolve({ slug }) });
function signIn(key = "owner", emailOnly = false) {
  auth.mockResolvedValue({ user: { id: String(fixtureUserId(key)), name: key,
    discordUserId: emailOnly ? null : fixtureDiscordId(key) } });
}
function seedTournament() {
  const tournaments = createTournamentService(db);
  const t = tournaments.create("g1", "Cup", "round_robin", fixtureUserId("owner"));
  db.prepare("update tournaments set web_slug = 'cup' where id = ?").run(t.id);
  tournaments.join(t.id, a);
  tournaments.join(t.id, b);
  return { tournaments, t };
}
function activeTournament() {
  const s = seedTournament();
  s.tournaments.start(s.t.id);
  const slot = db.prepare("select id from tournament_matches where tournament_id = ?").get(s.t.id) as { id: number };
  return { ...s, tmId: slot.id };
}
function expectAnnounces(enabled: boolean, kinds: string[]) {
  expect(announce.mock.calls.map(([payload]) => (payload as { kind: string }).kind)).toEqual(enabled ? kinds : []);
  expect(fetch).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("THEME_DRAFTS", "1");
  vi.clearAllMocks();
  dir = mkdtempSync(join(tmpdir(), "discord-off-"));
  vi.stubEnv("DATABASE_PATH", join(dir, "test.sqlite"));
  vi.stubEnv("DISCORD_GUILD_ID", "g1");
  vi.stubEnv("DISCORD_DEFAULT_CHANNEL_ID", "channel");
  vi.stubEnv("DISCORD_REMINDER_CHANNEL_ID", "");
  vi.stubEnv("DISCORD_TOKEN", "token");
  vi.stubEnv("BOT_ANNOUNCE_URL", "http://bot:4001");
  vi.stubEnv("BOT_ANNOUNCE_SECRET", "secret");
  vi.stubEnv("WEB_URL", "https://web.example/");
  vi.stubEnv("WS_INTERNAL_URL", "http://ws:4002");
  vi.stubEnv("WS_INTERNAL_SECRET", "ws-secret");
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 204 })));
  db = new Database(process.env.DATABASE_PATH!);
  migrate(db);
  seedFixtureUsers(db, ["owner", "a", "b"]);
  const player = db.prepare("insert into players (guild_id, user_id, discord_user_id, display_name) values ('g1', ?, ?, ?)");
  a = Number(player.run(fixtureUserId("a"), fixtureDiscordId("a"), "Alice").lastInsertRowid);
  b = Number(player.run(fixtureUserId("b"), fixtureDiscordId("b"), "Bob").lastInsertRowid);
  signIn();
});
afterEach(() => {
  vi.useRealTimers();
  db.close();
  rmSync(dir, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe.each([undefined, "0", "true", "1"])("Discord flag %s", flag => {
  const enabled = flag === "1";
  beforeEach(() => vi.stubEnv("DISCORD_BOT_ENABLED", flag));

  it("does not construct a bot transport while off, but keeps WS transport", async () => {
    const { announcer, broadcaster } = await vi.importActual<typeof import("@/lib/notify")>("@/lib/notify");
    expect(transport.mock.calls.map(([options]) => options.url)).toEqual(enabled ? ["http://ws:4002", "http://bot:4001"] : ["http://ws:4002"]);
    const result = await announcer.announce({ kind: "tournament-completed", tournamentId: 1 });
    expect(result).toEqual(enabled ? { ok: true } : { ok: false, error: "discord_disabled" });
    if (!enabled) expect(fetch).not.toHaveBeenCalled();
    await broadcaster.tournament({ kind: "completed", slug: "cup" });
    expect(fetch).toHaveBeenCalledWith("http://ws:4002/internal/tournament/completed", expect.anything());
  });

  it("channels are deliberately unavailable while off before token access", async () => {
    if (!enabled) vi.stubEnv("DISCORD_TOKEN", undefined);
    vi.mocked(fetch).mockResolvedValue(Response.json([{ id: "text", name: "general", type: 0 }, { id: "voice", type: 2 }]));
    const { GET } = await import("../app/api/discord/channels/route");
    const res = await GET();
    expect(res.status).toBe(enabled ? 200 : 404);
    expect(await res.json()).toEqual(enabled ? { channels: [{ id: "text", name: "general" }] } : { error: "discord_disabled" });
    expect(fetch).toHaveBeenCalledTimes(enabled ? 1 : 0);
  });

  it("the dedicated announce endpoint returns disabled instead of a delivery failure", async () => {
    seedTournament();
    const { POST } = await import("../app/api/tournaments/[slug]/announce/route");
    const res = await POST(post(), ctx("cup"));
    expect(res.status).toBe(enabled ? 200 : 404);
    expect(await res.json()).toEqual(enabled ? { success: true, channelId: "channel" } : { error: "discord_disabled" });
    expectAnnounces(enabled, ["tournament-created"]);
  });

  it.each(["theme", "booster"])("creates a %s draft for an email-only user and respects the Discord flag", async mode => {
    signIn("owner", true);
    db.prepare("update users set discord_user_id = null where id = ?").run(fixtureUserId("owner"));
    db.prepare("insert into card_catalog (ygoprodeck_id, name, type, frame_type, image_url, image_url_small, card_sets_json, cached_at) values (1, 'Card', 'Normal Monster', 'normal', 'image', 'image', '[]', ?)").run(new Date().toISOString());
    const { POST } = await import("../app/api/drafts/route");
    const config = mode === "theme" ? { mode: "theme", allowedCubeIds: [] } : { customCardIds: [1], packSize: 8, packsPerPlayer: 5 };
    const res = await POST(post({ name: "Draft", config }) as never);
    expect(res.status).toBe(201);
    expect(db.prepare("select channel_id from drafts").get()).toEqual({ channel_id: enabled ? "channel" : null });
    expectAnnounces(enabled, ["draft-created"]);
  });

  it.each(["theme", "booster"])("allows a %s draft without an explicit or default channel", async mode => {
    vi.stubEnv("DISCORD_DEFAULT_CHANNEL_ID", "");
    db.prepare("insert into card_catalog (ygoprodeck_id, name, type, frame_type, image_url, image_url_small, card_sets_json, cached_at) values (1, 'Card', 'Normal Monster', 'normal', 'image', 'image', '[]', ?)").run(new Date().toISOString());
    const { POST } = await import("../app/api/drafts/route");
    const config = mode === "theme" ? { mode: "theme", allowedCubeIds: [] } : { customCardIds: [1] };
    const res = await POST(post({ name: "Channel free", config }) as never);
    expect(res.status).toBe(201);
    expect(db.prepare("select channel_id from drafts").get()).toEqual({ channel_id: null });
    expect(announce).not.toHaveBeenCalled();
  });

  it("starts a draft and broadcasts its committed status", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    signIn("a");
    const drafts = createDraftService(db);
    const pool = Array.from({ length: 80 }, (_, i) => i + 1);
    const card = db.prepare("insert into card_catalog (ygoprodeck_id, name, type, frame_type, image_url, image_url_small, card_sets_json, cached_at) values (?, ?, 'Normal Monster', 'normal', 'image', 'image', '[]', ?)");
    for (const id of pool) card.run(id, `Card ${id}`, new Date().toISOString());
    const d = drafts.create("g1", "channel", "Draft", { cubeCardIds: pool, customCardIds: pool, cardsPerPlayer: 40, packSize: 8, packsPerPlayer: 5 }, fixtureUserId("a"), a);
    drafts.join(d.id, b);
    const lobby = createDraftLobbyService(db);
    lobby.setReady(d.id, fixtureUserId("a"), true);
    lobby.setReady(d.id, fixtureUserId("b"), true);
    const { POST, GET } = await import("../app/api/drafts/[slug]/route");
    const res = await POST(post(), ctx(d.webSlug!));
    expect(res.status).toBe(202);
    expect(drafts.findById(d.id).status).toBe("pending");
    expect(draft).not.toHaveBeenCalledWith({ kind: "status", slug: d.webSlug, status: "active" });
    expect(announce).not.toHaveBeenCalled();

    // The compatibility POST schedules; the deadline GET commits and notifies the start.
    const scheduled = await res.json();
    expect(scheduled.lobby.start.kind).toBe("manual");
    vi.setSystemTime(new Date(scheduled.lobby.start.startsAt));
    expect((await GET(post(), ctx(d.webSlug!))).status).toBe(200);
    expect(drafts.findById(d.id).status).toBe("active");
    expect(draft).toHaveBeenCalledWith({ kind: "status", slug: d.webSlug, status: "active" });
    // Refreshing the committed draft must not send another start announcement.
    expect((await GET(post(), ctx(d.webSlug!))).status).toBe(200);
    expect(draft.mock.calls.filter(([payload]) => payload.kind === "status")).toHaveLength(1);
    expectAnnounces(enabled, ["draft-started"]);
  });

  it("starts a tournament and broadcasts its committed status", async () => {
    const { t } = seedTournament();
    const { POST, GET } = await import("../app/api/tournaments/[slug]/route");
    const res = await POST(post(), ctx("cup"));
    expect(res.status).toBe(200);
    expect(db.prepare("select status from tournaments where id = ?").get(t.id)).toEqual({ status: "active" });
    expect(tournament).toHaveBeenCalledWith({ kind: "started", slug: "cup" });
    expect((await (await GET(post(), ctx("cup"))).json()).discordEnabled).toBe(enabled);
    expectAnnounces(enabled, ["tournament-started"]);
  });

  it.each(["approve", "deny"])("reports and %s resolves a match with WS updates", async resolution => {
    const { t, tmId } = activeTournament();
    signIn("a");
    const { POST: report } = await import("../app/api/tournaments/[slug]/report/route");
    const reported = await report(post({ tournamentMatchId: tmId, result: "win" }), ctx("cup"));
    expect(reported.status).toBe(200);
    const { matchId } = await reported.json();
    expect(db.prepare("select status from matches where id = ?").get(matchId)).toEqual({ status: "pending" });
    signIn("b");
    const { POST } = resolution === "approve" ? await import("../app/api/matches/[id]/approve/route") : await import("../app/api/matches/[id]/deny/route");
    expect((await POST(post(), { params: Promise.resolve({ id: String(matchId) }) })).status).toBe(200);
    expect(db.prepare("select status from matches where id = ?").get(matchId)).toEqual({ status: resolution === "approve" ? "approved" : "denied" });
    expect(tournament).toHaveBeenCalledTimes(2);
    expect(tournament).toHaveBeenCalledWith({ kind: "match-updated", slug: "cup" });
    if (resolution === "approve") expect(db.prepare("select status from tournaments where id = ?").get(t.id)).toEqual({ status: "completed" });
    expectAnnounces(enabled, resolution === "approve" ? ["match-report-pending", "match-resolved", "tournament-completed"] : ["match-report-pending", "match-resolved"]);
  });

  it.each(["complete", "result"])("%s completes a tournament and broadcasts without Discord", async action => {
    const { t, tmId } = activeTournament();
    const res = action === "complete"
      ? await (await import("../app/api/tournaments/[slug]/complete/route")).POST(post(), ctx("cup"))
      : await (await import("../app/api/tournaments/[slug]/matches/[tmId]/result/route")).POST(post({ winnerPlayerId: a }), { params: Promise.resolve({ slug: "cup", tmId: String(tmId) }) });
    expect(res.status).toBe(200);
    expect(db.prepare("select status from tournaments where id = ?").get(t.id)).toEqual({ status: "completed" });
    expect(tournament).toHaveBeenCalledWith({ kind: "completed", slug: "cup" });
    expectAnnounces(enabled, ["tournament-completed"]);
  });

  it("creates a duel challenge with a share link and keeps its WS update", async () => {
    signIn("a", true);
    const invite = vi.spyOn(await import("../src/lib/announce-bot"), "sendDuelInvite");
    const { POST } = await import("../app/api/duels/route");
    const res = await POST(post({ mode: "normal", opponentPlayerId: b }) as never);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.shareUrl).toBe(`https://web.example/duels/${body.session.slug}`);
    expect(body).not.toHaveProperty("notified");
    expect(duelChange).toHaveBeenCalledWith(body.session.slug, "g1");
    expect(db.prepare("select count(*) as n from duel_series").get()).toEqual({ n: 1 });
    expectAnnounces(enabled, ["duel-invite"]);
    expect(invite).toHaveBeenCalledTimes(enabled ? 1 : 0);
  });

  it("creates and reuses a tournament duel with a share link and WS updates", async () => {
    const { t, tmId } = activeTournament();
    db.prepare("update tournament_participants set deck_json = ? where tournament_id = ?").run(JSON.stringify({ main: [], extra: [], side: [] }), t.id);
    signIn("a");
    const invite = vi.spyOn(await import("../src/lib/announce-bot"), "announceDuelInvite");
    const { POST } = await import("../app/api/tournaments/[slug]/matches/[tmId]/duel/route");
    for (const status of [201, 200]) {
      const res = await POST(post(), { params: Promise.resolve({ slug: "cup", tmId: String(tmId) }) });
      expect(res.status).toBe(status);
      const body = await res.json();
      expect(body.shareUrl).toBe(`https://web.example/duels/${body.duel.slug}`);
      expect(body).not.toHaveProperty("notified");
      expect(duelChange).toHaveBeenCalledWith(body.duel.slug, "g1");
    }
    expect(tournament).toHaveBeenCalledTimes(2);
    expectAnnounces(enabled, ["duel-invite"]);
    expect(invite).toHaveBeenCalledTimes(enabled ? 1 : 0);
  });

  it("short circuits both invite helpers while off", async () => {
    const { sendDuelInvite, announceDuelInvite } = await import("../src/lib/announce-bot");
    const duel = createDuelService(db).create({ guildId: "g1", organizerPlayerId: a, name: "Invite fixture", mode: "normal" });
    const invite = { slug: duel.slug, guildId: "g1", opponentDiscordUserId: "123", challengerName: "A", duelName: "Room", bestOf: 1 as const, ranked: false, tournamentName: null };
    expect(await sendDuelInvite(invite)).toBe(enabled);
    expect(announceDuelInvite(invite)).toBe(enabled ? undefined : false);
    expect(announce).toHaveBeenCalledTimes(enabled ? 2 : 0);
  });
});

it("uses the request origin for share links when WEB_URL is missing", async () => {
  vi.stubEnv("WEB_URL", undefined);
  const { duelUrl } = await import("../src/lib/announce-bot");
  expect(duelUrl("room", post())).toBe("https://request.example/duels/room");
});
