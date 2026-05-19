import { describe, expect, it } from "vitest";
import { reportPendingAnnouncement } from "../../src/announce/messages.js";

describe("reportPendingAnnouncement", () => {
  it("pings the opponent and includes approve/deny buttons for the match", () => {
    const msg = reportPendingAnnouncement({
      matchId: 42,
      tournamentName: "Friday Cube",
      roundNumber: 2,
      reporterName: "Alice",
      opponentDiscordId: "111",
      opponentLost: true,
    });
    expect(msg.content).toContain("<@111>");
    expect(msg.content).toContain("Alice");
    expect(msg.content).toContain("Friday Cube");
    expect(msg.content.toLowerCase()).toContain("lost");
    const ids = msg.components[0].components.map((c: any) => c.data.custom_id);
    expect(ids).toEqual(["dashboard_approve:42", "dashboard_deny:42"]);
  });
});
