// @vitest-environment jsdom
import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CardPoolEditor } from "../../src/components/cubes/card-pool-editor";
import { clearCardsCache, putCards } from "../../src/lib/cards-cache";

const push = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
}));

vi.mock("next/image", () => ({
  default: ({ alt, fill: _fill, ...props }: React.ImgHTMLAttributes<HTMLImageElement> & { fill?: boolean }) => (
    <img alt={alt} {...props} />
  ),
}));

describe("CardPoolEditor create mode", () => {
  afterEach(() => {
    clearCardsCache();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    push.mockReset();
  });

  it("renders an empty create-mode editor", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === "/api/cards/resolve") return Response.json({ cards: [], unknownIds: [] });
        return Response.json({}, { status: 404 });
      }),
    );

    render(<CardPoolEditor mode="create" />);

    expect(screen.getByLabelText(/pool name/i)).toHaveValue("");
    expect(screen.getByRole("button", { name: /create card pool/i })).toBeDisabled();
    expect(screen.getByText(/import passcodes to preview this cube/i)).toBeTruthy();
  });

  it("creates a new pool and redirects to its edit page", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url === "/api/cards/resolve" && method === "POST") return Response.json({ cards: [], unknownIds: [] });
      if (url === "/api/draft-templates" && method === "POST") {
        return Response.json({ template: { id: 12, name: "New Cube", setNames: [], customCardIds: [33333333] } }, { status: 201 });
      }
      return Response.json({}, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<CardPoolEditor mode="create" />);

    fireEvent.change(screen.getByLabelText(/pool name/i), { target: { value: "New Cube" } });
    fireEvent.change(screen.getByLabelText(/paste passcodes/i), { target: { value: "33333333" } });
    fireEvent.click(screen.getByRole("button", { name: /replace cube with import/i }));
    fireEvent.click(screen.getByRole("button", { name: /create card pool/i }));

    await waitFor(() => {
      const post = fetchMock.mock.calls.find(([url, init]) => String(url) === "/api/draft-templates" && (init as RequestInit)?.method === "POST");
      expect(post).toBeTruthy();
      expect(JSON.parse(String((post![1] as RequestInit).body))).toEqual({
        name: "New Cube",
        config: { setNames: [], customCardIds: [33333333] },
      });
      expect(push).toHaveBeenCalledWith("/cubes/12");
    });
  });

  it("creates an empty pool when only the title is provided", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url === "/api/draft-templates" && method === "POST") {
        return Response.json({ template: { id: 13, name: "Empty Cube", setNames: [], customCardIds: [] } }, { status: 201 });
      }
      return Response.json({}, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<CardPoolEditor mode="create" />);

    fireEvent.change(screen.getByLabelText(/pool name/i), { target: { value: "Empty Cube" } });
    fireEvent.click(screen.getByRole("button", { name: /create card pool/i }));

    await waitFor(() => {
      const post = fetchMock.mock.calls.find(([url, init]) => String(url) === "/api/draft-templates" && (init as RequestInit)?.method === "POST");
      expect(post).toBeTruthy();
      expect(JSON.parse(String((post![1] as RequestInit).body))).toEqual({
        name: "Empty Cube",
        config: { setNames: [], customCardIds: [] },
      });
      expect(push).toHaveBeenCalledWith("/cubes/13");
    });
  });

  it("removes one copy at a time in create mode", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = (init?.method ?? "GET").toUpperCase();
        if (url === "/api/cards/resolve" && method === "POST") {
          return Response.json({
            cards: [{ id: 11111111, name: "Turtle Tiger", type: "Normal Monster", frameType: "normal", effectText: "", imageUrl: "u1", imageUrlSmall: "s1" }],
            unknownIds: [],
          });
        }
        return Response.json({}, { status: 404 });
      }),
    );

    render(<CardPoolEditor mode="create" />);

    fireEvent.change(screen.getByLabelText(/pool name/i), { target: { value: "Fresh Cube" } });
    fireEvent.change(screen.getByLabelText(/paste passcodes/i), { target: { value: "11111111 11111111" } });
    fireEvent.click(screen.getByRole("button", { name: /replace cube with import/i }));

    await waitFor(() => expect(screen.getByText("×2")).toBeTruthy());
    const resolve = (vi.mocked(fetch) as unknown as { mock: { calls: Array<[RequestInfo | URL, RequestInit?]> } }).mock.calls.find(
      ([url, init]) => String(url) === "/api/cards/resolve" && init?.method === "POST",
    );
    expect(resolve).toBeTruthy();
    expect(JSON.parse(String(resolve![1]?.body))).toEqual({ setNames: [], customCardIds: [11111111] });
    fireEvent.click(screen.getByRole("button", { name: /remove turtle tiger from cube/i }));
    await waitFor(() => expect(screen.queryByText("×2")).toBeNull());
    expect(screen.getByRole("button", { name: /remove turtle tiger from cube/i })).toBeTruthy();
  });

  it("keeps the user on /cubes/new when create fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = (init?.method ?? "GET").toUpperCase();
        if (url === "/api/cards/resolve" && method === "POST") return Response.json({ cards: [], unknownIds: [] });
        if (url === "/api/draft-templates" && method === "POST") {
          return Response.json({ error: "Pool name already exists." }, { status: 409 });
        }
        return Response.json({}, { status: 404 });
      }),
    );

    render(<CardPoolEditor mode="create" />);

    fireEvent.change(screen.getByLabelText(/pool name/i), { target: { value: "Goat Cube" } });
    fireEvent.change(screen.getByLabelText(/paste passcodes/i), { target: { value: "33333333" } });
    fireEvent.click(screen.getByRole("button", { name: /replace cube with import/i }));
    fireEvent.click(screen.getByRole("button", { name: /create card pool/i }));

    await waitFor(() => expect(screen.getByText(/pool name already exists/i)).toBeTruthy());
    expect(screen.getByDisplayValue("Goat Cube")).toBeTruthy();
    expect(push).not.toHaveBeenCalled();
  });

  it("updates the preview after importing passcodes from a text file", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = (init?.method ?? "GET").toUpperCase();
        if (url === "/api/cards/resolve" && method === "POST") {
          return Response.json({
            cards: [{ id: 11111111, name: "Turtle Tiger", type: "Normal Monster", frameType: "normal", effectText: "", imageUrl: "u1", imageUrlSmall: "s1" }],
            unknownIds: [],
          });
        }
        return Response.json({}, { status: 404 });
      }),
    );

    render(<CardPoolEditor mode="create" />);

    const file = new File(["11111111\n11111111"], "cube.txt", { type: "text/plain" });
    const input = screen.getByLabelText(/upload text file/i) as HTMLInputElement;

    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => expect(screen.getByText("×2")).toBeTruthy());
    const resolve = (vi.mocked(fetch) as unknown as { mock: { calls: Array<[RequestInfo | URL, RequestInit?]> } }).mock.calls.findLast(
      ([url, init]) => String(url) === "/api/cards/resolve" && init?.method === "POST" && JSON.parse(String(init.body)).customCardIds.length > 0,
    );
    expect(resolve).toBeTruthy();
    expect(JSON.parse(String(resolve![1]?.body))).toEqual({ setNames: [], customCardIds: [11111111] });
  });

  it("does not resolve the whole catalog when all imported passcodes are cached", async () => {
    putCards([{ id: 11111111, name: "Turtle Tiger", type: "Normal Monster", frameType: "normal", effectText: "", imageUrl: "u1", imageUrlSmall: "s1" }]);
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url === "/api/cards/resolve" && method === "POST") {
        return Response.json({
          cards: [{ id: 99999999, name: "Catalog Leak", type: "Spell Card", frameType: "spell", effectText: "", imageUrl: "u9", imageUrlSmall: "s9" }],
          unknownIds: [],
        });
      }
      return Response.json({}, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<CardPoolEditor mode="create" />);

    fireEvent.change(screen.getByLabelText(/paste passcodes/i), { target: { value: "11111111" } });
    fireEvent.click(screen.getByRole("button", { name: /replace cube with import/i }));

    await waitFor(() => expect(screen.getByText("Turtle Tiger")).toBeTruthy());
    expect(screen.queryByText("Catalog Leak")).toBeNull();
    expect(fetchMock.mock.calls.some(([url]) => String(url) === "/api/cards/resolve")).toBe(false);
  });
});
