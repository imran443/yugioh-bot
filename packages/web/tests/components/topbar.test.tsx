// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { TopBar } from "../../src/components/layout/topbar";

vi.mock("next/navigation", () => ({
  usePathname: vi.fn(),
}));

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

vi.mock("@/lib/actions", () => ({
  handleSignOut: vi.fn(),
}));

import { usePathname } from "next/navigation";
import { handleSignOut } from "@/lib/actions";

const mockUsePathname = vi.mocked(usePathname);
const mockHandleSignOut = vi.mocked(handleSignOut);

const defaultProps = {
  onMenuClick: vi.fn(),
  onToggleSidebar: vi.fn(),
  sidebarCollapsed: false,
};

function mockFetch(sessionData: object) {
  global.fetch = vi.fn().mockResolvedValue({
    json: () => Promise.resolve(sessionData),
  } as unknown as Response);
}

// ---------------------------------------------------------------------------
// Unauthenticated state
// ---------------------------------------------------------------------------
describe("TopBar — unauthenticated", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUsePathname.mockReturnValue("/dashboard");
    mockFetch({});
  });

  it("shows Sign in link when there is no session", async () => {
    render(<TopBar {...defaultProps} />);
    await waitFor(() =>
      expect(screen.getByRole("link", { name: /sign in/i })).toBeTruthy(),
    );
  });

  it("Sign in link points to /login", async () => {
    render(<TopBar {...defaultProps} />);
    await waitFor(() =>
      expect(screen.getByRole("link", { name: /sign in/i })).toHaveAttribute(
        "href",
        "/login",
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// Authenticated state
// ---------------------------------------------------------------------------
describe("TopBar — authenticated", () => {
  const session = { user: { name: "imran443", image: null } };

  beforeEach(() => {
    vi.clearAllMocks();
    mockUsePathname.mockReturnValue("/dashboard");
    mockFetch(session);
  });

  it("shows the user name", async () => {
    render(<TopBar {...defaultProps} />);
    await waitFor(() =>
      expect(screen.getByText("imran443")).toBeTruthy(),
    );
  });

  it("shows the first-letter avatar initial when the user has no image", async () => {
    render(<TopBar {...defaultProps} />);
    await waitFor(() => screen.getByText("imran443"));
    // Avatar initial is the uppercased first character of the name
    expect(screen.getByText("I")).toBeTruthy();
  });

  it("does not show the Sign in link when authenticated", async () => {
    render(<TopBar {...defaultProps} />);
    await waitFor(() => screen.getByText("imran443"));
    expect(screen.queryByRole("link", { name: /sign in/i })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Sign out
// ---------------------------------------------------------------------------
describe("TopBar — sign out", () => {
  const session = { user: { name: "imran443", image: null } };

  beforeEach(() => {
    vi.clearAllMocks();
    mockUsePathname.mockReturnValue("/dashboard");
    mockFetch(session);
  });

  it("sign out button is hidden before the dropdown is opened", async () => {
    render(<TopBar {...defaultProps} />);
    await waitFor(() => screen.getByText("imran443"));
    expect(screen.queryByRole("button", { name: /sign out/i })).toBeNull();
  });

  it("clicking the user button opens the dropdown and reveals Sign out", async () => {
    render(<TopBar {...defaultProps} />);
    await waitFor(() => screen.getByText("imran443"));

    fireEvent.click(screen.getByRole("button", { name: /imran443/i }));

    expect(screen.getByRole("button", { name: /sign out/i })).toBeTruthy();
  });

  it("clicking Sign out calls handleSignOut", async () => {
    render(<TopBar {...defaultProps} />);
    await waitFor(() => screen.getByText("imran443"));

    fireEvent.click(screen.getByRole("button", { name: /imran443/i }));
    fireEvent.click(screen.getByRole("button", { name: /sign out/i }));

    expect(mockHandleSignOut).toHaveBeenCalledOnce();
  });

  it("clicking Sign out closes the dropdown", async () => {
    render(<TopBar {...defaultProps} />);
    await waitFor(() => screen.getByText("imran443"));

    fireEvent.click(screen.getByRole("button", { name: /imran443/i }));
    fireEvent.click(screen.getByRole("button", { name: /sign out/i }));

    expect(screen.queryByRole("button", { name: /sign out/i })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Page title
// ---------------------------------------------------------------------------
describe("TopBar — page title", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch({});
  });

  it.each([
    ["/dashboard", "Dashboard"],
    ["/tournaments", "Tournaments"],
    ["/tournament/123", "Tournament"],
    ["/draft/abc", "Draft"],
    ["/login", "Sign In"],
  ])("shows '%s' as the heading on %s", (path, title) => {
    mockUsePathname.mockReturnValue(path);
    render(<TopBar {...defaultProps} />);
    expect(screen.getByRole("heading", { name: title })).toBeTruthy();
  });
});
