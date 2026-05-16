import { describe, expect, it } from "vitest";
import { navItems } from "../src/lib/nav-items";

describe("navItems", () => {
  it("includes My Cubes with prefix matching", () => {
    expect(navItems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ href: "/cubes", label: "My Cubes", match: "prefix" }),
      ]),
    );
  });

  it("keeps My Cubes before Settings", () => {
    const labels = navItems.map((item) => item.label);
    expect(labels.indexOf("My Cubes")).toBeGreaterThan(labels.indexOf("Drafts"));
    expect(labels.indexOf("My Cubes")).toBeLessThan(labels.indexOf("Settings"));
  });
});
