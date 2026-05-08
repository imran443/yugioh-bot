import { describe, expect, it } from "vitest";
import {
  draftCreatedAnnouncement,
  tournamentCreatedAnnouncement,
  tournamentStartedAnnouncement,
} from "../../src/announce/messages.js";

describe("announce messages", () => {
  it("uses the default web URL when WEB_URL is not configured", () => {
    expect(draftCreatedAnnouncement({ name: "test1", webSlug: "1d4wjhls" })).toBe(
      "Signups are open for **test1**. Pick cards: http://localhost:3000/draft/1d4wjhls",
    );
  });

  it("formats tournament announcements with the configured web URL", () => {
    expect(tournamentCreatedAnnouncement({ name: "locals", format: "round_robin", webSlug: "abc", webUrl: "https://app.test" })).toBe(
      "Signups are open for **locals** (round_robin). Manage: https://app.test/tournament/abc",
    );
    expect(tournamentStartedAnnouncement({ name: "locals", webSlug: "abc", webUrl: "https://app.test" })).toBe(
      "**locals** has started. Bracket: https://app.test/tournament/abc",
    );
  });
});
