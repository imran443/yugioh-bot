// @vitest-environment jsdom
import React from "react";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PoolBuilder } from "../../src/components/cards/pool-builder";

vi.mock("@/lib/cards-cache", () => ({
  getCached: vi.fn().mockImplementation((ids: number[]) => ({ hits: [], missing: ids })),
  putCards: vi.fn(),
  clearCardsCache: vi.fn(),
}));

import { getCached, putCards } from "../../src/lib/cards-cache";

vi.mock("next/image", () => ({
  default: ({ alt, fill: _fill, ...props }: React.ImgHTMLAttributes<HTMLImageElement> & { fill?: boolean }) => (
    <img alt={alt} {...props} />
  ),
}));

// SetPicker fetches /api/sets — stub everything via fetch.
function stubFetch() {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("/api/sets")) return Response.json({ sets: [] });
    if (url === "/api/cards/resolve" && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as { cardIds?: number[] };
      const known = (body.cardIds ?? []).filter((id) => id === 46986414);
      return Response.json({
        cards: known.map((id) => ({ id, name: "Dark Magician", type: "Spellcaster / Normal Monster", frameType: "normal", effectText: "", imageUrl: "u", imageUrlSmall: "s" })),
        unknownIds: (body.cardIds ?? []).filter((id) => id !== 46986414),
      });
    }
    return Response.json({}, { status: 404 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("PoolBuilder", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.mocked(getCached).mockImplementation((ids: number[]) => ({ hits: [], missing: ids }));
    vi.mocked(putCards).mockReset();
  });
  afterEach(() => { vi.runOnlyPendingTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

  it("resolves typed custom ids after debounce and shows them in the preview grid", async () => {
    const fetchMock = stubFetch();
    const value = { setNames: [] as string[], customCardText: "" };
    const onChange = vi.fn();
    const { rerender } = render(<PoolBuilder value={value} onChange={onChange} />);

    fireEvent.change(screen.getByLabelText(/custom card ids/i), { target: { value: "46986414\n99999999" } });
    // simulate the controlled update flowing back in
    rerender(<PoolBuilder value={{ setNames: [], customCardText: "46986414\n99999999" }} onChange={onChange} />);

    await act(async () => { vi.advanceTimersByTime(400); });

    await waitFor(() => {
      const resolveCall = fetchMock.mock.calls.find(([u, i]) => String(u) === "/api/cards/resolve" && (i as RequestInit)?.method === "POST");
      expect(resolveCall).toBeTruthy();
      expect(JSON.parse(String((resolveCall![1] as RequestInit).body))).toMatchObject({ cardIds: [46986414, 99999999] });
    });
    await waitFor(() => expect(screen.getByRole("button", { name: /preview dark magician/i })).toBeTruthy());
    expect(screen.getAllByText(/99999999/).length).toBeGreaterThan(0); // unknown placeholder
  });

  it("shows one tile with a ×N badge for repeated custom ids", async () => {
    stubFetch();
    const onChange = vi.fn();
    render(
      <PoolBuilder
        value={{ setNames: [], customCardText: "46986414\n46986414\n46986414" }}
        onChange={onChange}
      />,
    );

    await act(async () => { vi.advanceTimersByTime(400); });

    await waitFor(() => expect(screen.getByRole("button", { name: /preview dark magician/i })).toBeTruthy());
    // Repeats are no longer deduped: the same card type renders as a single
    // tile, but with a ×3 multiplicity badge derived client-side.
    expect(screen.getAllByRole("button", { name: /preview dark magician/i }).length).toBe(1);
    expect(screen.getByText("×3")).toBeTruthy();
  });

  it("shows an error when the API returns non-ok", async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500 });

    render(<PoolBuilder value={{ setNames: [], customCardText: "12345678" }} onChange={vi.fn()} />);
    await act(async () => { vi.advanceTimersByTime(400); });
    await waitFor(() => {
      expect(screen.getByText(/failed to resolve/i)).toBeTruthy();
    });
  });

  it("surfaces invalid passcode tokens", () => {
    stubFetch();
    const onChange = vi.fn();
    render(<PoolBuilder value={{ setNames: [], customCardText: "abc, 12x" }} onChange={onChange} />);
    expect(screen.getByText(/invalid/i)).toBeTruthy();
  });
});
