// @vitest-environment jsdom
import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CubeEditor } from "../../src/components/cubes/cube-editor";
import { clearCardsCache, putCards } from "../../src/lib/cards-cache";
import { installVirtualizerJsdomEnv } from "../helpers/virtualizer-jsdom";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock("next/image", () => ({
  default: ({ alt, fill: _fill, ...props }: React.ImgHTMLAttributes<HTMLImageElement> & { fill?: boolean }) => (
    <img alt={alt} {...props} />
  ),
}));

const templates = [
  { id: 7, name: "Clara Pool", setNames: [], customCardIds: [11111111, 11111111, 22222222] },
  { id: 8, name: "Set Pool", setNames: ["Legacy Set"], customCardIds: [] },
  { id: 9, name: "Mixed Pool", setNames: ["Legacy Set"], customCardIds: [11111111, 11111111] },
  { id: 10, name: "Mixed Cached Pool", setNames: ["Legacy Set"], customCardIds: [11111111, 11111111] },
];

const resolvedCards = [
  { id: 11111111, name: "Turtle Tiger", type: "Normal Monster", frameType: "normal", effectText: "", imageUrl: "u1", imageUrlSmall: "s1" },
  { id: 22222222, name: "Mystic Lamp", type: "Effect Monster", frameType: "effect", effectText: "", imageUrl: "u2", imageUrlSmall: "s2" },
  { id: 33333333, name: "Imported Spell", type: "Spell Card", frameType: "spell", effectText: "", imageUrl: "u3", imageUrlSmall: "s3" },
  { id: 44444444, name: "Monster Reborn", type: "Spell Card", frameType: "spell", effectText: "", imageUrl: "u4", imageUrlSmall: "s4" },
];

function stubFetch() {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    if (url === "/api/draft-templates" && method === "GET") return Response.json({ templates });
    if (url === "/api/cards/resolve" && method === "POST") {
      const body = JSON.parse(String(init?.body ?? "{}")) as { setNames?: string[]; customCardIds?: number[]; cardName?: string; fuzzyName?: string };
      if (body.cardName === "Monster Reborn") {
        return Response.json({ cards: [resolvedCards[3]], unknownIds: [] });
      }
      if (body.cardName === "Missing Card") {
        return Response.json({ error: "No card found for \"Missing Card\"." }, { status: 404 });
      }
      if (body.fuzzyName?.toLowerCase() === "monster reborn") {
        return Response.json({ cards: [resolvedCards[3]], unknownIds: [] });
      }
      if (body.fuzzyName?.toLowerCase() === "blue-eyes") {
        return Response.json({ cards: [resolvedCards[3]], unknownIds: [] });
      }
      if (body.fuzzyName?.toLowerCase() === "missing") {
        return Response.json({ cards: [], unknownIds: [] });
      }
      if (body.setNames?.includes("Legacy Set") && body.customCardIds?.includes(11111111)) {
        return Response.json({ cards: [resolvedCards[0], resolvedCards[0]], unknownIds: [] });
      }
      return Response.json({ cards: resolvedCards.slice(0, 3), unknownIds: [] });
    }
    if (url === "/api/draft-templates/7" && method === "PUT") return Response.json({ template: { id: 7, name: "Clara Pool", setNames: [], customCardIds: [33333333] } });
    if (url === "/api/draft-templates/8" && method === "PUT") return Response.json({ template: { id: 8, name: "Set Pool", setNames: [], customCardIds: [22222222, 33333333] } });
    if (url === "/api/draft-templates/9" && method === "PUT") return Response.json({ template: { id: 9, name: "Mixed Pool", setNames: [], customCardIds: [11111111, 11111111] } });
    if (url === "/api/draft-templates/10" && method === "PUT") return Response.json({ template: { id: 10, name: "Mixed Cached Pool", setNames: [], customCardIds: [11111111, 11111111, 22222222, 33333333] } });
    return Response.json({}, { status: 404 });
  });
}

describe("CubeEditor", () => {
  // CardPoolGrid is virtualized; jsdom reports 0-size elements so the
  // virtualizer renders no rows without this shim.
  beforeEach(() => installVirtualizerJsdomEnv());
  afterEach(() => {
    clearCardsCache();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("removes one copy of a duplicate card per click", async () => {
    const fetchMock = stubFetch();
    vi.stubGlobal("fetch", fetchMock);

    render(<CubeEditor poolId={7} />);

    await waitFor(() => expect(screen.getByDisplayValue("Clara Pool")).toBeTruthy());
    await waitFor(() => expect(screen.getByText("×2")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: /remove turtle tiger from cube/i }));

    await waitFor(() => expect(screen.queryByText("×2")).toBeNull());
    expect(screen.getByRole("button", { name: /remove turtle tiger from cube/i })).toBeTruthy();
    expect(screen.getByText(/unsaved changes/i)).toBeTruthy();
  });

  it("uses the sharper image URLs in the cube editor grid", async () => {
    const fetchMock = stubFetch();
    vi.stubGlobal("fetch", fetchMock);

    render(<CubeEditor poolId={7} />);

    await waitFor(() => expect(screen.getByDisplayValue("Clara Pool")).toBeTruthy());
    await waitFor(() => expect(screen.getByRole("img", { name: "Turtle Tiger" })).toHaveAttribute("src", "u1"));
  });

  it("replaces passcodes from pasted import text and saves cleared sets", async () => {
    const fetchMock = stubFetch();
    vi.stubGlobal("fetch", fetchMock);

    render(<CubeEditor poolId={7} />);

    await waitFor(() => expect(screen.getByDisplayValue("Clara Pool")).toBeTruthy());
    fireEvent.change(screen.getByLabelText(/paste passcodes/i), { target: { value: "33333333 33333333" } });
    fireEvent.click(screen.getByRole("button", { name: /replace cube with import/i }));
    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));

    await waitFor(() => {
      const put = fetchMock.mock.calls.find(([url, init]) => String(url) === "/api/draft-templates/7" && (init as RequestInit)?.method === "PUT");
      expect(put).toBeTruthy();
      expect(JSON.parse(String((put![1] as RequestInit).body))).toEqual({ name: "Clara Pool", setNames: [], customCardIds: [33333333, 33333333] });
    });
  });

  it("removes a set-derived card by saving the remaining cards as passcodes", async () => {
    const fetchMock = stubFetch();
    vi.stubGlobal("fetch", fetchMock);

    render(<CubeEditor poolId={8} />);

    await waitFor(() => expect(screen.getByDisplayValue("Set Pool")).toBeTruthy());
    await waitFor(() => expect(screen.getByRole("button", { name: /remove turtle tiger from cube/i })).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: /remove turtle tiger from cube/i }));
    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));

    await waitFor(() => {
      const put = fetchMock.mock.calls.find(([url, init]) => String(url) === "/api/draft-templates/8" && (init as RequestInit)?.method === "PUT");
      expect(put).toBeTruthy();
      expect(JSON.parse(String((put![1] as RequestInit).body))).toEqual({ name: "Set Pool", setNames: [], customCardIds: [22222222, 33333333] });
    });
  });

  it("counts set-derived and duplicate passcode copies of the same card", async () => {
    const fetchMock = stubFetch();
    vi.stubGlobal("fetch", fetchMock);

    render(<CubeEditor poolId={9} />);

    await waitFor(() => expect(screen.getByDisplayValue("Mixed Pool")).toBeTruthy());
    await waitFor(() => expect(screen.getByText("×3")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: /remove turtle tiger from cube/i }));
    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));

    await waitFor(() => {
      const put = fetchMock.mock.calls.find(([url, init]) => String(url) === "/api/draft-templates/9" && (init as RequestInit)?.method === "PUT");
      expect(put).toBeTruthy();
      expect(JSON.parse(String((put![1] as RequestInit).body))).toEqual({ name: "Mixed Pool", setNames: [], customCardIds: [11111111, 11111111] });
    });
  });

  it("removes one visible copy from a mixed pool when duplicate passcodes are already cached", async () => {
    putCards([resolvedCards[0]]);
    const fetchMock = stubFetch();
    vi.stubGlobal("fetch", fetchMock);

    render(<CubeEditor poolId={10} />);

    await waitFor(() => expect(screen.getByDisplayValue("Mixed Cached Pool")).toBeTruthy());
    await waitFor(() => expect(screen.getByText("×3")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: /remove turtle tiger from cube/i }));
    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));

    await waitFor(() => {
      const put = fetchMock.mock.calls.find(([url, init]) => String(url) === "/api/draft-templates/10" && (init as RequestInit)?.method === "PUT");
      expect(put).toBeTruthy();
      expect(JSON.parse(String((put![1] as RequestInit).body))).toEqual({
        name: "Mixed Cached Pool",
        setNames: [],
        customCardIds: [11111111, 11111111, 22222222, 33333333],
      });
    });
  });

  it("adds one card by clicking a fuzzy search result", async () => {
    const fetchMock = stubFetch();
    vi.stubGlobal("fetch", fetchMock);

    render(<CubeEditor poolId={7} />);

    await waitFor(() => expect(screen.getByDisplayValue("Clara Pool")).toBeTruthy());
    const searchInput = screen.getByLabelText(/search card name/i);
    fireEvent.focus(searchInput);
    fireEvent.change(searchInput, { target: { value: "Monster Reborn" } });
    await waitFor(() => expect(screen.getAllByTestId("card-search-result").length).toBeGreaterThan(0), { timeout: 2000 });
    fireEvent.click(screen.getAllByTestId("card-search-result")[0]);

    await waitFor(() => expect(screen.getByText(/4 passcodes/i)).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));

    await waitFor(() => {
      const put = fetchMock.mock.calls.find(([url, init]) => String(url) === "/api/draft-templates/7" && (init as RequestInit)?.method === "PUT");
      expect(put).toBeTruthy();
      expect(JSON.parse(String((put![1] as RequestInit).body))).toEqual({
        name: "Clara Pool",
        setNames: [],
        customCardIds: [11111111, 11111111, 22222222, 44444444],
      });
    });
  });

  it("adds multiple copies by clicking the same search result repeatedly", async () => {
    const fetchMock = stubFetch();
    vi.stubGlobal("fetch", fetchMock);

    render(<CubeEditor poolId={7} />);

    await waitFor(() => expect(screen.getByDisplayValue("Clara Pool")).toBeTruthy());
    const searchInput = screen.getByLabelText(/search card name/i);
    fireEvent.focus(searchInput);
    fireEvent.change(searchInput, { target: { value: "Monster Reborn" } });
    await waitFor(() => expect(screen.getAllByTestId("card-search-result").length).toBeGreaterThan(0), { timeout: 2000 });
    fireEvent.click(screen.getAllByTestId("card-search-result")[0]);
    await waitFor(() => expect(screen.getByText(/4 passcodes/i)).toBeTruthy());
    fireEvent.focus(searchInput);
    fireEvent.click(screen.getAllByTestId("card-search-result")[0]);

    await waitFor(() => expect(screen.getAllByText("×2").length).toBeGreaterThanOrEqual(1));
  });

  it("converts visible set-derived cards to passcodes before adding from search", async () => {
    const fetchMock = stubFetch();
    vi.stubGlobal("fetch", fetchMock);

    render(<CubeEditor poolId={8} />);

    await waitFor(() => expect(screen.getByDisplayValue("Set Pool")).toBeTruthy());
    await waitFor(() => expect(screen.getByRole("button", { name: /remove turtle tiger from cube/i })).toBeTruthy());
    const searchInput = screen.getByLabelText(/search card name/i);
    fireEvent.focus(searchInput);
    fireEvent.change(searchInput, { target: { value: "Monster Reborn" } });
    await waitFor(() => expect(screen.getAllByTestId("card-search-result").length).toBeGreaterThan(0), { timeout: 2000 });
    fireEvent.click(screen.getAllByTestId("card-search-result")[0]);
    await waitFor(() => expect(screen.getByText(/4 passcodes/i)).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));

    await waitFor(() => {
      const put = fetchMock.mock.calls.find(([url, init]) => String(url) === "/api/draft-templates/8" && (init as RequestInit)?.method === "PUT");
      expect(put).toBeTruthy();
      expect(JSON.parse(String((put![1] as RequestInit).body))).toEqual({
        name: "Set Pool",
        setNames: [],
        customCardIds: [11111111, 22222222, 33333333, 44444444],
      });
    });
  });

  it("does not add a card when search returns no results", async () => {
    const fetchMock = stubFetch();
    vi.stubGlobal("fetch", fetchMock);

    render(<CubeEditor poolId={7} />);

    await waitFor(() => expect(screen.getByDisplayValue("Clara Pool")).toBeTruthy());
    const searchInput = screen.getByLabelText(/search card name/i);
    fireEvent.focus(searchInput);
    fireEvent.change(searchInput, { target: { value: "missing" } });
    await waitFor(() => expect(screen.queryByText("Monster Reborn")).toBeNull(), { timeout: 2000 });
    expect(screen.queryByText(/added 1 copy/i)).toBeNull();
  });
});
