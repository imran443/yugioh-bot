import { describe, it, expect } from "vitest";
import { recordingTransport, type SignedPostTransport } from "../../src/notify/signed-post.js";
import { createAnnouncer } from "../../src/notify/announcer.js";

describe("createAnnouncer", () => {
  it("posts kind in the path and strips it from the body", async () => {
    const rec = recordingTransport();
    const announcer = createAnnouncer(rec.transport);

    const res = await announcer.announce({
      kind: "draft-created", draftId: 7, channelId: "c1", name: "Friday", webSlug: "abcd",
    });

    expect(res).toEqual({ ok: true });
    expect(rec.calls).toEqual([
      { path: "/internal/announce/draft-created", body: JSON.stringify({ draftId: 7, channelId: "c1", name: "Friday", webSlug: "abcd" }) },
    ]);
  });

  it("returns ok:false with a descriptive error on non-2xx", async () => {
    const transport: SignedPostTransport = {
      async post() { return { ok: false, status: 503, text: "down" }; },
    };
    const announcer = createAnnouncer(transport);
    const res = await announcer.announce({ kind: "tournament-completed", tournamentId: 3 });
    expect(res).toEqual({ ok: false, error: "Bot responded 503: down" });
  });
});
