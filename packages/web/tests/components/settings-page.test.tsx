// @vitest-environment jsdom
import React from "react";
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import SettingsPage from "../../app/(app)/settings/page";

vi.mock("next/image", () => ({
  default: ({ alt, fill: _fill, ...props }: React.ImgHTMLAttributes<HTMLImageElement> & { fill?: boolean }) => (
    <img alt={alt} {...props} />
  ),
}));

afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe("SettingsPage", () => {
  it("renders the announcement toggles and the card pools manager", () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/settings") return Response.json({});
      if (url === "/api/draft-templates") return Response.json({ templates: [] });
      return Response.json({}, { status: 404 });
    }));
    render(<SettingsPage />);
    expect(screen.getAllByText(/settings/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/card pools/i)).toBeTruthy();
  });
});
