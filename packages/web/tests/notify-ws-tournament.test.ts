import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { notifyWsTournament } from "../src/lib/notify-ws-tournament";

describe("notifyWsTournament", () => {
  const fetchSpy = vi.fn();
  beforeEach(() => {
    fetchSpy.mockReset();
    fetchSpy.mockResolvedValue({ ok: true } as any);
    vi.stubGlobal("fetch", fetchSpy);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("POSTs to the kind-specific internal route with a signed body", async () => {
    await notifyWsTournament(
      { url: "http://ws:4002", secret: "shh" },
      { kind: "participant-joined", slug: "abc", playerId: 7, displayName: "Alice" },
    );
    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe("http://ws:4002/internal/tournament/participant-joined");
    expect((init as any).headers["x-announce-signature"]).toMatch(/^sha256=/);
    const body = JSON.parse((init as any).body as string);
    expect(body).toEqual({ slug: "abc", playerId: 7, displayName: "Alice" });
  });

  it("is a no-op when url or secret is empty", async () => {
    await notifyWsTournament({ url: "", secret: "shh" }, { kind: "started", slug: "a" });
    await notifyWsTournament({ url: "http://ws", secret: "" }, { kind: "started", slug: "a" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
