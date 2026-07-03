// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import NewDraftPage from "../app/(app)/drafts/new/page";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

describe("draft-type chooser", () => {
  it("offers a cube and a theme draft option", () => {
    render(<NewDraftPage />);
    expect(screen.getByRole("link", { name: /cube draft/i })).toHaveAttribute("href", "/drafts/new/cube");
    expect(screen.getByRole("link", { name: /theme draft/i })).toHaveAttribute("href", "/drafts/new/theme");
  });
});
