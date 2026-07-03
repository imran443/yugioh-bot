// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DraftCard, type DraftCardProps } from "@/components/draft/draft-card";

vi.mock("next/link", () => ({
  default: ({ children, ...props }: any) => <a {...props}>{children}</a>,
}));

function base(overrides: Partial<DraftCardProps> = {}): DraftCardProps {
  return {
    id: 1,
    name: "Friday Night",
    status: "pending",
    currentPackRound: 0,
    currentPickStep: 0,
    playerCount: 2,
    webSlug: "abc",
    ...overrides,
  };
}

describe("DraftCard draft-type indicator", () => {
  it("labels a theme draft", () => {
    render(<DraftCard draft={base({ mode: "theme" })} />);
    expect(screen.getByText("Theme draft")).toBeInTheDocument();
    expect(screen.queryByText("Cube draft")).not.toBeInTheDocument();
  });

  it("labels a cube draft (default when mode absent)", () => {
    render(<DraftCard draft={base()} />);
    expect(screen.getByText("Cube draft")).toBeInTheDocument();
    expect(screen.queryByText("Theme draft")).not.toBeInTheDocument();
  });

  it("uses round terminology for active theme drafts", () => {
    render(<DraftCard draft={base({ mode: "theme", status: "active", currentPackRound: 7 })} />);
    expect(screen.getByText("Round 7")).toBeInTheDocument();
  });
});
