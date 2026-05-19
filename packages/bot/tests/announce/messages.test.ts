import { describe, expect, it } from "vitest";
import {
  draftCreatedAnnouncement,
  tournamentCreatedAnnouncement,
  tournamentStartedAnnouncement,
  reportPendingAnnouncement,
} from "../../src/announce/messages.js";

describe("announce messages", () => {
  it("uses the default web URL when WEB_URL is not configured", () => {
    expect(draftCreatedAnnouncement({ name: "test1", webSlug: "1d4wjhls" })).toBe(
      "Signups are open for **test1**. Pick cards: http://localhost:3000/draft/1d4wjhls",
    );
  });

  it("encodes the expected approver discord id in the approve/deny customIds", () => {
    const { components } = reportPendingAnnouncement({
      matchId: 42, tournamentName: "locals", roundNumber: 3,
      reporterName: "Alice", opponentDiscordId: "999", opponentLost: true,
    });
    const ids = components[0].components.map((c) => (c.toJSON() as { custom_id: string }).custom_id);
    expect(ids).toEqual(["dashboard_approve:42:999", "dashboard_deny:42:999"]);
  });

  it("formats tournament announcements with the configured web URL", () => {
    expect(tournamentCreatedAnnouncement({ name: "locals", format: "round_robin", webSlug: "abc", webUrl: "https://app.test", organizerUserId: "u123", participantCount: 3 })).toBe(
      "🏆 **locals** — Signups open\nFormat: Round Robin · Pending — 3 participants\nOrganizer: <@u123>\nJoin: https://app.test/tournament/abc",
    );
    expect(tournamentStartedAnnouncement({ name: "locals", webSlug: "abc", webUrl: "https://app.test" })).toBe(
      "**locals** has started. Bracket: https://app.test/tournament/abc",
    );
  });
});
