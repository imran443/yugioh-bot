// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

import { fontMock } from "./helpers";

vi.mock("next/font/google", () => fontMock());

import { OwnsPageBar, ShellMenuButton } from "../../../src/components/layout/shell-bar";
import { ShellContext } from "../../../src/components/layout/shell-context";

describe("OwnsPageBar", () => {
  it("renders a hidden marker the shell's CSS looks for", () => {
    const { container } = render(<OwnsPageBar />);
    const marker = container.querySelector("[data-shell-bar='own']");
    expect(marker).not.toBeNull();
    expect(marker).toHaveAttribute("hidden");
    expect(marker).not.toHaveAttribute("data-shell-room");
  });

  it("says the page has its own room at the end when asked", () => {
    const { container } = render(<OwnsPageBar room />);
    expect(container.querySelector("[data-shell-bar='own']")).toHaveAttribute("data-shell-room", "own");
  });
});

describe("ShellMenuButton", () => {
  it("asks the shell to open the menu with itself as the trigger", () => {
    const openMenu = vi.fn();
    render(
      <ShellContext.Provider value={{ openMenu, menuOpen: false, live: null }}>
        <ShellMenuButton />
      </ShellContext.Provider>,
    );
    const button = screen.getByRole("button", { name: "Open menu" });
    expect(button).toHaveAttribute("aria-haspopup", "dialog");
    expect(button).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(button);
    expect(openMenu).toHaveBeenCalledWith(button);
  });

  it("shows the live dot and says so when something is live", () => {
    const { container } = render(
      <ShellContext.Provider value={{ openMenu: vi.fn(), menuOpen: false, live: { yourDuel: null, liveCount: 2 } }}>
        <ShellMenuButton />
      </ShellContext.Provider>,
    );
    expect(screen.getByRole("button", { name: "Open menu, live now" })).toBeTruthy();
    expect(container.querySelector(".sv-ldot")).not.toBeNull();
  });

  it("is safe outside the shell", () => {
    render(<ShellMenuButton />);
    fireEvent.click(screen.getByRole("button", { name: "Open menu" }));
  });
});

