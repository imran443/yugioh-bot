import { describe, expect, it } from "vitest";
import { navItems } from "../src/lib/nav-items";

describe("navItems", () => {
  it("includes a single Cubes entry with prefix matching", () => {
    expect(navItems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ href: "/cubes", label: "Cubes", match: "prefix" }),
      ]),
    );
    // The old split "My Cubes" + "Themes" entries are gone.
    expect(navItems.filter((i) => i.href === "/cubes")).toHaveLength(1);
    expect(navItems.some((i) => i.href === "/themes")).toBe(false);
  });

  it("keeps Cubes between Drafts and Settings", () => {
    const labels = navItems.map((item) => item.label);
    expect(labels.indexOf("Cubes")).toBeGreaterThan(labels.indexOf("Drafts"));
    expect(labels.indexOf("Cubes")).toBeLessThan(labels.indexOf("Settings"));
  });
});
