// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { Sidebar } from "../../src/components/layout/sidebar";

// Mock next/navigation so usePathname is controllable per test
vi.mock("next/navigation", () => ({
  usePathname: vi.fn(),
}));

// Mock next/link with a plain anchor so jsdom doesn't need a router
vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...props
  }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

import { usePathname } from "next/navigation";
const mockUsePathname = vi.mocked(usePathname);

// ---------------------------------------------------------------------------
// Active-state tests (regression for Bug 2: two items active on /dashboard)
// ---------------------------------------------------------------------------
describe("Sidebar — active nav item highlighting", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("marks only Dashboard as active when on /dashboard", () => {
    mockUsePathname.mockReturnValue("/dashboard");
    render(<Sidebar collapsed={false} />);

    const dashboardLink = screen.getByRole("link", { name: /dashboard/i });
    const draftsLink = screen.getByRole("link", { name: /drafts/i });

    expect(dashboardLink).toHaveAttribute("aria-current", "page");
    expect(draftsLink).not.toHaveAttribute("aria-current", "page");
  });

  it("does not mark Drafts as active when on /dashboard (regression)", () => {
    mockUsePathname.mockReturnValue("/dashboard");
    render(<Sidebar collapsed={false} />);

    const draftsLink = screen.getByRole("link", { name: /drafts/i });
    expect(draftsLink).not.toHaveAttribute("aria-current", "page");
  });

  it("marks Tournaments as active when on /tournaments", () => {
    mockUsePathname.mockReturnValue("/tournaments");
    render(<Sidebar collapsed={false} />);

    const tournamentsLink = screen.getByRole("link", { name: /tournaments/i });
    expect(tournamentsLink).toHaveAttribute("aria-current", "page");
  });

  it("marks Drafts as active when on /drafts", () => {
    mockUsePathname.mockReturnValue("/drafts");
    render(<Sidebar collapsed={false} />);

    const draftsLink = screen.getByRole("link", { name: /drafts/i });
    expect(draftsLink).toHaveAttribute("aria-current", "page");
  });

  it("marks Drafts as active on nested /drafts/123 route", () => {
    mockUsePathname.mockReturnValue("/drafts/123");
    render(<Sidebar collapsed={false} />);

    const draftsLink = screen.getByRole("link", { name: /drafts/i });
    expect(draftsLink).toHaveAttribute("aria-current", "page");
  });

  it("does not mark Dashboard active when on /drafts", () => {
    mockUsePathname.mockReturnValue("/drafts");
    render(<Sidebar collapsed={false} />);

    const dashboardLink = screen.getByRole("link", { name: /dashboard/i });
    expect(dashboardLink).not.toHaveAttribute("aria-current", "page");
  });

  it("marks at most one item active for any route", () => {
    mockUsePathname.mockReturnValue("/dashboard");
    render(<Sidebar collapsed={false} />);

    const activeLinks = screen
      .getAllByRole("link")
      .filter((l) => l.getAttribute("aria-current") === "page");
    expect(activeLinks).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Collapsed / expanded state tests (regression for Bug 1: collapse blocked)
// ---------------------------------------------------------------------------
describe("Sidebar — collapsed state", () => {
  beforeEach(() => {
    mockUsePathname.mockReturnValue("/dashboard");
  });

  it("applies md:w-56 when not collapsed", () => {
    const { container } = render(<Sidebar collapsed={false} />);
    const aside = container.querySelector("aside");
    expect(aside?.className).toContain("md:w-56");
  });

  it("applies md:w-16 when collapsed", () => {
    const { container } = render(<Sidebar collapsed={true} />);
    const aside = container?.querySelector("aside");
    expect(aside?.className).toContain("md:w-16");
  });

  it("starts below the topbar (md:top-14) so the toggle button is accessible", () => {
    const { container } = render(<Sidebar collapsed={false} />);
    const aside = container.querySelector("aside");
    // Must have md:top-14 — NOT md:inset-y-0 — so the sidebar doesn't
    // obscure the topbar toggle button (Bug 1 regression).
    expect(aside?.className).toContain("md:top-14");
    expect(aside?.className).not.toContain("md:inset-y-0");
  });

  it("shows labels as visible text when expanded", () => {
    mockUsePathname.mockReturnValue("/dashboard");
    render(<Sidebar collapsed={false} />);

    // Labels must NOT have sr-only when expanded
    const dashboardLabel = screen.getByText("Dashboard");
    expect(dashboardLabel.className).not.toContain("sr-only");
  });

  it("hides labels with sr-only when collapsed", () => {
    mockUsePathname.mockReturnValue("/dashboard");
    render(<Sidebar collapsed={true} />);

    // In collapsed mode all label spans get sr-only
    const dashboardLabel = screen.getByText("Dashboard");
    expect(dashboardLabel.className).toContain("sr-only");
  });
});

// ---------------------------------------------------------------------------
// Accessibility
// ---------------------------------------------------------------------------
describe("Sidebar — accessibility", () => {
  beforeEach(() => {
    mockUsePathname.mockReturnValue("/dashboard");
  });

  it("has a nav element with an accessible label", () => {
    render(<Sidebar collapsed={false} />);
    const nav = screen.getByRole("navigation", { name: /main navigation/i });
    expect(nav).toBeTruthy();
  });

  it("renders all three nav items", () => {
    render(<Sidebar collapsed={false} />);
    expect(screen.getByRole("link", { name: /dashboard/i })).toBeTruthy();
    expect(screen.getByRole("link", { name: /tournaments/i })).toBeTruthy();
    expect(screen.getByRole("link", { name: /drafts/i })).toBeTruthy();
  });

  it("active item gets title attribute when collapsed for tooltip", () => {
    mockUsePathname.mockReturnValue("/dashboard");
    render(<Sidebar collapsed={true} />);

    const dashboardLink = screen.getByRole("link", { name: /dashboard/i });
    expect(dashboardLink).toHaveAttribute("title", "Dashboard");
  });
});
