import { describe, expect, it } from "vitest";
import { DEFAULT_DUEL_1V1_ENGINE, duel1v1Engine, duel1v1EngineForMode, isDuelEngineChoice } from "../../src/duels/index.js";

describe("duel1v1Engine", () => {
  it("defaults to legacy when the key is missing or empty", () => {
    expect(DEFAULT_DUEL_1V1_ENGINE).toBe("legacy");
    expect(duel1v1Engine({})).toBe("legacy");
    expect(duel1v1Engine({ DUEL_1V1_ENGINE: "" })).toBe("legacy");
  });

  it("is legacy for legacy and for any unknown value", () => {
    for (const value of ["legacy", "LEGACY", "old", "1", "true", "pinned2"]) {
      expect(duel1v1Engine({ DUEL_1V1_ENGINE: value })).toBe("legacy");
    }
  });

  it("is pinned only for pinned, in any case, with spaces", () => {
    for (const value of ["pinned", "PINNED", " Pinned "]) {
      expect(duel1v1Engine({ DUEL_1V1_ENGINE: value })).toBe("pinned");
    }
  });

  it("reads process.env when it gets no argument", () => {
    const saved = process.env.DUEL_1V1_ENGINE;
    try {
      process.env.DUEL_1V1_ENGINE = "pinned";
      expect(duel1v1Engine()).toBe("pinned");
      delete process.env.DUEL_1V1_ENGINE;
      expect(duel1v1Engine()).toBe("legacy");
    } finally {
      if (saved === undefined) delete process.env.DUEL_1V1_ENGINE;
      else process.env.DUEL_1V1_ENGINE = saved;
    }
  });

  it("knows the two engine names", () => {
    expect(isDuelEngineChoice("legacy")).toBe(true);
    expect(isDuelEngineChoice("pinned")).toBe(true);
    expect(isDuelEngineChoice("multi")).toBe(false);
    expect(isDuelEngineChoice(undefined)).toBe(false);
  });
});

describe("duel1v1EngineForMode", () => {
  it.each(["pinned", " PINNED ", "legacy", " LEGACY "])("applies Standard override %j without changing the global choice", (override) => {
    const expected = override.trim().toLowerCase();
    const global = expected === "pinned" ? "legacy" : "pinned";
    const env = { DUEL_1V1_ENGINE: global, DUEL_STANDARD_1V1_ENGINE: override };
    expect(duel1v1EngineForMode("normal", env)).toBe(expected);
    expect(duel1v1EngineForMode("domain", env)).toBe(global);
    expect(duel1v1Engine(env)).toBe(global);
  });

  it.each([undefined, "", " ", "unknown"])("falls back to the global switch for Standard override %j", (override) => {
    for (const global of [undefined, "legacy", "pinned"]) {
      const env = { DUEL_1V1_ENGINE: global, DUEL_STANDARD_1V1_ENGINE: override };
      for (const mode of ["normal", "domain"] as const) expect(duel1v1EngineForMode(mode, env)).toBe(duel1v1Engine(env));
    }
  });
});
