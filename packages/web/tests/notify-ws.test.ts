import { describe, expect, it, vi } from "vitest";
import { notifyWs } from "../src/lib/notify-ws";

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

describe("notifyWs", () => {
  it("posts a signed body to the right path for status", async () => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    await notifyWs(
      { url: "http://ws:4002", secret: "shh" },
      { kind: "status", slug: "abc", status: "active" },
    );
    expect(fetchMock).toHaveBeenCalledOnce();
    const [calledUrl, init] = fetchMock.mock.calls[0];
    expect(calledUrl).toBe("http://ws:4002/internal/draft/status");
    expect(init?.headers?.["x-announce-signature"]).toMatch(/^sha256=[a-f0-9]+$/);
    expect(init?.body).toContain("\"slug\":\"abc\"");
    expect(init?.body).toContain("\"status\":\"active\"");
  });

  it("posts pick payload", async () => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    await notifyWs(
      { url: "http://ws:4002", secret: "shh" },
      { kind: "pick", slug: "abc", playerId: 5, packRound: 1, pickStep: 2 },
    );
    const [calledUrl, init] = fetchMock.mock.calls[0];
    expect(calledUrl).toBe("http://ws:4002/internal/draft/pick");
    expect(init?.body).toContain("\"playerId\":5");
  });

  it("posts resync payload", async () => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    await notifyWs(
      { url: "http://ws:4002", secret: "shh" },
      { kind: "resync", slug: "abc", packRound: 2, pickStep: 1 },
    );
    expect(fetchMock.mock.calls[0][0]).toBe("http://ws:4002/internal/draft/resync");
  });

  it("posts complete payload", async () => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    await notifyWs(
      { url: "http://ws:4002", secret: "shh" },
      { kind: "complete", slug: "abc" },
    );
    expect(fetchMock.mock.calls[0][0]).toBe("http://ws:4002/internal/draft/complete");
  });

  it("does nothing when url or secret is empty", async () => {
    fetchMock.mockReset();
    await notifyWs({ url: "", secret: "shh" }, { kind: "status", slug: "a", status: "active" });
    expect(fetchMock).not.toHaveBeenCalled();
    await notifyWs({ url: "http://ws:4002", secret: "" }, { kind: "status", slug: "a", status: "active" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("swallows network errors and logs (does not throw)", async () => {
    fetchMock.mockReset();
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));
    await expect(
      notifyWs({ url: "http://ws:4002", secret: "shh" }, { kind: "status", slug: "a", status: "active" }),
    ).resolves.toBeUndefined();
  });
});
