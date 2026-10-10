import { afterEach, describe, expect, it, vi } from "vitest";

describe("themeDraftsEnabled", () => {
  afterEach(() => vi.unstubAllEnvs());

  it.each(["production", "development", "test"])("defaults to off in %s", async (nodeEnv) => {
    const { themeDraftsEnabled } = await import("../src/lib/theme-drafts");
    vi.stubEnv("NODE_ENV", nodeEnv);
    vi.stubEnv("THEME_DRAFTS", undefined);
    expect(themeDraftsEnabled()).toBe(false);
  });

  it.each(["1", "true", "on"])("enables themes for exactly %j", async (value) => {
    const { themeDraftsEnabled } = await import("../src/lib/theme-drafts");
    vi.stubEnv("THEME_DRAFTS", value);
    expect(themeDraftsEnabled()).toBe(true);
  });

  it.each(["", "0", "false", "off", "yes", "TRUE", "ON", "True", " 1", "true ", "2"])("keeps themes off for %j", async (value) => {
    const { themeDraftsEnabled } = await import("../src/lib/theme-drafts");
    vi.stubEnv("THEME_DRAFTS", value);
    expect(themeDraftsEnabled()).toBe(false);
  });

  it("reads the flag again on each call", async () => {
    const { themeDraftsEnabled } = await import("../src/lib/theme-drafts");
    vi.stubEnv("THEME_DRAFTS", "0");
    expect(themeDraftsEnabled()).toBe(false);
    vi.stubEnv("THEME_DRAFTS", "on");
    expect(themeDraftsEnabled()).toBe(true);
    vi.stubEnv("THEME_DRAFTS", "0");
    expect(themeDraftsEnabled()).toBe(false);
  });
});
