// @vitest-environment jsdom
import React from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import CubesPage from "../../app/(app)/cubes/page";

vi.mock("../../src/components/cubes/my-cubes-list", () => ({
  MyCubesList: () => <div>Mock cubes list</div>,
}));

describe("CubesPage", () => {
  it("renders a Create Card Pool link to /cubes/new", () => {
    render(<CubesPage />);

    expect(screen.getByRole("link", { name: /create card pool/i })).toHaveAttribute("href", "/cubes/new");
  });
});
