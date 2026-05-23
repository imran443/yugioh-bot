import { describe, it, expect, vi, afterEach } from "vitest";
import { createHmac } from "node:crypto";
import { httpTransport, recordingTransport } from "../../src/notify/signed-post.js";

afterEach(() => vi.restoreAllMocks());

describe("httpTransport", () => {
  it("signs the body and posts to url+path", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    const t = httpTransport({ url: "http://ws:4002", secret: "s3cret" });

    const res = await t.post("/internal/draft/pick", JSON.stringify({ slug: "abc" }));

    expect(res.ok).toBe(true);
    const [calledUrl, init] = fetchMock.mock.calls[0];
    expect(calledUrl).toBe("http://ws:4002/internal/draft/pick");
    const expectedSig = "sha256=" + createHmac("sha256", "s3cret").update(JSON.stringify({ slug: "abc" })).digest("hex");
    expect((init.headers as Record<string, string>)["x-announce-signature"]).toBe(expectedSig);
  });

  it("returns ok:false without throwing when not configured", async () => {
    const t = httpTransport({ url: "", secret: "" });
    const res = await t.post("/internal/draft/pick", "{}");
    expect(res).toEqual({ ok: false, status: 0, text: "not configured" });
  });

  it("returns ok:false on network error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("boom")));
    const t = httpTransport({ url: "http://ws", secret: "x" });
    const res = await t.post("/p", "{}");
    expect(res).toEqual({ ok: false, status: 0, text: "boom" });
  });
});

describe("recordingTransport", () => {
  it("records calls and reports ok", async () => {
    const rec = recordingTransport();
    await rec.transport.post("/internal/announce/draft-created", '{"draftId":1}');
    expect(rec.calls).toEqual([{ path: "/internal/announce/draft-created", body: '{"draftId":1}' }]);
  });
});
