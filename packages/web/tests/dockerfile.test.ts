import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("Dockerfile web runtime", () => {
  it("copies Next config so production image optimization allows card image hosts", () => {
    const dockerfile = readFileSync(resolve(__dirname, "../../../Dockerfile"), "utf8");

    expect(dockerfile).toContain("COPY --from=build /app/packages/web/next.config.ts packages/web/next.config.ts");
  });

  it("configures websocket CORS from the public app origin", () => {
    const compose = readFileSync(resolve(__dirname, "../../../docker-compose.yml"), "utf8");

    expect(compose).toContain("- WEB_URL=${NEXTAUTH_URL:-http://localhost}");
    expect(compose).not.toContain("- WEB_URL=http://web:3000");
  });
});
