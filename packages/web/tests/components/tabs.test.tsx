// @vitest-environment jsdom
import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Tabs } from "../../src/components/ui/tabs";

describe("Tabs", () => {
  it("renders tabs, marks the active one, and fires onChange", () => {
    const onChange = vi.fn();
    render(
      <Tabs
        value="overview"
        onChange={onChange}
        tabs={[
          { id: "overview", label: "Overview" },
          { id: "my", label: "My Matches", badge: 2 },
          { id: "all", label: "All Matches" },
        ]}
      />,
    );
    const active = screen.getByRole("tab", { name: /overview/i });
    expect(active.getAttribute("aria-selected")).toBe("true");
    expect(screen.getByText("2")).toBeTruthy(); // badge
    fireEvent.click(screen.getByRole("tab", { name: /my matches/i }));
    expect(onChange).toHaveBeenCalledWith("my");
  });
});
