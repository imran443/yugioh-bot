import { readFileSync } from "node:fs";
import postcss, { type Rule } from "postcss";
import { describe, expect, it } from "vitest";

describe("page-owns-bar CSS", () => {
  const css = readFileSync(new URL("../../../src/components/layout/shell.module.css", import.meta.url), "utf8");
  const root = postcss.parse(css);

  it("removes the content padding at every width", () => {
    const rule = root.nodes.find((n): n is Rule => n.type === "rule" && n.selector === '.frame:has([data-shell-bar="own"]) .content');
    expect(rule?.toString()).toMatch(/padding:\s*0/);
  });

  it("adds no end padding for a page with its own room (draft, list pages, full-height deck editor)", () => {
    const rule = root.nodes.find((n): n is Rule => n.type === "rule" && n.selector === '.frame:has([data-shell-room="own"]) .content');
    expect(rule?.toString()).toMatch(/padding:\s*0;/);
    const own = root.nodes.filter((n): n is Rule => n.type === "rule" && n.selector === '.frame:has([data-shell-bar="own"]) .content');
    expect(own[0]?.toString()).toMatch(/padding:\s*0 0 64px/);
    // The room rule comes later, so it wins at equal specificity.
    expect(root.nodes.indexOf(rule!)).toBeGreaterThan(root.nodes.indexOf(own[0]!));
  });

  it("hides the shell's phone bar inside the 820px block", () => {
    const media = root.nodes.find((n) => n.type === "atrule" && n.name === "media" && n.params === "(max-width: 820px)");
    const rule = media && "nodes" in media ? media.nodes?.find((n): n is Rule => n.type === "rule" && n.selector === '.frame:has([data-shell-bar="own"]) .topWrap') : undefined;
    expect(rule?.toString()).toMatch(/display:\s*none/);
  });

  it("shows the menu button only at phone width", () => {
    const base = root.nodes.find((n): n is Rule => n.type === "rule" && n.selector === ".menuButton");
    expect(base?.toString()).toMatch(/display:\s*none/);
    const media = root.nodes.find((n) => n.type === "atrule" && n.name === "media" && n.params === "(max-width: 820px)");
    const phone = media && "nodes" in media ? media.nodes?.find((n): n is Rule => n.type === "rule" && n.selector === ".menuButton") : undefined;
    expect(phone?.toString()).toMatch(/display:\s*inline-grid/);
  });
});
