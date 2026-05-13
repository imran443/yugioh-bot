import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

describe("root dev:duel-web script", () => {
  it("forwards extra args to the duel-web workspace script", () => {
    const rootPackage = JSON.parse(
      readFileSync(new URL("../../../package.json", import.meta.url), "utf8"),
    );

    expect(rootPackage.scripts["dev:duel-web"]).toBe(
      "npm run dev --workspace=@yugioh-discord-bot/duel-web --",
    );
  });
});
