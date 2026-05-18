import { describe, expect, it, vi } from "vitest";
import { announceToBot, type AnnouncePayload } from "@/lib/announce-bot";

describe("announce-bot new kinds", () => {
  it("accepts match-report-pending and match-resolved payloads", async () => {
    const pending: AnnouncePayload = {
      kind: "match-report-pending",
      guildId: "g1",
      slug: "s1",
      matchId: 5,
      tournamentMatchId: 9,
      tournamentName: "RR",
      roundNumber: 2,
      reporterDiscordId: "u-a",
      opponentDiscordId: "u-b",
      reporterName: "Alice",
      opponentName: "Bob",
      opponentLost: true,
    };
    const resolved: AnnouncePayload = { kind: "match-resolved", matchId: 5 };
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await announceToBot({ url: "http://bot", secret: "x" }, pending);
    await announceToBot({ url: "http://bot", secret: "x" }, resolved);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://bot/internal/announce/match-report-pending",
      expect.any(Object),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "http://bot/internal/announce/match-resolved",
      expect.any(Object),
    );
    vi.unstubAllGlobals();
  });
});
