import { describe, expect, it } from "vitest";
import { commandDefinitions } from "../../src/commands/definitions.js";

describe("command definitions", () => {
  it("uses the approved simple command names", () => {
    expect(commandDefinitions.map((command) => command.name)).toEqual([
      "duel",
      "approve",
      "deny",
      "stats",
      "rankings",
      "event",
    ]);
  });
});
