// @vitest-environment jsdom
import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CreateDraftForm } from "../../src/components/draft/create-draft-form";

const push = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
}));

describe("CreateDraftForm", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("creates a draft from custom card ids without requiring a selected set", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/discord/channels") {
        return Response.json({ channels: [] });
      }

      if (String(input) === "/api/drafts" && init?.method === "POST") {
        return Response.json({ webSlug: "custom-pool" }, { status: 201 });
      }

      return Response.json({}, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<CreateDraftForm />);

    fireEvent.change(screen.getByLabelText(/draft name/i), { target: { value: "Custom Pool Draft" } });
    fireEvent.change(screen.getByLabelText(/custom card ids/i), {
      target: { value: "46986414\n83764718, 46986414" },
    });
    fireEvent.click(screen.getByRole("button", { name: /create draft/i }));

    await waitFor(() => expect(push).toHaveBeenCalledWith("/draft/custom-pool"));

    const postCall = fetchMock.mock.calls.find(
      ([input, init]) => String(input) === "/api/drafts" && init?.method === "POST",
    );
    expect(JSON.parse(String(postCall?.[1]?.body))).toMatchObject({
      name: "Custom Pool Draft",
      config: {
        setNames: [],
        customCardIds: [46986414, 83764718],
      },
    });
  });

  it("loads a saved template into the draft pool and options", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === "/api/discord/channels") {
        return Response.json({ channels: [] });
      }

      if (String(input) === "/api/draft-templates") {
        return Response.json({
          templates: [
            {
              id: 1,
              name: "Goat Cube",
              config: {
                setNames: ["Metal Raiders"],
                customCardIds: [46986414, 83764718],
                packSize: 9,
                packsPerPlayer: 4,
                pickSeconds: 30,
                alternatePassDirection: false,
                randomizeSeats: true,
              },
            },
          ],
        });
      }

      return Response.json({}, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<CreateDraftForm />);

    const templateSelect = await screen.findByLabelText(/saved pool/i);
    fireEvent.change(templateSelect, { target: { value: "Goat Cube" } });

    expect(screen.getByText("Metal Raiders")).toBeInTheDocument();
    expect(screen.getByLabelText(/custom card ids/i)).toHaveValue("46986414\n83764718");
    expect(screen.getByLabelText(/packs per player/i)).toHaveValue(4);
    expect(screen.getByLabelText(/pick timer/i)).toHaveValue(30);
    expect(screen.getByLabelText(/alternate pass direction/i)).not.toBeChecked();
    expect(screen.getByLabelText(/randomize seats/i)).toBeChecked();
  });

  it("saves the current pool as a reusable template", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/discord/channels") {
        return Response.json({ channels: [] });
      }

      if (String(input) === "/api/draft-templates" && !init) {
        return Response.json({ templates: [] });
      }

      if (String(input) === "/api/draft-templates" && init?.method === "POST") {
        return Response.json({ template: { name: "Goat Cube" } }, { status: 201 });
      }

      return Response.json({}, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<CreateDraftForm />);

    fireEvent.change(await screen.findByLabelText(/template name/i), { target: { value: "Goat Cube" } });
    fireEvent.change(screen.getByLabelText(/custom card ids/i), { target: { value: "46986414\n83764718" } });
    fireEvent.click(screen.getByRole("button", { name: /save pool/i }));

    await waitFor(() => expect(screen.getByText(/saved goat cube/i)).toBeInTheDocument());

    const postCall = fetchMock.mock.calls.find(
      ([input, init]) => String(input) === "/api/draft-templates" && init?.method === "POST",
    );
    expect(JSON.parse(String(postCall?.[1]?.body))).toMatchObject({
      name: "Goat Cube",
      config: {
        customCardIds: [46986414, 83764718],
        packSize: 8,
        packsPerPlayer: 5,
      },
    });
  });
});
