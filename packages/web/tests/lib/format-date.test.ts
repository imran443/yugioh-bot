import { describe, expect, it } from "vitest";
import { formatMatchTime } from "../../src/lib/format-date";

describe("formatMatchTime", () => {
  it("formats an ISO timestamp as an absolute month/day/time string", () => {
    const out = formatMatchTime("2026-05-18T14:30:00Z", { locale: "en-US", timeZone: "UTC" });
    expect(out).toBe("May 18, 14:30");
  });

  it("returns an empty string for null/empty input", () => {
    expect(formatMatchTime(null)).toBe("");
    expect(formatMatchTime("")).toBe("");
  });
});
