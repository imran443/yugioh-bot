// @vitest-environment jsdom
import React from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import CubesPage from "../../app/(app)/cubes/page";

vi.mock("../../src/components/cubes/cubes-library-list", () => ({
  CubesLibraryList: () => <div>Mock cubes list</div>,
}));

describe("CubesPage", () => {
  it("renders the Cubes heading and the library list", () => {
    render(<CubesPage />);

    expect(screen.getByRole("heading", { name: /^cubes$/i })).toBeInTheDocument();
    expect(screen.getByText("Mock cubes list")).toBeInTheDocument();
  });
});
