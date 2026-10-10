import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { migrate } from "@yugidraft/shared/db";
import { verifyTournamentRoomToken } from "@yugidraft/shared/ws";

const state = vi.hoisted(() => ({ db: null as Database.Database | null, signedIn: false, secret: "test-secret" }));
vi.mock("@/lib/db", () => ({ getDb: () => state.db! }));
vi.mock("@/lib/env", () => ({ env: { discordGuildId: "guild-1", get wsInternalSecret() { return state.secret; } } }));
vi.mock("@/lib/session-identity", () => ({ resolveSessionIdentity: async () => state.signedIn
  ? { ok: true, identity: { userId: 101, discordUserId: null, name: "Yugi" } }
  : { ok: false, status: 401 } }));
vi.mock("@/lib/notify", () => ({ broadcaster: { tournament: vi.fn() }, announcer: { announce: vi.fn() } }));

const routes = {
  detail: () => import("../app/api/tournaments/[slug]/route"),
  standings: () => import("../app/api/tournaments/[slug]/standings/route"),
  connection: () => import("../app/api/tournaments/[slug]/connection/route"),
  deck: () => import("../app/api/tournaments/[slug]/deck/route"),
};
async function get(kind: keyof typeof routes, slug: string) {
  const { GET } = await routes[kind]();
  return GET(new Request(`http://localhost/api/tournaments/${slug}`) as never, { params: Promise.resolve({ slug }) });
}
describe("tournament read authorization", () => {
  beforeEach(() => {
    state.signedIn = false; state.secret = "test-secret";
    state.db = new Database(":memory:");
    migrate(state.db);
    state.db.exec("insert into users(id,username,display_name) values(101,'yugi','Yugi'); insert into tournaments(guild_id,name,format,status,created_by_user_id,web_slug) values('guild-1','Cup','round_robin','pending',101,'cup'), ('other-guild','Other','round_robin','pending',101,'other-cup')");
  });
  afterEach(() => { state.db!.close(); vi.restoreAllMocks(); });
  it("requires auth on the tournament list", async () => {
    const { GET } = await import("../app/api/tournaments/route");
    const response = await GET(new Request("http://localhost/api/tournaments"));
    expect(response.status).toBe(401);
  });
  for (const kind of Object.keys(routes) as (keyof typeof routes)[]) {
    it.each(["cup", "missing", "other-cup"])(`${kind}: signed-out reads always return 401 for %s`, async (slug) => {
      expect((await get(kind, slug)).status).toBe(401);
    });
    it.each(["missing", "other-cup"])(`${kind}: signed-in reads hide unavailable slugs: %s`, async (slug) => {
      state.signedIn = true;
      expect((await get(kind, slug)).status).toBe(404);
    });
  }
  it.each(["detail", "standings", "connection"] as const)("%s honors a denial from the shared access policy", async (kind) => {
    state.signedIn = true;
    const services = await import("@yugidraft/shared/services");
    vi.spyOn(services, "findTournamentReadAccess").mockReturnValue({ id: 1, status: "pending", visibility: "private", isParticipant: false, canRead: false, canJoin: false });
    expect((await get(kind, "cup")).status).toBe(404);
  });
  it("authenticates before touching an unavailable database", async () => {
    vi.spyOn(state.db!, "prepare").mockImplementation(() => { throw new Error("DB unavailable"); });
    for (const kind of Object.keys(routes) as (keyof typeof routes)[]) expect((await get(kind,"cup")).status).toBe(401);
    const { GET } = await import("../app/api/tournaments/route");
    expect((await GET(new Request("http://localhost/api/tournaments"))).status).toBe(401);
  });
  it("returns 503 when signing is unavailable after the read access check", async () => {
    state.signedIn = true; state.secret = "";
    expect((await get("connection", "cup")).status).toBe(503);
    expect((await get("connection", "missing")).status).toBe(404);
  });
  it("issues a short-lived tournament token for the configured guild and user", async () => {
    state.signedIn = true;
    const now = Date.now();
    const response = await get("connection", "cup");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const data = await response.json();
    expect(data.userId).toBe(101);
    expect(data.expiresAt).toBeGreaterThan(now);
    expect(data.expiresAt).toBeLessThanOrEqual(Date.now() + 60_000);
    expect(verifyTournamentRoomToken(data.token, "test-secret", { slug: "cup", userId: 101 }))
      .toEqual({ slug: "cup", guildId: "guild-1", userId: 101, expiresAt: data.expiresAt });
  });
});
