import { describe, expect, it } from "vitest";
import { generateWebSlug } from "../../src/util/web-slug.js";

describe("generateWebSlug", () => {
  it("returns an 8-character lowercase alphanumeric slug", () => {
    const slug = generateWebSlug();
    expect(slug).toMatch(/^[a-z0-9]{8}$/);
  });

  it("returns different slugs across calls", () => {
    const slugs = new Set(Array.from({ length: 200 }, () => generateWebSlug()));
    expect(slugs.size).toBeGreaterThan(190);
  });
});
