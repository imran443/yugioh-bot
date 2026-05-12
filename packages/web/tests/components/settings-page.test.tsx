// @vitest-environment jsdom
import React from "react";
import { render, screen } from "@testing-library/react";
import { afterEach, describe, it, vi } from "vitest";
import SettingsPage from "../../app/(app)/settings/page";

vi.mock("next/image", () => ({
  default: ({ alt, fill: _fill, ...props }: React.ImgHTMLAttributes<HTMLImageElement> & { fill?: boolean }) => (
    <img alt={alt} {...props} />
  ),
}));

afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe("SettingsPage", () => {
  it("renders the announcement toggles and the card pools manager", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/settings") return Response.json({});
      if (url === "/api/draft-templates") return Response.json({ templates: [] });
      return Response.json({}, { status: 404 });
    }));
    render(<SettingsPage />);
    screen.getByRole("heading", { name: /settings/i });
    screen.getByRole("heading", { name: /card pools/i });
    // AnnouncementToggles renders its headings after the fetch resolves
    await screen.findByRole("heading", { name: /draft announcements/i });
    // CardPoolManager shows the empty-state message after fetch resolves
    await screen.findByText(/no saved pools yet/i);
  });
});
