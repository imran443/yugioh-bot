import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createAnnounceServer } from "../../src/announce/server.js";

function sign(body: string, secret: string) {
  return "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
}

describe("announce server new routes", () => {
  it("dispatches match-report-pending and match-resolved", async () => {
    const onMatchReportPending = vi.fn(async () => {});
    const onMatchResolved = vi.fn(async () => {});
    const server = createAnnounceServer({
      secret: "s",
      handlers: {
        onDraftCreated: vi.fn(),
        onDraftStarted: vi.fn(),
        onDraftCompleted: vi.fn(),
        onTournamentCreated: vi.fn(),
        onTournamentStarted: vi.fn(),
        onMatchReportPending,
        onMatchResolved,
      },
    });
    const body1 = JSON.stringify({ matchId: 1 });
    const res1 = await server.handle(
      new Request("http://x/internal/announce/match-resolved", {
        method: "POST",
        body: body1,
        headers: { "x-announce-signature": sign(body1, "s") },
      }),
    );
    expect(res1.status).toBe(204);
    expect(onMatchResolved).toHaveBeenCalledWith({ matchId: 1 });

    const body2 = JSON.stringify({ guildId: "g", matchId: 2 });
    const res2 = await server.handle(
      new Request("http://x/internal/announce/match-report-pending", {
        method: "POST",
        body: body2,
        headers: { "x-announce-signature": sign(body2, "s") },
      }),
    );
    expect(res2.status).toBe(204);
    expect(onMatchReportPending).toHaveBeenCalledWith({
      guildId: "g",
      matchId: 2,
    });
  });
});
