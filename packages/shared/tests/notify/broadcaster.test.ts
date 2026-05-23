import { describe, it, expect } from "vitest";
import { recordingTransport } from "../../src/notify/signed-post.js";
import { createBroadcaster } from "../../src/notify/broadcaster.js";

describe("createBroadcaster", () => {
  it("routes draft payloads to /internal/draft/<kind>, kind out of body", async () => {
    const rec = recordingTransport();
    const b = createBroadcaster(rec.transport);

    await b.draft({ kind: "pick", slug: "abc", playerId: 5, packRound: 1, pickStep: 2 });

    expect(rec.calls).toEqual([
      { path: "/internal/draft/pick", body: JSON.stringify({ slug: "abc", playerId: 5, packRound: 1, pickStep: 2 }) },
    ]);
  });

  it("routes tournament payloads to /internal/tournament/<kind>", async () => {
    const rec = recordingTransport();
    const b = createBroadcaster(rec.transport);

    await b.tournament({ kind: "match-updated", slug: "xyz" });

    expect(rec.calls).toEqual([
      { path: "/internal/tournament/match-updated", body: JSON.stringify({ slug: "xyz" }) },
    ]);
  });
});
