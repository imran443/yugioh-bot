// @vitest-environment jsdom
import { render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import NewDraftPage from "../app/(app)/drafts/new/page";

const { redirect } = vi.hoisted(() => ({
  redirect: vi.fn((to: string) => {
    throw new Error(`NEXT_REDIRECT ${to}`);
  }),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }), redirect }));

const originalFlag = process.env.THEME_DRAFTS;
beforeEach(() => {
  process.env.THEME_DRAFTS = "1";
  redirect.mockClear();
});
afterEach(() => {
  if (originalFlag === undefined) delete process.env.THEME_DRAFTS;
  else process.env.THEME_DRAFTS = originalFlag;
});

describe("draft-type chooser, theme drafts closed", () => {
  it("sends the page straight to the cube draft setup and shows no theme option", () => {
    delete process.env.THEME_DRAFTS;
    expect(() => render(<NewDraftPage />)).toThrow("NEXT_REDIRECT /drafts/new/cube");
    expect(redirect).toHaveBeenCalledWith("/drafts/new/cube");
  });

  it("stays closed for any other flag value", () => {
    for (const value of ["", "0", "false", "off"]) {
      process.env.THEME_DRAFTS = value;
      expect(() => render(<NewDraftPage />)).toThrow("NEXT_REDIRECT /drafts/new/cube");
    }
  });
});

describe("draft-type chooser", () => {
  it("offers a cube and a theme draft option", () => {
    render(<NewDraftPage />);
    expect(screen.getByRole("link", { name: /cube draft/i })).toHaveAttribute("href", "/drafts/new/cube");
    expect(screen.getByRole("link", { name: /theme draft/i })).toHaveAttribute("href", "/drafts/new/theme");
  });

  it("uses the shared stage line with Create current and two short pieces, with the warning in the bar", () => {
    const { container } = render(<NewDraftPage />);
    const stages = screen.getByRole("list", { name: "Where creating leads" });
    expect(within(stages).getAllByRole("listitem").map((step) => step.textContent)).toEqual([
      "Create, current", "Lobby", "Draft", "Build deck",
    ]);
    expect(within(stages).getByText("Create").closest("li")).toHaveAttribute("aria-current", "step");
    const pieces = container.querySelectorAll("ul li");
    expect(Array.from(pieces).slice(0, 2).map((p) => p.textContent)).toEqual(["Pick a kind", "Then set it up"]);
    expect(container.querySelector(".sv-bar-sub")).toHaveTextContent("You can't switch after the draft is made.");
    expect(container.querySelector(".sv-bar-back")).toHaveAttribute("href", "/drafts");
    expect(container.textContent).not.toMatch(/[\u00b7]/);
  });

  it("shows the real defaults above non-interactive Match Sheet actions", () => {
    render(<NewDraftPage />);
    for (const [kind, facts, action] of [
      ["cube", "Starts at 40 cards each, 3 packs of 15, 45 s a pick", "Set up a cube draft"],
      ["theme", "Starts at 40 main and 15 Extra deck picks, 3 choices a pick, 45 s a pick", "Set up a theme draft"],
    ]) {
      const card = screen.getByRole("link", { name: new RegExp(`${kind} draft`, "i") });
      const factRow = within(card).getByText(facts);
      const button = within(card).getByText(action);
      expect(button.tagName).toBe("SPAN");
      expect(button).toHaveClass("sv-btn", "ghost");
      expect(button).not.toHaveAttribute("tabindex");
      expect(button.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
      expect(factRow.nextElementSibling).toBe(button);
      expect(within(card).queryByRole("button")).toBeNull();
      expect(within(card).queryByRole("link")).toBeNull();
    }
  });
});
