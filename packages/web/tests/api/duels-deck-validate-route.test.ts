import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const host = vi.hoisted(() => ({ requireDuelActor: vi.fn(), callDuelHost: vi.fn(), duelErrorResponse: vi.fn() }));
vi.mock("@/lib/duel-host", () => host);
import { POST } from "../../app/api/duels/[slug]/deck/validate/route";

const formats = ["1v1", "tag", "ffa3", "ffa4"];
const request = () => new NextRequest("http://test/api/duels/t/deck/validate", {
  method: "POST", body: JSON.stringify({ main: [] }),
});
const params = { params: Promise.resolve({ slug: "t" }) };

function actor(format: string, status = "lobby") {
  const session = { format, status };
  host.requireDuelActor.mockResolvedValue({
    ok: true, guildId: "g", playerId: 1,
    duels: { room: () => ({ session }) },
  });
  return session;
}

describe("lobby deck validation lifecycle", () => {
  beforeEach(() => vi.resetAllMocks());

  it.each(formats)("skips the %s host check after the room leaves lobby", async (format) => {
    actor(format, "active");
    const response = await POST(request(), params);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ skipped: true });
    expect(host.callDuelHost).not.toHaveBeenCalled();
  });

  it.each(formats)("discards a %s check when the room starts during validation", async (format) => {
    const session = actor(format);
    host.callDuelHost.mockImplementation(async () => {
      session.status = "active";
      return { ok: false, response: NextResponse.json({ error: "Any host wording" }, { status: 409 }) };
    });
    const response = await POST(request(), params);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ skipped: true });
  });

  it("also discards a successful report when the room starts during validation", async () => {
    const session = actor("ffa3");
    host.callDuelHost.mockImplementation(async () => {
      session.status = "active";
      return { ok: true, data: { issues: [] } };
    });
    expect(await (await POST(request(), params)).json()).toEqual({ skipped: true });
  });

  it("preserves every validation conflict while the room is still a lobby", async () => {
    actor("ffa3");
    host.callDuelHost.mockResolvedValue({ ok: false, response: NextResponse.json({ error: "Decks are locked after the duel starts" }, { status: 409 }) });
    const response = await POST(request(), params);
    expect(response.status).toBe(409);
  });

  it("returns a normal report while the room is a lobby", async () => {
    actor("1v1");
    host.callDuelHost.mockResolvedValue({ ok: true, data: { issues: [] } });
    expect(await (await POST(request(), params)).json()).toEqual({ issues: [] });
  });

  it("passes the Domain Spell/Trap Deck Master issue to the room editor", async () => {
    actor("1v1");
    const report = { issues: [{
      message: "You can't use a Spell or Trap as your Deck Master.",
      cards: [{ section: "deckMaster", index: 0, code: 55144522, name: "Pot of Greed" }],
    }] };
    host.callDuelHost.mockResolvedValue({ ok: true, data: report });
    const response = await POST(request(), params);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(report);
  });
});
