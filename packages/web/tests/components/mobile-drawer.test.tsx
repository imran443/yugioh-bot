// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MobileDrawer } from "../../src/components/layout/mobile-drawer";

vi.mock("next/navigation", () => ({
  usePathname: vi.fn(),
}));

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    onClick,
    ...props
  }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) => (
    <a href={href} onClick={onClick} {...props}>
      {children}
    </a>
  ),
}));

import { usePathname } from "next/navigation";
const mockUsePathname = vi.mocked(usePathname);

// ---------------------------------------------------------------------------
// Visibility tests
// ---------------------------------------------------------------------------
describe("MobileDrawer — visibility", () => {
  beforeEach(() => {
    mockUsePathname.mockReturnValue("/dashboard");
  });

  it("drawer is off-screen when closed", () => {
    const { container } = render(
      <MobileDrawer open={false} onClose={vi.fn()} />,
    );
    const aside = container.querySelector("aside");
    expect(aside?.className).toContain("-translate-x-full");
  });

  it("drawer is on-screen when open", () => {
    const { container } = render(
      <MobileDrawer open={true} onClose={vi.fn()} />,
    );
    const aside = container.querySelector("aside");
    expect(aside?.className).toContain("translate-x-0");
    expect(aside?.className).not.toContain("-translate-x-full");
  });

  it("shows backdrop overlay when open", () => {
    const { container } = render(
      <MobileDrawer open={true} onClose={vi.fn()} />,
    );
    // The backdrop is a div with aria-hidden="true" (icons are SVGs, not divs)
    const backdrop = container.querySelector("div[aria-hidden='true']");
    expect(backdrop).toBeTruthy();
  });

  it("does not render backdrop when closed", () => {
    const { container } = render(
      <MobileDrawer open={false} onClose={vi.fn()} />,
    );
    // Icons render SVG[aria-hidden]; only the backdrop uses div[aria-hidden]
    const backdrop = container.querySelector("div[aria-hidden='true']");
    expect(backdrop).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Interaction tests
// ---------------------------------------------------------------------------
describe("MobileDrawer — interactions", () => {
  beforeEach(() => {
    mockUsePathname.mockReturnValue("/dashboard");
  });

  it("calls onClose when the close button is clicked", () => {
    const onClose = vi.fn();
    render(<MobileDrawer open={true} onClose={onClose} />);

    const closeButton = screen.getByRole("button", {
      name: /close navigation menu/i,
    });
    fireEvent.click(closeButton);

    expect(onClose).toHaveBeenCalledOnce();
  });

  it("calls onClose when the backdrop overlay is clicked", () => {
    const onClose = vi.fn();
    const { container } = render(
      <MobileDrawer open={true} onClose={onClose} />,
    );

    const backdrop = container.querySelector("[aria-hidden='true']") as HTMLElement;
    fireEvent.click(backdrop);

    expect(onClose).toHaveBeenCalledOnce();
  });

  it("calls onClose when a nav link is clicked", () => {
    const onClose = vi.fn();
    render(<MobileDrawer open={true} onClose={onClose} />);

    const dashboardLink = screen.getByRole("link", { name: /dashboard/i });
    fireEvent.click(dashboardLink);

    expect(onClose).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// Active-state tests (regression for Bug 2: two items active on /dashboard)
// ---------------------------------------------------------------------------
describe("MobileDrawer — active nav item highlighting", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("marks only Dashboard as active when on /dashboard", () => {
    mockUsePathname.mockReturnValue("/dashboard");
    render(<MobileDrawer open={true} onClose={vi.fn()} />);

    const dashboardLink = screen.getByRole("link", { name: /dashboard/i });
    const draftsLink = screen.getByRole("link", { name: /drafts/i });

    expect(dashboardLink).toHaveAttribute("aria-current", "page");
    expect(draftsLink).not.toHaveAttribute("aria-current", "page");
  });

  it("does not mark Drafts as active when on /dashboard (regression)", () => {
    mockUsePathname.mockReturnValue("/dashboard");
    render(<MobileDrawer open={true} onClose={vi.fn()} />);

    const draftsLink = screen.getByRole("link", { name: /drafts/i });
    expect(draftsLink).not.toHaveAttribute("aria-current", "page");
  });

  it("marks Tournaments as active when on /tournaments", () => {
    mockUsePathname.mockReturnValue("/tournaments");
    render(<MobileDrawer open={true} onClose={vi.fn()} />);

    const tournamentsLink = screen.getByRole("link", { name: /tournaments/i });
    expect(tournamentsLink).toHaveAttribute("aria-current", "page");
  });

  it("marks Drafts as active when on /drafts", () => {
    mockUsePathname.mockReturnValue("/drafts");
    render(<MobileDrawer open={true} onClose={vi.fn()} />);

    const draftsLink = screen.getByRole("link", { name: /drafts/i });
    expect(draftsLink).toHaveAttribute("aria-current", "page");
  });

  it("marks at most one item active for any route", () => {
    mockUsePathname.mockReturnValue("/dashboard");
    render(<MobileDrawer open={true} onClose={vi.fn()} />);

    const activeLinks = screen
      .getAllByRole("link")
      .filter((l) => l.getAttribute("aria-current") === "page");
    expect(activeLinks).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Accessibility
// ---------------------------------------------------------------------------
describe("MobileDrawer — accessibility", () => {
  beforeEach(() => {
    mockUsePathname.mockReturnValue("/dashboard");
  });

  it("has a nav element", () => {
    render(<MobileDrawer open={true} onClose={vi.fn()} />);
    const nav = screen.getByRole("navigation", { name: /mobile navigation/i });
    expect(nav).toBeTruthy();
  });

  it("renders all three nav items", () => {
    render(<MobileDrawer open={true} onClose={vi.fn()} />);
    expect(screen.getByRole("link", { name: /dashboard/i })).toBeTruthy();
    expect(screen.getByRole("link", { name: /tournaments/i })).toBeTruthy();
    expect(screen.getByRole("link", { name: /drafts/i })).toBeTruthy();
  });
});
