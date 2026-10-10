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
        onDraftStatus: vi.fn(),
        onDraftCreated: vi.fn(),
        onDraftNudge: vi.fn(),
        onDraftStarted: vi.fn(),
        onDraftCompleted: vi.fn(),
        onTournamentCreated: vi.fn(),
        onTournamentStarted: vi.fn(),
        onTournamentCompleted: vi.fn(),
        onDuelInvite: vi.fn(),
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

  it("dispatches tournament-completed", async () => {
    const onTournamentCompleted = vi.fn(async () => {});
    const server = createAnnounceServer({
      secret: "s",
      handlers: {
        onDraftStatus: vi.fn(),
        onDraftCreated: vi.fn(),
        onDraftNudge: vi.fn(),
        onDraftStarted: vi.fn(),
        onDraftCompleted: vi.fn(),
        onTournamentCreated: vi.fn(),
        onTournamentStarted: vi.fn(),
        onTournamentCompleted,
        onDuelInvite: vi.fn(),
        onMatchReportPending: vi.fn(),
        onMatchResolved: vi.fn(),
      },
    });
    const body = JSON.stringify({ tournamentId: 7 });
    const sig = sign(body, "s");
    const res = await server.handle(
      new Request("http://x/internal/announce/tournament-completed", {
        method: "POST",
        body,
        headers: { "x-announce-signature": sig },
      }),
    );
    expect(res.status).toBe(204);
    expect(onTournamentCompleted).toHaveBeenCalledWith({ tournamentId: 7 });
  });

  it("dispatches duel-invite", async () => {
    const onDuelInvite = vi.fn(async () => {});
    const server = createAnnounceServer({
      secret: "s",
      handlers: {
        onDraftStatus: vi.fn(),
        onDraftCreated: vi.fn(),
        onDraftNudge: vi.fn(),
        onDraftStarted: vi.fn(),
        onDraftCompleted: vi.fn(),
        onTournamentCreated: vi.fn(),
        onTournamentStarted: vi.fn(),
        onTournamentCompleted: vi.fn(),
        onDuelInvite,
        onMatchReportPending: vi.fn(),
        onMatchResolved: vi.fn(),
      },
    });
    const payload = {
      duelId: 1, slug: "abc",
      guildId: "g",
      opponentDiscordUserId: "900000000000000111",
      challengerName: "Yugi",
      duelName: "Yugi vs Kaiba",
      bestOf: 3,
      ranked: true,
      tournamentName: null,
      url: "http://localhost:3000/duels/abc",
    };
    const body = JSON.stringify(payload);
    const res = await server.handle(
      new Request("http://x/internal/announce/duel-invite", {
        method: "POST",
        body,
        headers: { "x-announce-signature": sign(body, "s") },
      }),
    );
    expect(res.status).toBe(204);
    expect(onDuelInvite).toHaveBeenCalledWith(payload);
  });
});


it("dispatches signed Nudge requests and reports delivery failure", async () => {
  const onDraftNudge = vi.fn().mockResolvedValue(undefined);
  const handler = vi.fn();
  const server = createAnnounceServer({ secret: "s", handlers: {
    onDraftStatus: handler, onDraftCreated: handler, onDraftStarted: handler, onDraftNudge, onDraftCompleted: handler,
    onTournamentCreated: handler, onTournamentStarted: handler, onTournamentCompleted: handler,
    onDuelInvite: handler, onMatchReportPending: handler, onMatchResolved: handler,
  } });
  const payload = { draftId: 1, channelId: "stored", name: "Night", webSlug: "abc", mentionUserIds: ["123456789012345678"] };
  const body = JSON.stringify(payload);
  const request = (signature = sign(body, "s")) => new Request("http://x/internal/announce/draft-nudge", {
    method: "POST", body, headers: { "x-announce-signature": signature },
  });
  expect((await server.handle(request("sha256=00"))).status).toBe(401);
  expect(onDraftNudge).not.toHaveBeenCalled();
  expect((await server.handle(request())).status).toBe(204);
  expect(onDraftNudge).toHaveBeenCalledWith(payload);
  onDraftNudge.mockRejectedValue(new Error("Cannot send"));
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  expect((await server.handle(request())).status).toBe(500);
  error.mockRestore();
});
