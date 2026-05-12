// @vitest-environment jsdom
import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CardPoolManager } from "../../src/components/settings/card-pool-manager";

vi.mock("next/image", () => ({
  default: ({ alt, fill: _fill, ...props }: React.ImgHTMLAttributes<HTMLImageElement> & { fill?: boolean }) => (
    <img alt={alt} {...props} />
  ),
}));

function stubFetch() {
  let templates = [
    { id: 1, name: "Goat Cube", setNames: ["Metal Raiders"], customCardIds: [46986414, 83764718] },
    { id: 2, name: "Pauper", setNames: [], customCardIds: [12345678] },
  ];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    if (url.startsWith("/api/sets")) return Response.json({ sets: [] });
    if (url === "/api/cards/resolve") return Response.json({ cards: [], unknownIds: [] });
    if (url === "/api/draft-templates" && method === "GET") return Response.json({ templates });
    if (url === "/api/draft-templates" && method === "POST") {
      const body = JSON.parse(String(init!.body)) as { name: string; config: { setNames: string[]; customCardIds: number[] } };
      const t = { id: 3, name: body.name, setNames: body.config.setNames, customCardIds: body.config.customCardIds };
      templates = [...templates, t];
      return Response.json({ template: t }, { status: 201 });
    }
    if (url.startsWith("/api/draft-templates/") && method === "PUT") {
      const id = Number(url.split("/").pop());
      const body = JSON.parse(String(init!.body)) as { name: string; setNames: string[]; customCardIds: number[] };
      templates = templates.map((t) => (t.id === id ? { id, name: body.name, setNames: body.setNames, customCardIds: body.customCardIds } : t));
      return Response.json({ template: { id, ...body } });
    }
    if (url.startsWith("/api/draft-templates/") && method === "DELETE") {
      const id = Number(url.split("/").pop());
      templates = templates.filter((t) => t.id !== id);
      return Response.json({ ok: true });
    }
    return Response.json({}, { status: 404 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("CardPoolManager", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

  it("lists pools with a sets/IDs summary line", async () => {
    stubFetch();
    render(<CardPoolManager />);
    await waitFor(() => expect(screen.getByText("Goat Cube")).toBeTruthy());
    expect(screen.getByText(/1 set · 2 custom ids/i)).toBeTruthy();
    expect(screen.getByText(/0 sets · 1 custom id/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /edit pool goat cube/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /delete pool goat cube/i })).toBeTruthy();
  });

  it("creates a new pool", async () => {
    const fetchMock = stubFetch();
    render(<CardPoolManager />);
    await waitFor(() => screen.getByText("Goat Cube"));
    fireEvent.click(screen.getByRole("button", { name: /new pool/i }));
    fireEvent.change(screen.getByLabelText(/pool name/i), { target: { value: "Speed Cube" } });
    fireEvent.change(screen.getByLabelText(/custom card ids/i), { target: { value: "11111111" } });
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));
    await waitFor(() => {
      const post = fetchMock.mock.calls.find(([u, i]) => String(u) === "/api/draft-templates" && (i as RequestInit)?.method === "POST");
      expect(post).toBeTruthy();
      expect(JSON.parse(String((post![1] as RequestInit).body))).toMatchObject({ name: "Speed Cube", config: { customCardIds: [11111111] } });
    });
    await waitFor(() => expect(screen.getByText("Speed Cube")).toBeTruthy());
  });

  it("deletes a pool after confirmation", async () => {
    const fetchMock = stubFetch();
    render(<CardPoolManager />);
    await waitFor(() => screen.getByText("Pauper"));
    fireEvent.click(screen.getByRole("button", { name: /delete pool pauper/i }));
    fireEvent.click(screen.getByRole("button", { name: /^delete$/i }));
    await waitFor(() => {
      const del = fetchMock.mock.calls.find(([u, i]) => String(u).endsWith("/api/draft-templates/2") && (i as RequestInit)?.method === "DELETE");
      expect(del).toBeTruthy();
    });
    await waitFor(() => expect(screen.queryByText("Pauper")).toBeNull());
  });

  it("shows an error when delete fails", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url.startsWith("/api/sets")) return Response.json({ sets: [] });
      if (url === "/api/cards/resolve") return Response.json({ cards: [], unknownIds: [] });
      if (url === "/api/draft-templates" && method === "GET")
        return Response.json({ templates: [{ id: 1, name: "Goat Cube", setNames: [], customCardIds: [1] }] });
      if (url.startsWith("/api/draft-templates/") && method === "DELETE")
        return Response.json({ error: "Not found" }, { status: 404 });
      return Response.json({}, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<CardPoolManager />);
    await waitFor(() => screen.getByText("Goat Cube"));
    fireEvent.click(screen.getByRole("button", { name: /delete pool goat cube/i }));
    fireEvent.click(screen.getByRole("button", { name: /^delete$/i }));
    await waitFor(() => expect(screen.getByText(/not found|delete failed/i)).toBeTruthy());
  });

  it("shows validation error for empty pool name", async () => {
    stubFetch();
    render(<CardPoolManager />);
    await waitFor(() => screen.getByText("Goat Cube"));
    fireEvent.click(screen.getByRole("button", { name: /new pool/i }));
    // Leave name empty, add a card ID
    fireEvent.change(screen.getByLabelText(/custom card ids/i), { target: { value: "11111111" } });
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));
    await waitFor(() => expect(screen.getByText(/pool name is required/i)).toBeTruthy());
  });

  it("surfaces a 409 rename collision", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input); const method = (init?.method ?? "GET").toUpperCase();
      if (url.startsWith("/api/sets")) return Response.json({ sets: [] });
      if (url === "/api/cards/resolve") return Response.json({ cards: [], unknownIds: [] });
      if (url === "/api/draft-templates" && method === "GET") return Response.json({ templates: [{ id: 1, name: "Goat Cube", setNames: [], customCardIds: [1] }, { id: 2, name: "Pauper", setNames: [], customCardIds: [2] }] });
      if (url.startsWith("/api/draft-templates/") && method === "PUT") return Response.json({ error: 'A pool named "Pauper" already exists' }, { status: 409 });
      return Response.json({}, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<CardPoolManager />);
    await waitFor(() => screen.getByText("Goat Cube"));
    fireEvent.click(screen.getByRole("button", { name: /edit pool goat cube/i }));
    fireEvent.change(screen.getByLabelText(/pool name/i), { target: { value: "Pauper" } });
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));
    await waitFor(() => expect(screen.getByText(/already exists/i)).toBeTruthy());
  });
});
