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
  it("renders announcement toggles without the card pools manager", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/settings") return Response.json({});
      return Response.json({}, { status: 404 });
    }));
    render(<SettingsPage />);
    screen.getByRole("heading", { name: /settings/i });
    // AnnouncementToggles renders its headings after the fetch resolves
    await screen.findByRole("heading", { name: /draft announcements/i });
    expect(screen.queryByRole("heading", { name: /card pools/i })).toBeNull();
    expect(screen.queryByText(/no saved pools yet/i)).toBeNull();
  });
});
