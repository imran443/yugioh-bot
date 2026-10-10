import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { migrate } from "@yugidraft/shared/db";
import { createDraftService, createPlayerService, createUserService } from "@yugidraft/shared/services";
import { recordingTransport, createBroadcaster } from "@yugidraft/shared/notify";

const state = vi.hoisted(() => ({ actor: { userId: 1, discordUserId: null as string | null, userName: "Host" },
  authenticated: true, announce: vi.fn(), broadcast: vi.fn() }));
let db: Database.Database;
vi.mock("@/lib/db", () => ({ getDb: () => db }));
vi.mock("@/lib/env", () => ({ env: { discordGuildId: "g" } }));
vi.mock("@/lib/web-access", async () => {
  const { NextResponse } = await import("next/server");
  return { requireWebAccess: async () => state.authenticated ? { ok: true, ...state.actor }
    : { ok: false, response: NextResponse.json({ error: "unauthorized" }, { status: 401 }) } };
});
vi.mock("@/lib/notify", () => ({ broadcaster: { draft: state.broadcast }, announcer: { announce: state.announce } }));

beforeEach(() => {
  vi.stubEnv("OWNER_USER_IDS", "");
  db = new Database(":memory:"); migrate(db);
  const users = createUserService(db);
  for (const id of ["100000000000000001", "100000000000000002", "100000000000000003"]) users.ensureDiscord({ discordUserId: id, displayName: id });
  state.actor = { userId: 1, discordUserId: null, userName: "Host" };
  state.authenticated = true;
  state.announce.mockReset().mockResolvedValue({ ok: true });
  state.broadcast.mockReset().mockResolvedValue(undefined);
});
afterEach(() => { db.close(); vi.unstubAllEnvs(); });

function setup(status: "pending" | "active" = "active", guild = "g", channel: string | null = "c") {
  const players = createPlayerService(db);
  const host = players.findOrCreate(guild, 1, "Host");
  const guest = players.findOrCreate(guild, 2, "Guest");
  const drafts = createDraftService(db);
  const draft = drafts.create(guild, channel, "Emergency", { customCardIds: [1, 2, 3, 4], packSize: 2,
    packsPerPlayer: 1, cardsPerPlayer: 2 }, 1, host.id);
  drafts.join(draft.id, guest.id);
  db.exec(`insert into card_catalog (ygoprodeck_id,name,type,frame_type,image_url,image_url_small,card_sets_json,cached_at)
    values (1,'A','Normal Monster','normal','i','i','[]','t'),(2,'B','Normal Monster','normal','i','i','[]','t'),
    (3,'C','Normal Monster','normal','i','i','[]','t'),(4,'D','Normal Monster','normal','i','i','[]','t')`);
  if (status === "active") drafts.start(draft.id, new Date("2030-01-01"));
  return { draft, drafts, host, guest };
}
async function call(slug: string) {
  const { POST } = await import("../app/api/drafts/[slug]/cancel/route");
  return POST(new Request(`http://localhost/api/drafts/${slug}/cancel`, { method: "POST" }), { params: Promise.resolve({ slug }) });
}

describe("draft cancellation API", () => {
  it("allows the host to cancel and announces committed status", async () => {
    const { draft } = setup();
    const response = await call(draft.webSlug!);
    expect(response.status).toBe(200);
    const status = "cancelled";
    expect(await response.json()).toMatchObject({ id: draft.id, webSlug: draft.webSlug, status, changed: true, pickDeadlineAt: null, tournamentId: null });
    expect(state.broadcast).toHaveBeenCalledWith({ kind: "status", slug: draft.webSlug, status });
    expect(state.broadcast).toHaveBeenCalledWith({ kind: "resync", slug: draft.webSlug, packRound: 1, pickStep: 1 });
    expect(state.announce).toHaveBeenCalledWith({ kind: "draft-status", draftId: draft.id });
    expect(state.announce).toHaveBeenCalledTimes(1);
  });
  it("denies a seated non-host's cancellation with 403", async () => {
    const { draft, drafts } = setup(); state.actor.userId = 2; state.actor.discordUserId = "100000000000000002";
    expect((await call(draft.webSlug!)).status).toBe(403);
    expect(drafts.findById(draft.id).status).toBe("active");
    expect(state.broadcast).not.toHaveBeenCalled(); expect(state.announce).not.toHaveBeenCalled();
  });
  it("allows an unseated email-only owner to cancel a private draft", async () => {
    const { draft } = setup(); state.actor.userId = 3;
    vi.stubEnv("OWNER_USER_IDS", "3");
    expect((await call(draft.webSlug!)).status).toBe(200);
  });
  it("conceals a private draft from an unseated non-owner on cancellation", async () => {
    const { draft, drafts } = setup(); state.actor.userId = 3;
    const response = await call(draft.webSlug!);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Draft not found" });
    expect(drafts.findById(draft.id).status).toBe("active");
    expect(state.broadcast).not.toHaveBeenCalled(); expect(state.announce).not.toHaveBeenCalled();
  });
  it("returns 403 to a non-owner who can read an open lobby", async () => {
    const { draft } = setup("pending"); state.actor.userId = 3;
    db.prepare("update drafts set visibility = 'open' where id = ?").run(draft.id);
    expect((await call(draft.webSlug!)).status).toBe(403);
  });
  it("rejects unauthenticated cancellation", async () => {
    const { draft } = setup(); state.authenticated = false;
    expect((await call(draft.webSlug!)).status).toBe(401);
  });
  it("scopes cancellation lookup to the configured guild", async () => {
    const { draft } = setup("active", "foreign");
    state.actor.userId = 3; vi.stubEnv("OWNER_USER_IDS", "3");
    expect((await call(draft.webSlug!)).status).toBe(404);
    expect(state.broadcast).not.toHaveBeenCalled();
  });
  it("notifies only once for repeated cancellation", async () => {
    const { draft } = setup("pending");
    const first = await call(draft.webSlug!);
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ status: "cancelled", changed: true });
    const retry = await call(draft.webSlug!);
    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({ status: "cancelled", changed: false });
    expect(state.broadcast.mock.calls.map(([payload]) => payload)).toEqual([
      { kind: "status", slug: draft.webSlug, status: "cancelled" },
      { kind: "resync", slug: draft.webSlug, packRound: 0, pickStep: 0 },
    ]);
    expect(state.announce).toHaveBeenCalledTimes(1);
  });
  it("rejects cancellation of a naturally completed draft", async () => {
    const { draft, drafts, host, guest } = setup();
    for (let step = 0; step < 4 && drafts.findById(draft.id).status === "active"; step++) {
      for (const player of [host, guest]) drafts.pickCard(draft.id, player.id, drafts.pickOptions(draft.id, player.id)[0].id);
    }
    expect(drafts.findById(draft.id).status).toBe("completed");
    const conflict = await call(draft.webSlug!);
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ code: "DRAFT_ALREADY_FINISHED" });
    expect(drafts.findById(draft.id).status).toBe("completed");
    expect(state.broadcast).not.toHaveBeenCalled(); expect(state.announce).not.toHaveBeenCalled();
  });
  it("returns 403 for an email-only seated non-host", async () => {
    const { draft } = setup(); state.actor.userId = 2;
    expect((await call(draft.webSlug!)).status).toBe(403);
  });
  it("broadcasts through the existing signed broadcaster after discarding uneven picks", async () => {
    const { draft, drafts, host, guest } = setup();
    drafts.pickCard(draft.id, host.id, drafts.pickOptions(draft.id, host.id)[0].id);
    const rec = recordingTransport();
    const broadcaster = createBroadcaster(rec.transport);
    state.broadcast.mockImplementation(async payload => {
      expect(drafts.findById(draft.id).status).toBe("cancelled");
      expect(drafts.picks(draft.id)).toEqual([]);
      expect(drafts.pool(draft.id, host.id)).toHaveLength(0);
      expect(drafts.pool(draft.id, guest.id)).toHaveLength(0);
      await broadcaster.draft(payload);
    });
    expect((await call(draft.webSlug!)).status).toBe(200);
    expect(rec.calls).toEqual([
      { path: "/internal/draft/status", body: JSON.stringify({ slug: draft.webSlug, status: "cancelled" }) },
      { path: "/internal/draft/resync", body: JSON.stringify({ slug: draft.webSlug, packRound: 1, pickStep: 1 }) },
    ]);
  });
  it("keeps a committed result successful if notification transport throws", async () => {
    const { draft, drafts } = setup(); state.broadcast.mockRejectedValue(new Error("offline"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try { expect((await call(draft.webSlug!)).status).toBe(200); expect(drafts.findById(draft.id).status).toBe("cancelled"); }
    finally { warn.mockRestore(); }
  });
});
