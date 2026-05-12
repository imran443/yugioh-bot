import { describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import { createAnnounceServer } from "../../src/announce/server.js";

const secret = "shh";
function sign(body: string) {
  return "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
}

describe("announce server", () => {
  it("rejects requests without a valid signature", async () => {
    const handler = vi.fn();
    const app = createAnnounceServer({
      secret,
      handlers: { onDraftCreated: handler, onDraftStarted: handler, onDraftCompleted: handler, onTournamentCreated: handler, onTournamentStarted: handler },
    });
    const res = await app.handle(new Request("http://x/internal/announce/draft-created", {
      method: "POST",
      headers: { "content-type": "application/json", "x-announce-signature": "sha256=00" },
      body: "{}",
    }));
    expect(res.status).toBe(401);
    expect(handler).not.toHaveBeenCalled();
  });

  it("dispatches draft-created to the registered handler when signature matches", async () => {
    const onDraftCreated = vi.fn().mockResolvedValue(undefined);
    const app = createAnnounceServer({
      secret,
      handlers: {
        onDraftCreated,
        onDraftStarted: vi.fn(),
        onDraftCompleted: vi.fn(),
        onTournamentCreated: vi.fn(),
        onTournamentStarted: vi.fn(),
      },
    });
    const body = JSON.stringify({ draftId: 1, channelId: "c1", name: "Test", webSlug: "abcd1234" });
    const res = await app.handle(new Request("http://x/internal/announce/draft-created", {
      method: "POST",
      headers: { "content-type": "application/json", "x-announce-signature": sign(body) },
      body,
    }));
    expect(res.status).toBe(204);
    expect(onDraftCreated).toHaveBeenCalledWith({ draftId: 1, channelId: "c1", name: "Test", webSlug: "abcd1234" });
  });
});
