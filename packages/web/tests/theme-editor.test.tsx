// @vitest-environment jsdom
import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installVirtualizerJsdomEnv } from "./helpers/virtualizer-jsdom";
import { ThemeEditor } from "@/components/themes/theme-editor";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock("next/image", () => ({
  default: ({ alt, fill: _fill, ...props }: React.ImgHTMLAttributes<HTMLImageElement> & { fill?: boolean }) => (
    <img alt={alt} {...props} />
  ),
}));

function card(id: number, name: string, type: string, frameType: string) {
  return { id, name, type, frameType, effectText: "", imageUrl: "i", imageUrlSmall: "i" };
}

const initialDetail = {
  theme: { id: 5, name: "Custom", archetype: null, banlist: null },
  pools: { main: [], extra: [] },
  cards: [],
};

const afterImport = {
  pools: {
    main: [{ catalogCardId: 1, pool: "main", maxCopies: 1 }],
    extra: [{ catalogCardId: 2, pool: "extra", maxCopies: 1 }],
  },
  cards: [card(1, "Main A", "Normal Monster", "normal"), card(2, "Xyz B", "XYZ Monster", "xyz")],
  added: 2,
  unknown: [],
};

describe("ThemeEditor", () => {
  beforeEach(() => {
    installVirtualizerJsdomEnv();
    const fetchMock = vi.fn(async (input: any, init?: any) => {
      const url = String(input);
      if (url.endsWith("/api/themes/5") && (!init || init.method === undefined)) {
        return { ok: true, json: async () => initialDetail } as Response;
      }
      if (url.endsWith("/api/themes/5/cards")) {
        return { ok: true, json: async () => afterImport } as Response;
      }
      return { ok: true, json: async () => ({ cards: [] }) } as Response;
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("imports passcodes and updates the main/extra pool counts", async () => {
    render(<ThemeEditor themeId={5} />);

    // initial load resolves
    await waitFor(() => expect(screen.getByText("Custom")).toBeInTheDocument());
    expect(screen.getByText(/0 main · 0 extra/)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Paste passcodes"), { target: { value: "1\n2" } });
    fireEvent.click(screen.getByRole("button", { name: /add passcodes/i }));

    await waitFor(() => expect(screen.getByText(/1 main · 1 extra/)).toBeInTheDocument());
  });
});
