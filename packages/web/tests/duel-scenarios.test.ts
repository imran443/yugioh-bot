import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const actor = { ok: true as const, guildId: "g1", playerId: 7, duels: { room: vi.fn() } };
const callDuelHost = vi.fn();

vi.mock("../app/(app)/duels/dev-presets/dev-presets", () => ({ DevPresets: () => null }));

vi.mock("@/lib/session-identity", async () => {
  const { sessionFixture } = await import("./fixtures/session");
  return sessionFixture((() => ({ auth: vi.fn() }))().auth);
});

vi.mock("@/lib/duel-host", async () => {
  const real = await vi.importActual<typeof import("@/lib/duel-host")>("@/lib/duel-host");
  return {
    ...real,
    requireDuelActor: vi.fn(async () => actor),
    callDuelHost,
  };
});

const ctx = { params: Promise.resolve({ slug: "abc" }) };
const post = (body: unknown) => new Request("http://x", { method: "POST", body: JSON.stringify(body) });

describe("duel scenario routes", () => {
  beforeEach(() => {
    callDuelHost.mockReset();
    actor.duels.room.mockReset();
  });
  afterEach(() => vi.unstubAllEnvs());

  describe("gate off", () => {
    it("404s every route", async () => {
      const preset = await import("../app/api/duels/preset/route");
      const report = await import("../app/api/duels/[slug]/report/route");
      expect((await preset.GET()).status).toBe(404);
      expect((await preset.POST(post({ presetId: "a" }))).status).toBe(404);
      expect((await report.GET(new Request("http://x"), ctx)).status).toBe(404);
      expect((await report.POST(post({ note: "x" }), ctx)).status).toBe(404);
      expect(callDuelHost).not.toHaveBeenCalled();
    });

    it("404s the page", async () => {
      const { default: Page } = await import("../app/(app)/duels/dev-presets/page");
      expect(() => Page()).toThrow();
      vi.stubEnv("DUEL_SCENARIOS", "1");
      expect(() => Page()).not.toThrow();
    });
  });

  describe("gate on", () => {
    beforeEach(() => vi.stubEnv("DUEL_SCENARIOS", "1"));

    it("lists presets from the host", async () => {
      callDuelHost.mockResolvedValue({ ok: true, data: { presets: [{ id: "p" }] } });
      const { GET } = await import("../app/api/duels/preset/route");
      const res = await GET();
      expect(await res.json()).toEqual({ presets: [{ id: "p" }], core: { tag: null, sha: null } });
      expect(callDuelHost.mock.calls[0][0]).toMatchObject({ op: "list-presets" });
    });

    it("passes the core and the per-preset issues through", async () => {
      const issues = [{ sig: "abc123", title: "Known trap", owner: "T3" }];
      callDuelHost.mockResolvedValue({ ok: true, data: { presets: [{ id: "p", issues }], core: { tag: "B2", sha: "f".repeat(64) } } });
      const { GET } = await import("../app/api/duels/preset/route");
      expect(await (await GET()).json()).toEqual({ presets: [{ id: "p", issues }], core: { tag: "B2", sha: "f".repeat(64) } });
    });

    it("starts a preset and returns the slug", async () => {
      callDuelHost.mockResolvedValue({ ok: true, data: { session: { slug: "room-1" } } });
      const { POST } = await import("../app/api/duels/preset/route");
      const res = await POST(post({ presetId: "p1" }));
      expect(await res.json()).toEqual({ slug: "room-1" });
      expect(callDuelHost.mock.calls[0][0]).toMatchObject({ op: "start-preset", presetId: "p1", playerId: 7 });
    });

    it("passes four seed numbers to the host as decimal strings", async () => {
      callDuelHost.mockResolvedValue({ ok: true, data: { slug: "room-2" } });
      const { POST } = await import("../app/api/duels/preset/route");
      const res = await POST(post({ presetId: "p1", seed: [1, "22", 3, "4"] }));
      expect(res.status).toBe(200);
      expect(callDuelHost.mock.calls[0][0]).toMatchObject({ op: "start-preset", seed: ["1", "22", "3", "4"] });
    });

    it("spreads one seed number into four and sends no seed when none is given", async () => {
      callDuelHost.mockResolvedValue({ ok: true, data: { slug: "room-3" } });
      const { POST } = await import("../app/api/duels/preset/route");
      await POST(post({ presetId: "p1", seed: 5 }));
      expect(callDuelHost.mock.calls[0][0].seed).toEqual(["5", "36", "67", "158"]);
      await POST(post({ presetId: "p1" }));
      expect(callDuelHost.mock.calls[1][0]).not.toHaveProperty("seed");
    });

    it("rejects a bad seed", async () => {
      const { POST } = await import("../app/api/duels/preset/route");
      expect((await POST(post({ presetId: "p1", seed: [1, 2, 3] }))).status).toBe(400);
      expect((await POST(post({ presetId: "p1", seed: "abc" }))).status).toBe(400);
      expect((await POST(post({ presetId: "p1", seed: -1 }))).status).toBe(400);
      expect(callDuelHost).not.toHaveBeenCalled();
    });

    it("rejects a missing presetId", async () => {
      const { POST } = await import("../app/api/duels/preset/route");
      expect((await POST(post({}))).status).toBe(400);
    });

    it("saves a report and returns the folder", async () => {
      callDuelHost.mockResolvedValue({ ok: true, data: { path: "/tmp/r1" } });
      const { POST } = await import("../app/api/duels/[slug]/report/route");
      const res = await POST(post({ note: "bad chain" }), ctx);
      expect(await res.json()).toEqual({ path: "/tmp/r1", attachments: "none" });
      expect(callDuelHost.mock.calls[0][0]).toMatchObject({ op: "report", slug: "abc", note: "bad chain" });
    });

    it("passes the host's partial flag through", async () => {
      callDuelHost.mockResolvedValue({ ok: true, data: { path: "/tmp/r2", partial: true } });
      const { POST } = await import("../app/api/duels/[slug]/report/route");
      const res = await POST(post({ note: "stuck" }), ctx);
      expect(await res.json()).toEqual({ path: "/tmp/r2", attachments: "none", partial: true });
    });

    it("rejects a non-text note", async () => {
      const { POST } = await import("../app/api/duels/[slug]/report/route");
      expect((await POST(post({ note: 5 }), ctx)).status).toBe(400);
    });

    it("reports enabled on GET", async () => {
      const { GET } = await import("../app/api/duels/[slug]/report/route");
      expect((await GET(new Request("http://x"), ctx)).status).toBe(200);
    });
  });
});
