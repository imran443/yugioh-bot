import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("Dockerfile web runtime", () => {
  it("copies Next config so production image optimization allows card image hosts", () => {
    const dockerfile = readFileSync(resolve(__dirname, "../../../Dockerfile"), "utf8");

    expect(dockerfile).toContain("COPY --from=build /app/packages/web/next.config.ts packages/web/next.config.ts");
  });
});
