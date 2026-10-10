// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import NewThemeDraftPage from "../app/(app)/drafts/new/theme/page";
import NewCubeDraftPage from "../app/(app)/drafts/new/cube/page";

const { redirect } = vi.hoisted(() => ({
  redirect: vi.fn((to: string) => {
    throw new Error(`NEXT_REDIRECT ${to}`);
  }),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }), redirect }));
// The cube setup form is not under test here; only its page frame is.
vi.mock("@/components/draft/create-draft-form", () => ({ CreateDraftForm: () => <div>cube form</div> }));

const originalFlag = process.env.THEME_DRAFTS;
beforeEach(() => {
  redirect.mockClear();
});
afterEach(() => {
  if (originalFlag === undefined) delete process.env.THEME_DRAFTS;
  else process.env.THEME_DRAFTS = originalFlag;
});

describe("theme draft pages and the THEME_DRAFTS flag", () => {
  it("closed: the theme setup page redirects to the draft chooser", () => {
    delete process.env.THEME_DRAFTS;
    expect(() => render(<NewThemeDraftPage />)).toThrow("NEXT_REDIRECT /drafts/new");
    expect(redirect).toHaveBeenCalledWith("/drafts/new");
  });

  it("open: the theme setup page renders and its Create button works", () => {
    process.env.THEME_DRAFTS = "1";
    render(<NewThemeDraftPage />);
    expect(redirect).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Create theme draft" })).toBeEnabled();
    expect(screen.queryByText("Theme drafts are not open yet.")).toBeNull();
  });

  it("closed: the cube setup page goes back to the draft list, not to the chooser that redirects here", () => {
    delete process.env.THEME_DRAFTS;
    const { container } = render(<NewCubeDraftPage />);
    expect(container.querySelector(".sv-bar-back")).toHaveAttribute("href", "/drafts");
  });

  it("open: the cube setup page goes back to the chooser", () => {
    process.env.THEME_DRAFTS = "true";
    const { container } = render(<NewCubeDraftPage />);
    expect(container.querySelector(".sv-bar-back")).toHaveAttribute("href", "/drafts/new");
  });
});
