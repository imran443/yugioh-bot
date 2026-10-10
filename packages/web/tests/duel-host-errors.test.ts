import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/session-identity", async () => {
  const { sessionFixture } = await import("./fixtures/session");
  return sessionFixture((() => ({ auth: vi.fn() }))().auth);
});

const call = { op: "validate-deck" as const, slug: "abc", guildId: "guild-1", playerId: 1 };

async function loadHost() {
  // env binds process.env at module load.
  return import("../src/lib/duel-host");
}

describe("callDuelHost error messages", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.spyOn(console, "error").mockImplementation(() => {});
    process.env.DUEL_INTERNAL_URL = "http://duel.test:4003";
    process.env.DUEL_INTERNAL_SECRET = "s3cret";
  });

  afterEach(() => {
    delete process.env.DUEL_INTERNAL_URL;
    delete process.env.DUEL_INTERNAL_SECRET;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("names the missing secret instead of 'not configured'", async () => {
    process.env.DUEL_INTERNAL_SECRET = "";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { callDuelHost } = await loadHost();

    const result = await callDuelHost(call);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.response.status).toBe(503);
    const body = (await result.response.json()) as { error: string };
    expect(body.error).toContain("DUEL_INTERNAL_SECRET is missing");
    expect(body.error).not.toBe("not configured");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("says the engine did not answer when the host is down", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));
    const { callDuelHost } = await loadHost();

    const result = await callDuelHost(call);
    if (result.ok) throw new Error("expected failure");
    expect(result.response.status).toBe(503);
    const body = (await result.response.json()) as { error: string };
    expect(body.error).toMatch(/did not answer \(fetch failed\)/);
  });

  it("explains a secret mismatch instead of passing the host's 401 through", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ error: "Unauthorized" }, { status: 401 })));
    const { callDuelHost } = await loadHost();

    const result = await callDuelHost(call);
    if (result.ok) throw new Error("expected failure");
    expect(result.response.status).toBe(503);
    const body = (await result.response.json()) as { error: string };
    expect(body.error).toContain("do not match");
  });

  it("keeps the host's own error text for rule errors", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ error: "Decks are locked after the duel starts" }, { status: 409 })));
    const { callDuelHost } = await loadHost();

    const result = await callDuelHost(call);
    if (result.ok) throw new Error("expected failure");
    expect(result.response.status).toBe(409);
    expect(await result.response.json()).toEqual({ error: "Decks are locked after the duel starts" });
  });

  it("keeps the seat-left code and text for duel answers", async () => {
    const body = { code: "seat_left", error: "That player has left. Pick again." };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(body, { status: 400 })));
    const { callDuelHost } = await loadHost();
    const result = await callDuelHost({ ...call, op: "respond" });
    if (result.ok) throw new Error("expected failure");
    expect(result.response.status).toBe(400);
    expect(await result.response.json()).toEqual(body);
  });

  it("keeps the old response for a normal invalid answer", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ error: "Invalid answer" }, { status: 400 })));
    const { callDuelHost } = await loadHost();
    const result = await callDuelHost({ ...call, op: "respond" });
    if (result.ok) throw new Error("expected failure");
    expect(result.response.status).toBe(400);
    expect(await result.response.json()).toEqual({ error: "Invalid answer" });
  });

  it("preserves a restart as a retryable 503 for duel answers", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ error: "restarting" }, { status: 503 })));
    const { callDuelHost } = await loadHost();
    const result = await callDuelHost({ ...call, op: "respond" });
    if (result.ok) throw new Error("expected failure");
    expect(result.response.status).toBe(503);
    expect(await result.response.json()).toEqual({ error: "restarting" });
  });

  it("preserves an unexpected host failure as a 500 for duel answers", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ error: "Duel server error" }, { status: 500 })));
    const { callDuelHost } = await loadHost();
    const result = await callDuelHost({ ...call, op: "respond" });
    if (result.ok) throw new Error("expected failure");
    expect(result.response.status).toBe(500);
    expect(await result.response.json()).toEqual({ error: "Duel server error" });
  });

  it.each(["view", "respond"] as const)("the room %s route surfaces a restart as 503", async op => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ error: "restarting" }, { status: 503 })));
    const host = await loadHost();
    vi.spyOn(host, "requireDuelActor").mockResolvedValue({
      ok: true, guildId: call.guildId, playerId: call.playerId, userId: 7,
      duels: { room: () => ({ session: { status: "active" } }) } as never,
    });
    const context = { params: Promise.resolve({ slug: call.slug }) };
    let response: Response;
    if (op === "view") {
      const { GET } = await import("../app/api/duels/[slug]/route");
      response = await GET(new Request("http://web.test/api/duels/abc"), context);
    } else {
      const { NextRequest } = await import("next/server");
      const { POST } = await import("../app/api/duels/[slug]/actions/route");
      response = await POST(new NextRequest("http://web.test/api/duels/abc/actions", { method: "POST", body: "{}" }), context);
    }
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "restarting" });
  });

  it("transports the spectator view flag to the authenticated host", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => Response.json({ role: "spectator", mySeat: null }));
    vi.stubGlobal("fetch", fetchMock);
    const { callDuelHost } = await loadHost();
    await callDuelHost({ ...call, op: "view", spectate: true });
    const request = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(JSON.parse(request.body as string)).toMatchObject({ op: "view", spectate: true });
    await callDuelHost({ ...call, op: "view" });
    expect(JSON.parse((fetchMock.mock.calls[1]![1] as RequestInit).body as string)).not.toHaveProperty("spectate");
  });

  it("carries the application user ID for the host mapping check", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    const { callDuelHost } = await loadHost();
    await callDuelHost({ ...call, userId: 7 });
    const payload = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    expect(payload).toMatchObject({ guildId: call.guildId, playerId: call.playerId, userId: 7 });
    expect(payload).not.toHaveProperty("isOwner");
  });
});

it("transports draft pool context and artwork-preserving normalization", async () => {
  process.env.DUEL_INTERNAL_URL = "http://duel.test";
  process.env.DUEL_INTERNAL_SECRET = "secret";
  vi.resetModules();
  const fetchMock = vi.fn(async (_url: unknown, _init: RequestInit) => Response.json({ codes: {} }));
  vi.stubGlobal("fetch", fetchMock);
  try {
    const { callDuelHost } = await loadHost();
    await callDuelHost({ ...call, op: "check-deck", draftId: 7 });
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body as string)).toMatchObject({ draftId: 7 });
    await callDuelHost({ ...call, op: "normalize-codes", codes: [10], preserveArtwork: true });
    expect(JSON.parse(fetchMock.mock.calls[1]![1].body as string)).toMatchObject({ preserveArtwork: true, codes: [10] });
  } finally { vi.unstubAllGlobals(); delete process.env.DUEL_INTERNAL_URL; delete process.env.DUEL_INTERNAL_SECRET; }
});
