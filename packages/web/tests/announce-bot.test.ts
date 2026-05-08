import { describe, expect, it, vi } from "vitest";
import { announceToBot } from "../src/lib/announce-bot";

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

describe("announceToBot", () => {
  it("posts a signed body to the right path", async () => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    await announceToBot(
      { url: "http://bot:4001", secret: "shh" },
      { kind: "draft-created", draftId: 1, channelId: "c1", name: "Test", webSlug: "ab12cd34" },
    );
    expect(fetchMock).toHaveBeenCalledOnce();
    const [calledUrl, init] = fetchMock.mock.calls[0];
    expect(calledUrl).toBe("http://bot:4001/internal/announce/draft-created");
    expect(init?.headers?.["x-announce-signature"]).toMatch(/^sha256=[a-f0-9]+$/);
    expect(init?.body).toContain("ab12cd34");
  });

  it("does nothing when url or secret is empty", async () => {
    fetchMock.mockReset();
    await announceToBot({ url: "", secret: "shh" }, { kind: "draft-created", draftId: 1, channelId: "c", name: "T", webSlug: "x" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("swallows network errors and logs (does not throw)", async () => {
    fetchMock.mockReset();
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));
    await expect(
      announceToBot({ url: "http://bot:4001", secret: "shh" }, { kind: "draft-started", draftId: 1, channelId: "c", name: "T", webSlug: "x" }),
    ).resolves.toBeUndefined();
  });
});
