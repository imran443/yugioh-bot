// @vitest-environment jsdom
import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MyCubesList } from "../../src/components/cubes/my-cubes-list";

describe("MyCubesList", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("lists saved pools as links to their editor pages", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          templates: [
            { id: 7, name: "Clara Pool", setNames: [], customCardIds: [1, 2, 3] },
            { id: 8, name: "Goat Cube", setNames: ["Metal Raiders"], customCardIds: [4] },
          ],
        }),
      ),
    );

    render(<MyCubesList />);

    await waitFor(() => expect(screen.getByRole("link", { name: /clara pool/i })).toBeTruthy());
    expect(screen.getByRole("link", { name: /clara pool/i })).toHaveAttribute("href", "/cubes/7");
    expect(screen.getByText(/3 passcodes/i)).toBeTruthy();
    expect(screen.getByText(/1 set/i)).toBeTruthy();
  });

  it("shows an empty state when there are no saved pools", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ templates: [] })));

    render(<MyCubesList />);

    await waitFor(() => expect(screen.getByText(/no saved pools yet/i)).toBeTruthy());
  });
});
