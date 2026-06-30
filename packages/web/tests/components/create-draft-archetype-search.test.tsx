// @vitest-environment jsdom
import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CreateDraftForm } from "../../src/components/draft/create-draft-form";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

describe("CreateDraftForm archetype search", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("suggests archetypes and unions a chosen archetype's cards into the custom pool", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url === "/api/discord/channels") return Response.json({ channels: [] });
      if (url === "/api/cubes" && method === "GET") return Response.json({ cubes: [] });
      if (url.startsWith("/api/archetypes")) {
        return Response.json({ archetypes: ["Blue-Eyes"] });
      }
      if (url === "/api/cards/resolve" && method === "POST") {
        const body = JSON.parse(String(init!.body)) as { archetype?: string };
        if (body.archetype === "Blue-Eyes") {
          return Response.json({
            cards: [{ id: 89631139 }, { id: 38517737 }],
            unknownIds: [],
          });
        }
        return Response.json({ cards: [], unknownIds: [] });
      }
      return Response.json({}, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<CreateDraftForm />);

    const archetypeInput = screen.getByLabelText(/add a whole archetype/i);
    fireEvent.change(archetypeInput, { target: { value: "blue" } });

    // Debounced suggestions query /api/archetypes and render the option.
    const suggestion = await screen.findByRole("button", { name: "Blue-Eyes" });
    expect(fetchMock.mock.calls.some(([u]) => String(u).startsWith("/api/archetypes?query="))).toBe(true);

    fireEvent.click(suggestion);

    // The chosen archetype is resolved to card ids and unioned into the custom pool.
    await waitFor(() => {
      const resolve = fetchMock.mock.calls.find(
        ([u, i]) => String(u) === "/api/cards/resolve" && (i as RequestInit)?.method === "POST",
      );
      expect(resolve).toBeTruthy();
      expect(JSON.parse(String((resolve![1] as RequestInit).body))).toMatchObject({ archetype: "Blue-Eyes" });
    });

    await waitFor(() => {
      const textarea = screen.getByLabelText(/custom card ids/i) as HTMLTextAreaElement;
      expect(textarea.value).toContain("89631139");
      expect(textarea.value).toContain("38517737");
    });
  });
});
