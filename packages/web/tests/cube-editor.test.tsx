// @vitest-environment jsdom
import React from "react";
import { act, render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CubeEditor } from "@/components/cubes/cube-editor";
import styles from "@/components/cubes/cubes.module.css";

vi.mock("next/font/google", () => {
  const font = () => ({ variable: "font-var", className: "font-class" });
  return { Oxanium: font, Sofia_Sans_Semi_Condensed: font, Sofia_Sans_Extra_Condensed: font, Newsreader: font };
});

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

type Entry = { catalogCardId: number; pool: "main" | "extra"; maxCopies: number };

function card(id: number, name: string, type: string, frameType: string) {
  return { id, name, type, frameType, effectText: "", imageUrl: "i", imageUrlSmall: "i" };
}

const CARDS = [card(1, "Main A", "Normal Monster", "normal"), card(2, "Xyz B", "XYZ Monster", "xyz")];

let main: Entry[];
let extra: Entry[];
let posts: Array<Record<string, unknown>>;
let banlist: string | null;
let draftType: string | undefined;
let settings: Record<string, number>;
let puts: Array<Record<string, unknown>>;
let resolves: Array<Record<string, unknown>>;
/** When set, the next card search answers only after this promise settles. */
let resolveGate: Promise<void> | null;
/** When true, card searches answer 502 like an unreachable card database. */
let resolveFails: boolean;
/** When set, the next write to the cube's cards is refused like this. */
let importFailure: { status: number; error: string; retryAfter?: string } | null;

function detail() {
  return { pools: { main: [...main], extra: [...extra] }, cards: CARDS };
}

beforeEach(() => {
  main = [];
  extra = [];
  posts = [];
  banlist = null;
  draftType = undefined;
  settings = {};
  puts = [];
  resolves = [];
  resolveGate = null;
  resolveFails = false;
  importFailure = null;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/cubes/5/cards")) {
        const body = JSON.parse(String(init?.body)) as Record<string, any>;
        if (importFailure) {
          const failure = importFailure;
          importFailure = null;
          return {
            ok: false,
            status: failure.status,
            headers: new Headers(failure.retryAfter ? { "Retry-After": failure.retryAfter } : {}),
            json: async () => ({ error: failure.error }),
          } as Response;
        }
        posts.push(body);
        if (body.op === "subtract") {
          for (const e of body.entries as Array<{ id: number; copies: number; pool: "main" | "extra" }>) {
            const lower = (list: Entry[]) =>
              list
                .map((x) => (x.catalogCardId === e.id ? { ...x, maxCopies: Math.max(0, x.maxCopies - e.copies) } : x))
                .filter((x) => x.maxCopies > 0);
            if (e.pool === "main") main = lower(main);
            else extra = lower(extra);
          }
          return { ok: true, json: async () => detail() } as Response;
        }
        if (body.op === "import") {
          main = [{ catalogCardId: 1, pool: "main", maxCopies: 1 }];
          extra = [{ catalogCardId: 2, pool: "extra", maxCopies: 1 }];
          return { ok: true, json: async () => ({ ...detail(), added: 2, unknown: [] }) } as Response;
        }
        if (body.op === "importYdk") {
          main = [{ catalogCardId: 1, pool: "main", maxCopies: 3 }];
          extra = [{ catalogCardId: 2, pool: "extra", maxCopies: 1 }];
          return {
            ok: true,
            json: async () => ({ ...detail(), added: 2, copies: 4, unknown: [777, 888] }),
          } as Response;
        }
        if (body.op === "importList") {
          if (String(body.text).includes("NOPE")) {
            const limited = String(body.text).includes("LIMITED") ? { lookupLimited: true } : {};
            return { ok: true, json: async () => ({ ...detail(), added: 0, copies: 0, unknown: ["NOPE"], corrected: [], ...limited }) } as Response;
          }
          if (String(body.text).includes("MORE")) {
            main = main.map((e) => (e.catalogCardId === 1 ? { ...e, maxCopies: e.maxCopies + 2 } : e));
            return { ok: true, json: async () => ({ ...detail(), added: 0, copies: 2, unknown: [], corrected: [] }) } as Response;
          }
          main = [{ catalogCardId: 1, pool: "main", maxCopies: 3 }];
          extra = [{ catalogCardId: 2, pool: "extra", maxCopies: 1 }];
          return {
            ok: true,
            json: async () => ({
              ...detail(),
              added: 2,
              copies: 4,
              unknown: ["Engines", "Glue"],
              corrected: [{ from: "Artifact Moraltech", to: "Artifact Moralltach" }],
              ...(String(body.text).includes("LIMITED") ? { lookupLimited: true, movedToMain: 2 } : {}),
            }),
          } as Response;
        }
        if (body.op === "setMaxCopies") {
          main = main.map((e) => (e.catalogCardId === body.catalogCardId ? { ...e, maxCopies: body.maxCopies } : e));
        } else if (body.op === "remove") {
          main = main.filter((e) => e.catalogCardId !== body.catalogCardId);
          extra = extra.filter((e) => e.catalogCardId !== body.catalogCardId);
        } else if (body.op === "add") {
          main = [...main, { catalogCardId: body.catalogCardId, pool: "main", maxCopies: body.maxCopies ?? 3 }];
        }
        return { ok: true, json: async () => detail() } as Response;
      }
      if (url.endsWith("/api/cubes/5")) {
        if (init?.method === "PUT") {
          const body = JSON.parse(String(init.body)) as Record<string, unknown>;
          puts.push(body);
          if (typeof body.draftType === "string") draftType = body.draftType;
          return { ok: true, json: async () => ({ ok: true }) } as Response;
        }
        return {
          ok: true,
          json: async () => ({ cube: { id: 5, name: "Custom", archetype: null, banlist, draftType, settings }, ...detail() }),
        } as Response;
      }
      if (url.endsWith("/api/cards/resolve")) {
        resolves.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        if (resolveGate) await resolveGate;
        if (resolveFails) return { ok: false, status: 502, json: async () => ({ error: "unavailable" }) } as Response;
        return { ok: true, json: async () => ({ cards: CARDS }) } as Response;
      }
      return { ok: true, json: async () => ({ cards: [] }) } as Response;
    }),
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function open(themeDraftsEnabled = true) {
  render(<CubeEditor cubeId={5} themeDraftsEnabled={themeDraftsEnabled} />);
  await screen.findByRole("heading", { name: "Custom" });
}

describe("CubeEditor card name search", () => {
  it("lists matches for a typed name, asks for Extra Deck cards too, and Enter adds the top match", async () => {
    await open();
    const input = screen.getByLabelText("Card name");
    fireEvent.change(input, { target: { value: "xyz b" } });

    const list = await screen.findByRole("listbox", { name: "Results for xyz b" });
    const rows = within(list).getAllByRole("option");
    expect(rows.map((row) => row.querySelector(".n")?.textContent)).toEqual(["Main A", "Xyz B"]);
    // The row is the only control: no button sits inside an option.
    expect(within(list).queryAllByRole("button")).toHaveLength(0);
    expect(rows[1]).toHaveTextContent("XYZ Monster, Extra");
    expect(resolves.at(-1)).toEqual({ fuzzyName: "xyz b", includeExtra: true });
    expect(input).toHaveAttribute("role", "combobox");
    expect(input).toHaveAttribute("aria-activedescendant", rows[0].id);

    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(within(list).getAllByRole("option")[1]).toHaveAttribute("aria-selected", "true");
    expect(fireEvent.keyDown(input, { key: "Enter" })).toBe(false);

    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toMatchObject({ op: "add", catalogCardId: 2, pool: "extra" });
  });

  it("says the search failed instead of no match and searches again on Try again", async () => {
    await open();
    resolveFails = true;
    const input = screen.getByLabelText("Card name");
    fireEvent.change(input, { target: { value: "xyz b" } });

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/did not work/i);
    expect(screen.queryByText("No cards match.")).toBeNull();
    expect(screen.queryByText("Searching...")).toBeNull();

    resolveFails = false;
    fireEvent.click(within(alert).getByRole("button", { name: "Try again" }));
    await screen.findByRole("listbox", { name: "Results for xyz b" });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("adds a card with a click on its row", async () => {
    await open();
    fireEvent.change(screen.getByLabelText("Card name"), { target: { value: "xyz b" } });
    const list = await screen.findByRole("listbox", { name: "Results for xyz b" });
    fireEvent.click(within(list).getAllByRole("option")[0]);
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toMatchObject({ op: "add", catalogCardId: 1 });
  });

  it("does nothing on Enter while the results answer an older text, and ignores an IME Enter", async () => {
    await open();
    const input = screen.getByLabelText("Card name");
    fireEvent.change(input, { target: { value: "xyz b" } });
    const list = await screen.findByRole("listbox", { name: "Results for xyz b" });
    expect(fireEvent.keyDown(input, { key: "Enter", isComposing: true })).toBe(false);

    let release!: () => void;
    resolveGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    fireEvent.change(input, { target: { value: "xyz bb" } });
    await waitFor(() => expect(resolves.at(-1)).toEqual({ fuzzyName: "xyz bb", includeExtra: true }));
    expect(list).toHaveAttribute("data-stale");
    expect(fireEvent.keyDown(input, { key: "Enter" })).toBe(false);
    expect(posts).toHaveLength(0);

    release();
    await waitFor(() => expect(screen.getByRole("listbox")).not.toHaveAttribute("data-stale"));
    expect(posts).toHaveLength(0);
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(posts).toHaveLength(1));
  });
});

describe("CubeEditor", () => {
  it.each(["TCG", null])("lists header facts as plain items while saving (%s banlist)", async (currentBanlist) => {
    banlist = currentBanlist;
    main = [{ catalogCardId: 1, pool: "main", maxCopies: 2 }];
    extra = [{ catalogCardId: 2, pool: "extra", maxCopies: 1 }];
    await open();

    expect(screen.getByRole("heading", { name: "Custom" })).toBeInTheDocument();
    const header = screen.getByRole("region", { name: "Cube summary" });
    const lines = [header.querySelector(`.${styles.facts}`)!, header.querySelector(`.${styles.counts}`)!];
    const expectedOrigin = currentBanlist ? ["Built by hand", "TCG banlist"] : ["Built by hand"];
    const expectFacts = (line: Element, expected: string[]) => {
      const items = Array.from(line.children);
      expect(items.map((item) => item.textContent)).toEqual(expected);
      expect(line.querySelector(".dot")).toBeNull();
      return items;
    };
    expectFacts(lines[0]!, expectedOrigin);
    expectFacts(lines[1]!, ["Main 1 card, 2 copies", "Extra 1 card, 1 copy"]);
    expect(Array.from(lines[1]!.querySelectorAll("b"), (count) => count.textContent)).toEqual(["1", "2", "1", "1"]);
    expect(screen.queryByText("Saving…")).not.toBeInTheDocument();

    let finishSave!: (response: Response) => void;
    const pendingSave = new Promise<Response>((resolve) => { finishSave = resolve; });
    const fetchCube = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation((input, init) =>
      String(input).endsWith("/api/cubes/5/cards") ? pendingSave : fetchCube(input, init),
    );
    fireEvent.click(screen.getByRole("button", { name: "Main A, 2 copies" }));
    fireEvent.click(screen.getByRole("button", { name: "One more copy" }));

    await screen.findByText("Saving…");
    const savingItems = expectFacts(lines[0]!, [...expectedOrigin, "Saving…"]);
    expect(savingItems[savingItems.length - 1]).toHaveClass(styles.busy);

    main = [{ catalogCardId: 1, pool: "main", maxCopies: 3 }];
    finishSave(Response.json(detail()));
    await waitFor(() => expect(screen.queryByText("Saving…")).not.toBeInTheDocument());
    expectFacts(lines[0]!, expectedOrigin);
    expectFacts(lines[1]!, ["Main 1 card, 3 copies", "Extra 1 card, 1 copy"]);
  });

  const pasteInto = (label: string, text: string) =>
    fireEvent.paste(screen.getByLabelText(label), { clipboardData: { getData: () => text } });

  it("adds pasted passcodes at once, with no Add button, and updates the pool counts", async () => {
    await open();

    fireEvent.click(screen.getByRole("button", { name: "Passcodes" }));
    expect(screen.queryByRole("button", { name: /add passcodes/i })).toBeNull();
    pasteInto("Passcodes, one per line", "1\n2");

    await screen.findByText("Pasted list - 2 cards (1 Main, 1 Extra)");
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ op: "import", codes: [1, 2] });
    expect(screen.getByLabelText("Passcodes, one per line")).toHaveValue("");
    expect(screen.getByRole("button", { name: /Main\s*1/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Extra\s*1/ })).toBeInTheDocument();
  });

  it("does not post half-typed passcodes and shows a message for a bad one", async () => {
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Passcodes" }));
    pasteInto("Passcodes, one per line", "1\nabc");
    expect(await screen.findByRole("alert")).toHaveTextContent("Remove invalid passcodes: abc");
    expect(posts).toEqual([]);
    expect(screen.getByLabelText("Passcodes, one per line")).toHaveValue("1\nabc");
  });

  it("adds a pasted YDK at once and reports the cards, and the passcodes it skipped", async () => {
    await open();

    fireEvent.click(screen.getByRole("button", { name: "YDK" }));
    expect(screen.queryByRole("button", { name: "Add deck list" })).toBeNull();
    const text = "#main\n1\n1\n1\n#extra\n2\n";
    pasteInto("Deck list (.ydk)", text);

    await screen.findByText("Pasted list - 4 cards (3 Main, 1 Extra) - 2 lines skipped");
    expect(posts).toEqual([{ op: "importYdk", text }]);
    expect(screen.getByRole("button", { name: /Main\s*1/ })).toBeInTheDocument();
  });

  it("adds a pasted card list at once, with the report collapsed", async () => {
    await open();

    fireEvent.click(screen.getByRole("button", { name: "Card list" }));
    expect(screen.queryByRole("button", { name: "Add list" })).toBeNull();
    const text = "Engines\n3 Dark Hole\n1 Artifact Moraltech\nGlue";
    pasteInto("Card list", text);

    await screen.findByText("Pasted list - 4 cards (3 Main, 1 Extra) - 1 name corrected - 2 lines skipped");
    expect(posts).toEqual([{ op: "importList", text }]);
    const report = screen.getByTestId("list-import-report");
    expect(within(report).getByRole("list", { name: "Corrected names", hidden: true })).toHaveTextContent("Artifact Moralltach");
    expect(within(report).getByRole("list", { name: "Skipped lines", hidden: true })).toHaveTextContent("Engines");
    expect(screen.getByLabelText("Card list")).toHaveValue("");
    expect(screen.getByRole("button", { name: /Main\s*1/ })).toBeInTheDocument();
  });

  it("tells when some cards were not looked up and when Extra cards went to Main", async () => {
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Card list" }));
    pasteInto("Card list", "3 Dark Hole\nLIMITED");

    await screen.findByText(/^Pasted list - 4 cards/);
    const report = screen.getByTestId("list-import-report");
    expect(within(report).getByText("Some cards were not looked up this time. Add the list again to look up the rest.")).toBeInTheDocument();
    expect(within(report).getByText("2 cards listed under Extra are not Extra Deck monsters - added to Main")).toBeInTheDocument();
  });

  it("says the lookup was limited when nothing was added", async () => {
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Card list" }));
    pasteInto("Card list", "NOPE LIMITED");

    expect(await screen.findByText("No cards found in that list.")).toBeInTheDocument();
    expect(screen.getByText("Some cards were not looked up this time. Add the list again to look up the rest.")).toBeInTheDocument();
  });

  it("never adds typed text by itself, and adds it on Enter once", async () => {
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Card list" }));
    const box = screen.getByLabelText("Card list");
    fireEvent.change(box, { target: { value: "3 Dark Ho" } });
    await new Promise((r) => setTimeout(r, 1200));
    expect(posts).toEqual([]);
    expect(box).toHaveValue("3 Dark Ho");
    expect(fireEvent.keyDown(box, { key: "Enter", shiftKey: true })).toBe(true);
    expect(posts).toEqual([]);
    fireEvent.keyDown(box, { key: "Enter" });
    await screen.findByText(/^Pasted list - 4 cards/);
    await new Promise((r) => setTimeout(r, 1000));
    expect(posts).toHaveLength(1);
  });

  it("adds typed text with the Add button", async () => {
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Card list" }));
    expect(screen.getByRole("button", { name: "Add" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Card list"), { target: { value: "3 Dark Hole" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await screen.findByText(/^Pasted list - 4 cards/);
    expect(posts).toHaveLength(1);
  });

  it("adds a loaded .txt file at once and names the entry after the file", async () => {
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Card list" }));
    const file = new File(["3 Dark Hole\nGlue\n"], "Flip.txt", { type: "text/plain" });
    fireEvent.change(screen.getByLabelText("Upload card list file"), { target: { files: [file] } });
    await screen.findByText(/^Flip\.txt - 4 cards \(3 Main, 1 Extra\)/);
    expect(posts[0]).toMatchObject({ op: "importList", text: "3 Dark Hole\nGlue\n" });
    expect(screen.getByLabelText("Card list")).toHaveValue("");
  });

  it("says no cards were found when the list imports nothing, and keeps the text", async () => {
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Card list" }));
    pasteInto("Card list", "NOPE");
    await screen.findByText("No cards found in that list.");
    expect(screen.getByText("Skipped 1 line that is not a card name")).toBeInTheDocument();
    expect(screen.getByLabelText("Card list")).toHaveValue("NOPE");
    expect(screen.queryByRole("list", { name: "Added lists" })).toBeNull();
  });

  it("shows the wait time when the card database is busy (503 Retry-After)", async () => {
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Card list" }));
    importFailure = { status: 503, error: "The card database is busy.", retryAfter: "7" };
    pasteInto("Card list", "3 Dark Hole");
    expect(await screen.findByRole("alert")).toHaveTextContent("The card database is busy. Wait 7 seconds, then try again.");
    expect(screen.getByLabelText("Card list")).toHaveValue("3 Dark Hole");
    expect(screen.getByRole("button", { name: "Try again" })).toBeDisabled();
  });

  it("loads a .ydk file and adds it at once", async () => {
    await open();
    fireEvent.click(screen.getByRole("button", { name: "YDK" }));
    const file = new File(["#main\n1\n"], "deck.ydk", { type: "" });
    fireEvent.change(screen.getByLabelText("Upload card list file"), { target: { files: [file] } });
    await screen.findByText(/^deck\.ydk - 4 cards/);
    expect(posts[0]).toEqual({ op: "importYdk", text: "#main\n1\n" });
  });

  describe("Remove on an import entry", () => {
    it("takes out only the copies the import added and keeps the ones the cube had", async () => {
      main = [{ catalogCardId: 1, pool: "main", maxCopies: 2 }];
      await open();
      fireEvent.click(screen.getByRole("button", { name: "Card list" }));
      pasteInto("Card list", "3 Dark Hole");
      await screen.findByText(/^Pasted list - 2 cards \(1 Main, 1 Extra\)/);
      posts.length = 0;

      fireEvent.click(screen.getByRole("button", { name: "Remove Pasted list" }));
      await waitFor(() => expect(screen.queryByRole("list", { name: "Added lists" })).toBeNull());
      // One call for the whole import, with only the copies it added.
      expect(posts).toEqual([
        {
          op: "subtract",
          entries: [
            { id: 1, copies: 1, pool: "main" },
            { id: 2, copies: 1, pool: "extra" },
          ],
        },
      ]);
      expect(main).toEqual([{ catalogCardId: 1, pool: "main", maxCopies: 2 }]);
      expect(extra).toEqual([]);
    });

    it("stacks entries, and removing one leaves the other in the list", async () => {
      await open();
      fireEvent.click(screen.getByRole("button", { name: "Card list" }));
      pasteInto("Card list", "3 Dark Hole");
      await screen.findByText(/^Pasted list - /);
      pasteInto("Card list", "MORE");
      await screen.findByText(/^Pasted list 2 - 2 cards \(2 Main, 0 Extra\)/);
      expect(within(screen.getByRole("list", { name: "Added lists" })).getAllByRole("button", { name: /^Remove / })).toHaveLength(2);
      fireEvent.click(screen.getByRole("button", { name: "Remove Pasted list 2" }));
      await waitFor(() => expect(within(screen.getByRole("list", { name: "Added lists" })).getAllByRole("button", { name: /^Remove / })).toHaveLength(1));
      expect(screen.getByText(/^Pasted list - /)).toBeInTheDocument();
    });

    it("shows a message when the cube refuses the removal, and keeps the entry", async () => {
      await open();
      fireEvent.click(screen.getByRole("button", { name: "Card list" }));
      pasteInto("Card list", "3 Dark Hole");
      await screen.findByText(/^Pasted list - /);
      importFailure = { status: 409, error: "This cube is in a running draft." };
      fireEvent.click(screen.getByRole("button", { name: "Remove Pasted list" }));
      expect(await screen.findByText("This cube is in a running draft.")).toBeInTheDocument();
      expect(screen.getByText(/^Pasted list - /)).toBeInTheDocument();
    });

    it("does not take back copies the owner lowered after the import (3, import to 5, lowered to 3, Remove leaves 3)", async () => {
      main = [{ catalogCardId: 1, pool: "main", maxCopies: 3 }];
      await open();
      fireEvent.click(screen.getByRole("button", { name: "Card list" }));
      pasteInto("Card list", "MORE");
      await screen.findByText(/^Pasted list - 2 cards \(2 Main, 0 Extra\)/);
      expect(main[0]!.maxCopies).toBe(5);

      fireEvent.click(screen.getByRole("button", { name: "Main A, 5 copies" }));
      fireEvent.click(screen.getByRole("button", { name: "One fewer copy" }));
      await waitFor(() => expect(main[0]!.maxCopies).toBe(4));
      await waitFor(() => expect(screen.getByRole("button", { name: "One fewer copy" })).toBeEnabled());
      fireEvent.click(screen.getByRole("button", { name: "One fewer copy" }));
      await waitFor(() => expect(main[0]!.maxCopies).toBe(3));
      await waitFor(() => expect(screen.getByRole("button", { name: "One fewer copy" })).toBeEnabled());
      fireEvent.click(screen.getByRole("button", { name: "Close, back to Add cards" }));
      fireEvent.click(screen.getByRole("button", { name: "Card list" }));
      posts.length = 0;

      fireEvent.click(screen.getByRole("button", { name: "Remove Pasted list" }));
      await waitFor(() => expect(screen.queryByRole("list", { name: "Added lists" })).toBeNull());
      // Nothing of the import is left, so no request goes out and the card keeps its 3 copies.
      expect(posts).toEqual([]);
      expect(main).toEqual([{ catalogCardId: 1, pool: "main", maxCopies: 3 }]);
    });

    it("removes two stacked imports in either order and ends at the starting copies", async () => {
      main = [{ catalogCardId: 1, pool: "main", maxCopies: 3 }];
      await open();
      fireEvent.click(screen.getByRole("button", { name: "Card list" }));
      pasteInto("Card list", "MORE");
      await screen.findByText(/^Pasted list - 2 cards/);
      pasteInto("Card list", "MORE");
      await screen.findByText(/^Pasted list 2 - 2 cards/);
      expect(main[0]!.maxCopies).toBe(7);
      posts.length = 0;

      fireEvent.click(screen.getByRole("button", { name: "Remove Pasted list" }));
      await waitFor(() => expect(screen.queryByText(/^Pasted list - /)).toBeNull());
      expect(posts).toEqual([{ op: "subtract", entries: [{ id: 1, copies: 2, pool: "main" }] }]);
      expect(main[0]!.maxCopies).toBe(5);

      fireEvent.click(screen.getByRole("button", { name: "Remove Pasted list 2" }));
      await waitFor(() => expect(screen.queryByRole("list", { name: "Added lists" })).toBeNull());
      expect(posts[1]).toEqual({ op: "subtract", entries: [{ id: 1, copies: 2, pool: "main" }] });
      expect(main).toEqual([{ catalogCardId: 1, pool: "main", maxCopies: 3 }]);
    });

    it("takes the owner's lowering from the newest import first", async () => {
      main = [{ catalogCardId: 1, pool: "main", maxCopies: 3 }];
      await open();
      fireEvent.click(screen.getByRole("button", { name: "Card list" }));
      pasteInto("Card list", "MORE");
      await screen.findByText(/^Pasted list - 2 cards/);
      pasteInto("Card list", "MORE");
      await screen.findByText(/^Pasted list 2 - 2 cards/);
      fireEvent.click(screen.getByRole("button", { name: "Main A, 7 copies" }));
      fireEvent.click(screen.getByRole("button", { name: "One fewer copy" }));
      await waitFor(() => expect(main[0]!.maxCopies).toBe(6));
      await waitFor(() => expect(screen.getByRole("button", { name: "One fewer copy" })).toBeEnabled());
      fireEvent.click(screen.getByRole("button", { name: "Close, back to Add cards" }));
      fireEvent.click(screen.getByRole("button", { name: "Card list" }));
      posts.length = 0;

      // The newest import lost one copy to the owner, the oldest still has its two.
      fireEvent.click(screen.getByRole("button", { name: "Remove Pasted list 2" }));
      await waitFor(() => expect(screen.queryByText(/^Pasted list 2 - /)).toBeNull());
      expect(posts).toEqual([{ op: "subtract", entries: [{ id: 1, copies: 1, pool: "main" }] }]);
      expect(main[0]!.maxCopies).toBe(5);
    });

    it("keeps the entry and the same amounts after a refusal, so a retry cannot take twice", async () => {
      main = [{ catalogCardId: 1, pool: "main", maxCopies: 3 }];
      await open();
      fireEvent.click(screen.getByRole("button", { name: "Card list" }));
      pasteInto("Card list", "MORE");
      await screen.findByText(/^Pasted list - 2 cards/);
      posts.length = 0;
      importFailure = { status: 409, error: "This cube is in a running draft." };
      fireEvent.click(screen.getByRole("button", { name: "Remove Pasted list" }));
      expect(await screen.findByText("This cube is in a running draft.")).toBeInTheDocument();
      expect(main[0]!.maxCopies).toBe(5);

      fireEvent.click(screen.getByRole("button", { name: "Remove Pasted list" }));
      await waitFor(() => expect(screen.queryByRole("list", { name: "Added lists" })).toBeNull());
      expect(posts).toEqual([{ op: "subtract", entries: [{ id: 1, copies: 2, pool: "main" }] }]);
      expect(main[0]!.maxCopies).toBe(3);
    });
  });

  it("offers the cube as a .ydk download", async () => {
    await open();
    const link = screen.getByRole("link", { name: /Export YDK/ });
    expect(link).toHaveAttribute("href", "/api/cubes/5/ydk");
    expect(link).toHaveAttribute("download");
  });

  describe("with a card in the cube", () => {
    beforeEach(() => {
      main = [{ catalogCardId: 1, pool: "main", maxCopies: 2 }];
    });

    it("selects on click and does not remove", async () => {
      await open();
      const tile = screen.getByRole("button", { name: "Main A, 2 copies" });
      fireEvent.click(tile);
      expect(tile).toHaveAttribute("aria-pressed", "true");
      expect(screen.getByRole("heading", { name: "Selected" })).toBeInTheDocument();
      expect(posts).toHaveLength(0);
    });

    it("steps copies with setMaxCopies, past three, and stops at 1", async () => {
      await open();
      fireEvent.click(screen.getByRole("button", { name: "Main A, 2 copies" }));
      fireEvent.click(screen.getByRole("button", { name: "One more copy" }));
      await waitFor(() => expect(posts).toHaveLength(1));
      expect(posts[0]).toEqual({ op: "setMaxCopies", catalogCardId: 1, maxCopies: 3 });
      // Three is no ceiling: the plus button stays on.
      await waitFor(() => expect(screen.getByRole("button", { name: "One more copy" })).toBeEnabled());
      fireEvent.click(screen.getByRole("button", { name: "One more copy" }));
      await waitFor(() => expect(posts).toHaveLength(2));
      expect(posts[1]).toEqual({ op: "setMaxCopies", catalogCardId: 1, maxCopies: 4 });
    });

    it("stops at 1 copy and at 99 copies", async () => {
      main = [{ catalogCardId: 1, pool: "main", maxCopies: 1 }];
      await open();
      fireEvent.click(screen.getByRole("button", { name: "Main A, 1 copy" }));
      expect(screen.getByRole("button", { name: "One fewer copy" })).toBeDisabled();
      const input = screen.getByRole("spinbutton", { name: "Copies in the cube" });
      fireEvent.change(input, { target: { value: "99" } });
      fireEvent.blur(input);
      await waitFor(() => expect(posts).toHaveLength(1));
      await waitFor(() => expect(screen.getByRole("button", { name: "One more copy" })).toBeDisabled());
    });

    it("sets copies by typing a number and ignores a number outside 1 to 99", async () => {
      await open();
      fireEvent.click(screen.getByRole("button", { name: "Main A, 2 copies" }));
      const input = screen.getByRole("spinbutton", { name: "Copies in the cube" });
      fireEvent.change(input, { target: { value: "12" } });
      fireEvent.keyDown(input, { key: "Enter" });
      await waitFor(() => expect(posts).toHaveLength(1));
      expect(posts[0]).toEqual({ op: "setMaxCopies", catalogCardId: 1, maxCopies: 12 });
      await waitFor(() => expect(screen.getByRole("spinbutton", { name: "Copies in the cube" })).toHaveValue(12));

      fireEvent.change(screen.getByRole("spinbutton", { name: "Copies in the cube" }), { target: { value: "100" } });
      fireEvent.blur(screen.getByRole("spinbutton", { name: "Copies in the cube" }));
      expect(posts).toHaveLength(1);
      expect(screen.getByRole("spinbutton", { name: "Copies in the cube" })).toHaveValue(12);
    });

    it("labels copies as copies in the cube, not a deck limit", async () => {
      await open();
      fireEvent.click(screen.getByRole("button", { name: "Main A, 2 copies" }));
      expect(screen.getByText(/not a deck limit/i)).toBeInTheDocument();
    });

    it("removes with the button, then Undo adds it back with the old copies", async () => {
      await open();
      fireEvent.click(screen.getByRole("button", { name: "Main A, 2 copies" }));
      fireEvent.click(screen.getByRole("button", { name: "Remove from cube" }));

      const toast = await screen.findByText("Removed Main A (×2) from Main");
      expect(posts[0]).toEqual({ op: "remove", catalogCardId: 1 });

      fireEvent.click(within(toast.parentElement as HTMLElement).getByRole("button", { name: "Undo" }));
      await waitFor(() => expect(posts).toHaveLength(2));
      expect(posts[1]).toEqual({ op: "add", catalogCardId: 1, pool: "main", maxCopies: 2 });
      await screen.findByRole("button", { name: "Main A, 2 copies" });
    });

    it("keeps Undo available for ten seconds after a repeated removal with the same message", async () => {
      main = [{ catalogCardId: 1, pool: "main", maxCopies: 3 }];
      await open();
      vi.useFakeTimers();

      fireEvent.click(screen.getByRole("button", { name: "Main A, 3 copies" }));
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Remove from cube" }));
      });
      expect(screen.getByText("Removed Main A (×3) from Main")).toBeInTheDocument();

      act(() => { vi.advanceTimersByTime(9000); });
      fireEvent.change(screen.getByLabelText("Card name"), { target: { value: "Main A" } });
      await act(async () => { await vi.advanceTimersByTimeAsync(250); });
      await act(async () => {
        fireEvent.click(screen.getByRole("option", { name: /Main A/ }));
      });
      fireEvent.click(screen.getByRole("button", { name: "Main A, 3 copies" }));
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Remove from cube" }));
      });
      expect(screen.getByText("Removed Main A (×3) from Main")).toBeInTheDocument();

      act(() => { vi.advanceTimersByTime(9999); });
      expect(screen.getByRole("button", { name: "Undo" })).toBeEnabled();
      act(() => { vi.advanceTimersByTime(1); });
      // The toast leaves over 160ms: it is already closed and inert, then gone.
      expect(screen.getByText("Removed Main A (×3) from Main").closest("[data-state]")).toHaveAttribute("data-state", "closed");
      act(() => { vi.advanceTimersByTime(200); });
      expect(screen.queryByRole("button", { name: "Undo" })).not.toBeInTheDocument();
    });

    it("shows the theme draft check against 42 main and 17 extra for a theme cube", async () => {
      draftType = "theme";
      await open();
      expect(screen.getByRole("meter", { name: "2 of 42 main copies" })).toBeInTheDocument();
      expect(screen.getByRole("meter", { name: "0 of 17 Extra copies" })).toBeInTheDocument();
      expect(screen.getByRole("heading", { name: "Theme draft check" })).toBeInTheDocument();
      expect(screen.getByText(/40 main copies short/)).toBeInTheDocument();
    });

    it("shows a compact check with no warning headline for an Any cube, the default", async () => {
      await open();
      expect(screen.getByRole("group", { name: "Cube type" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Any" })).toHaveAttribute("aria-pressed", "true");
      expect(screen.getByRole("heading", { name: "Cube check" })).toBeInTheDocument();
      expect(screen.getByText(/needs 40 more main copies/)).toBeInTheDocument();
      expect(screen.getByText(/needs 88 more copies/)).toBeInTheDocument();
      expect(screen.queryByText(/can.t start/)).not.toBeInTheDocument();
      expect(screen.queryByRole("meter")).not.toBeInTheDocument();
    });

    it("theme drafts closed: offers no Theme cube and no theme text for an Any cube", async () => {
      const { container } = render(<CubeEditor cubeId={5} />);
      await screen.findByRole("heading", { name: "Custom" });
      expect(screen.queryByRole("button", { name: "Theme cube" })).toBeNull();
      expect(screen.getByRole("button", { name: "Any" })).toHaveAttribute("aria-pressed", "true");
      expect(screen.getByRole("button", { name: "Cube draft" })).toBeInTheDocument();
      expect(screen.getByRole("heading", { name: "Cube check" })).toBeInTheDocument();
      expect(container.querySelector("section[aria-label='Cube summary']")).not.toHaveTextContent(/theme/i);
    });

    it("theme drafts closed: an existing theme cube still shows its type and check", async () => {
      draftType = "theme";
      await open(false);
      expect(screen.getByRole("button", { name: "Theme cube" })).toHaveAttribute("aria-pressed", "true");
      expect(screen.getByRole("heading", { name: "Theme draft check" })).toBeInTheDocument();
    });

    it("shows the cube draft check for a Cube draft cube, from the saved pack settings", async () => {
      draftType = "booster";
      settings = { cardsPerPlayer: 45, packSize: 10 };
      await open();
      expect(screen.getByRole("heading", { name: "Cube draft check" })).toBeInTheDocument();
      expect(screen.getByText("45 cards each, 5 packs of 10")).toBeInTheDocument();
      expect(screen.getByRole("meter", { name: "2 of 45 cards one player can reach" })).toBeInTheDocument();
      expect(screen.getByRole("meter", { name: "2 of 100 copies for 2 players" })).toBeInTheDocument();
      expect(screen.getByText(/98 more copies needed/)).toBeInTheDocument();
      expect(screen.queryByText(/theme draft/i)).not.toBeInTheDocument();
    });

    it("saves a new cube type from the editor and swaps the check panel", async () => {
      await open();
      fireEvent.click(screen.getByRole("button", { name: "Theme cube" }));
      await screen.findByRole("heading", { name: "Theme draft check" });
      expect(puts).toEqual([{ draftType: "theme" }]);
      expect(screen.getByRole("button", { name: "Theme cube" })).toHaveAttribute("aria-pressed", "true");
      fireEvent.click(screen.getByRole("button", { name: "Cube draft" }));
      await screen.findByRole("heading", { name: "Cube draft check" });
      expect(puts[1]).toEqual({ draftType: "booster" });
    });
  });
});
