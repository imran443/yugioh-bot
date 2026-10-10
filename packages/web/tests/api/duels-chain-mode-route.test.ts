import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const host = vi.hoisted(() => ({ requireDuelActor: vi.fn(), callDuelHost: vi.fn(), duelErrorResponse: vi.fn() }));
vi.mock("@/lib/duel-host", async original => ({
  ...await original<typeof import("../../src/lib/duel-host")>(), ...host,
}));
import { POST } from "../../app/api/duels/[slug]/chain-mode/route";

const request = (body: unknown) => new NextRequest("http://test/api/duels/t/chain-mode", {
  method: "POST", body: typeof body === "string" ? body : JSON.stringify(body),
});
const params = { params: Promise.resolve({ slug: "t" }) };

function actor(room: () => unknown = () => ({ session: { status: "active" } })) {
  host.requireDuelActor.mockResolvedValue({ ok: true, guildId: "g", playerId: 7, duels: { room } });
}

describe("POST /api/duels/[slug]/chain-mode", () => {
  beforeEach(() => vi.resetAllMocks());

  it.each(["auto", "always", "off"])("forwards %s to the duel host for the caller's own seat", async (mode) => {
    actor();
    host.callDuelHost.mockResolvedValue({ ok: true, data: { engine: { chainMode: mode } } });
    const response = await POST(request({ mode }), params);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ engine: { chainMode: mode } });
    expect(host.callDuelHost).toHaveBeenCalledWith({ op: "chain-mode", slug: "t", guildId: "g", playerId: 7, chainMode: mode });
  });

  it("answers the auth failure of requireDuelActor", async () => {
    host.requireDuelActor.mockResolvedValue({ ok: false, response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) });
    expect((await POST(request({ mode: "off" }), params)).status).toBe(401);
    expect(host.callDuelHost).not.toHaveBeenCalled();
  });

  it.each([{ mode: "sometimes" }, { mode: 1 }, {}, null, "[]", "not json"])("rejects %j without asking the host", async (body) => {
    actor();
    const response = await POST(request(body), params);
    expect(response.status).toBe(400);
    expect(host.callDuelHost).not.toHaveBeenCalled();
  });

  it("lets a failed room lookup answer through duelErrorResponse", async () => {
    actor(() => { throw new Error("Duel not found"); });
    host.duelErrorResponse.mockReturnValue(NextResponse.json({ error: "Duel not found" }, { status: 404 }));
    const response = await POST(request({ mode: "off" }), params);
    expect(response.status).toBe(404);
    expect(host.callDuelHost).not.toHaveBeenCalled();
  });

  it("passes a host refusal on with its status and message", async () => {
    actor();
    host.callDuelHost.mockResolvedValue({ ok: false, response: NextResponse.json({ error: "This duel has reached its limit" }, { status: 409 }) });
    const response = await POST(request({ mode: "off" }), params);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "This duel has reached its limit" });
  });
});
