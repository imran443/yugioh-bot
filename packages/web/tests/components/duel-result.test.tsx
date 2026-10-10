// @vitest-environment jsdom
import React from "react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DuelRoom } from "@yugidraft/shared/duels";

vi.mock("next/font/google", () => {
  const font = () => ({ variable: "font-var", className: "font-class" });
  return { Oxanium: font, Sofia_Sans_Semi_Condensed: font, Sofia_Sans_Extra_Condensed: font, Newsreader: font };
});

import {
  classifyResultReason,
  describeDuelResult,
  DuelResultScreen,
  fractureGeometry,
  titleFontSize,
  titleKindOf,
} from "@/components/duel/duel-result";

function seatView(seat: number, lp: number, deckMaster?: { code: number; name: string }) {
  return {
    seat,
    lp,
    hand: [],
    deckCount: 30,
    extraCount: 0,
    extra: [],
    monsters: [],
    spells: [],
    graveyard: [],
    banished: [],
    ...(deckMaster
      ? {
          deckMaster: {
            card: { code: deckMaster.code, name: deckMaster.name, description: "", type: 0, attack: 0, defense: 0, level: 0, attribute: 0, race: "" },
            inZone: false,
            returns: 0,
            nextCost: 0,
          },
        }
      : {}),
  };
}

type RoomOptions = {
  status?: DuelRoom["session"]["status"];
  mySeat: number | null;
  winner: number | null;
  reason: string | null;
  lp?: [number, number];
  engine?: boolean;
  engineResult?: boolean;
  domain?: boolean;
};

function makeRoom(options: RoomOptions): DuelRoom {
  const lp = options.lp ?? [3450, 0];
  const engineResult = options.engineResult ?? true;
  return {
    session: {
      id: 1,
      slug: "abc",
      kind: "play",
      name: "Table",
      guildId: "g",
      organizerPlayerId: 1,
      mode: options.domain ? "domain" : "normal",
      format: "1v1",
      masterRule: 5,
      status: options.status ?? "completed",
      settings: {} as DuelRoom["session"]["settings"],
      seats: [
        { seat: 0, playerId: 1, displayName: "Sulman", ready: true, isBot: false },
        { seat: 1, playerId: 2, displayName: "Practice Bot", ready: true, isBot: true },
      ],
      createdAt: "",
      endedAt: null,
      archivedAt: null,
      winnerPlayerId: null,
      winnerSeat: options.winner,
      resultReason: options.reason,
    },
    role: options.mySeat == null ? "spectator" : "player",
    mySeat: options.mySeat,
    myDeck: null,
    clock: null,
    metadataOnly: false,
    engine: options.engine === false
      ? null
      : {
          revision: 1,
          turn: 5,
          turnSeat: 0,
          phase: "end",
          seats: [
            seatView(0, lp[0], options.domain ? { code: 46986414, name: "Dark Magician" } : undefined),
            seatView(1, lp[1]),
          ],
          prompt: null,
          chain: [],
          events: [],
          log: [],
          result: engineResult ? { winnerSeat: options.winner, reason: options.reason ?? "" } : null,
        },
  };
}

describe("classifyResultReason", () => {
  it("maps the engine and host reason strings", () => {
    expect(classifyResultReason("LP reached 0")).toBe("life-points");
    expect(classifyResultReason("Cards can't be drawn")).toBe("deck-out");
    expect(classifyResultReason("Surrendered")).toBe("surrender");
    expect(classifyResultReason("Surrender")).toBe("surrender");
    expect(classifyResultReason("Time limit up")).toBe("time");
    expect(classifyResultReason("Time limit")).toBe("time");
    expect(classifyResultReason("Lost connection")).toBe("connection");
    expect(classifyResultReason('Victory by the effect of "Exodia the Forbidden One"')).toBe("other");
    expect(classifyResultReason("Win reason 99")).toBe("other");
    expect(classifyResultReason(null)).toBe("other");
  });
});

describe("describeDuelResult", () => {
  it("shows YOU WIN to the winner and YOU LOSE to the other seat", () => {
    const win = describeDuelResult(makeRoom({ mySeat: 0, winner: 0, reason: "LP reached 0" }));
    expect(win.outcome).toBe("win");
    expect(win.headline).toBe("YOU WIN");
    expect(win.reason).toBe("Practice Bot's Life Points hit 0");

    const lose = describeDuelResult(makeRoom({ mySeat: 0, winner: 1, reason: "LP reached 0", lp: [0, 800] }));
    expect(lose.outcome).toBe("lose");
    expect(lose.headline).toBe("YOU LOSE");
    expect(lose.reason).toBe("Your Life Points hit 0");
  });

  it("names the winner for a spectator", () => {
    const model = describeDuelResult(makeRoom({ mySeat: null, winner: 1, reason: "Surrender" }));
    expect(model.outcome).toBe("spectator");
    expect(model.headline).toBe("Practice Bot wins");
    expect(model.reason).toBe("Sulman surrendered");
  });

  it("maps every loss reason to plain words", () => {
    const line = (reason: string, mySeat: number | null = 0, winner = 1) =>
      describeDuelResult(makeRoom({ mySeat, winner, reason })).reason;
    expect(line("Cards can't be drawn")).toBe("You could not draw a card");
    expect(line("Cards can't be drawn", null)).toBe("Sulman could not draw a card");
    expect(line("Surrendered")).toBe("You surrendered");
    expect(line("Time limit")).toBe("Time ran out");
    expect(line("Time limit up")).toBe("Time ran out");
    expect(line("Lost connection", 1, 1)).toBe("Sulman lost connection");
    expect(line('Victory by the effect of "Exodia the Forbidden One"')).toBe('Victory by the effect of "Exodia the Forbidden One"');
  });

  it("reports a draw, an interrupted duel and a cancelled table", () => {
    const draw = describeDuelResult(makeRoom({ mySeat: 0, winner: null, reason: "LP reached 0", lp: [0, 0] }));
    expect(draw.outcome).toBe("draw");
    expect(draw.headline).toBe("DRAW");
    expect(draw.reason).toBe("Both players' Life Points hit 0");

    const interrupted = describeDuelResult(
      makeRoom({ status: "interrupted", mySeat: 0, winner: null, reason: "The saved engine state could not be recovered." }),
    );
    expect(interrupted.outcome).toBe("interrupted");
    expect(interrupted.headline).toBe("DUEL INTERRUPTED");
    expect(interrupted.reason).toBe("The saved engine state could not be recovered.");
    expect(interrupted.scores.every((score) => !score.isWinner)).toBe(true);

    const cancelled = describeDuelResult(makeRoom({ status: "cancelled", mySeat: 0, winner: null, reason: null, engine: false }));
    expect(cancelled.outcome).toBe("cancelled");
    expect(cancelled.headline).toBe("TABLE CANCELLED");
    expect(cancelled.scores).toEqual([]);
    // The host saves the bare word "Cancelled"; the subtitle must not repeat the headline.
    expect(cancelled.reason).toBe("The table closed before the duel finished");
    const saved = describeDuelResult(makeRoom({ status: "cancelled", mySeat: 0, winner: null, reason: "Cancelled", engine: false }));
    expect(saved.reason).toBe("The table closed before the duel finished");
    const custom = describeDuelResult(makeRoom({ status: "cancelled", mySeat: 0, winner: null, reason: "The organizer closed the table", engine: false }));
    expect(custom.reason).toBe("The organizer closed the table");
  });

  it("prefers the live engine result over the saved session row", () => {
    const room = makeRoom({ status: "active", mySeat: 1, winner: 1, reason: "LP reached 0" });
    room.session.winnerSeat = null;
    room.session.resultReason = null;
    expect(describeDuelResult(room).outcome).toBe("win");
  });

  it("returns final LP for both seats and marks the winner", () => {
    const model = describeDuelResult(makeRoom({ mySeat: 0, winner: 0, reason: "LP reached 0", lp: [3450, 0], domain: true }));
    expect(model.scores.map((score) => [score.name, score.lp, score.isWinner, score.isMe])).toEqual([
      ["Sulman", 3450, true, true],
      ["Practice Bot", 0, false, false],
    ]);
    expect(model.scores[0].deckMaster).toEqual({ code: 46986414, name: "Dark Magician" });
  });
});

describe("DuelResultScreen", () => {
  let restoreFocus: HTMLButtonElement;

  beforeEach(() => {
    restoreFocus = document.createElement("button");
    document.body.append(restoreFocus);
    restoreFocus.focus();
  });

  afterEach(() => {
    cleanup();
    restoreFocus.remove();
    vi.useRealTimers();
  });

  function setup(options: Partial<RoomOptions> = {}, props: { reducedMotion?: boolean } = {}) {
    const onClose = vi.fn();
    const room = makeRoom({ mySeat: 0, winner: 0, reason: "LP reached 0", ...options });
    const view = render(
      <DuelResultScreen room={room} slug="abc" reducedMotion={props.reducedMotion ?? false} soundEnabled={false} onClose={onClose} />,
    );
    return { onClose, room, ...view };
  }

  it("shows an Exit duel button that calls onExit instead of the tables link", () => {
    const onExit = vi.fn();
    const room = makeRoom({ mySeat: 0, winner: 1, reason: "LP reached 0", lp: [0, 100] });
    render(
      <DuelResultScreen room={room} slug="abc" reducedMotion soundEnabled={false} onClose={vi.fn()} onExit={onExit} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Exit duel" }));
    expect(onExit).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("link", { name: "Back to tables" })).toBeNull();
  });

  it("is a labelled modal dialog that takes focus", () => {
    setup();
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    const heading = screen.getByRole("heading", { level: 1 });
    expect(dialog.getAttribute("aria-labelledby")).toBe(heading.id);
    expect(heading).toHaveTextContent("YOU WIN");
    expect(dialog).toHaveFocus();
    expect(dialog).toHaveAccessibleDescription("Practice Bot's Life Points hit 0");
  });

  it("gives the focus back when it closes", () => {
    const { unmount } = setup();
    expect(restoreFocus).not.toHaveFocus();
    unmount();
    expect(restoreFocus).toHaveFocus();
  });

  it("shows both Life Point totals", () => {
    setup({ lp: [3450, 0] });
    const board = screen.getByRole("list", { name: "Final Life Points" });
    expect(board).toHaveTextContent("Sulman");
    expect(board).toHaveTextContent("3,450");
    expect(board).toHaveTextContent("Practice Bot");
    expect(board.querySelectorAll("li")).toHaveLength(2);
  });

  it("offers the replay only for completed or interrupted duels", () => {
    const first = setup({ status: "completed" });
    expect(screen.getByRole("link", { name: "Watch replay" })).toHaveAttribute("href", "/duels/abc/replay");
    expect(screen.getByRole("link", { name: "Back to tables" })).toHaveAttribute("href", "/duels");
    first.unmount();

    setup({ status: "cancelled", winner: null, reason: null, engine: false });
    expect(screen.queryByRole("link", { name: "Watch replay" })).toBeNull();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("TABLE CANCELLED");
  });

  it("lays the actions out as one row of equally styled buttons, the lead one filled", () => {
    setup({ status: "cancelled", winner: null, reason: "Cancelled", engine: false });
    const exit = screen.getByRole("link", { name: "Back to tables" });
    const board = screen.getByRole("button", { name: "View board" });
    expect(exit.parentElement).toHaveAttribute("data-count", "2");
    expect(exit).toHaveAttribute("data-kind", "primary");
    expect(board).toHaveAttribute("data-kind", "secondary");
    expect(screen.getByText("The table closed before the duel finished")).toBeInTheDocument();
    expect(screen.queryByText("Cancelled")).toBeNull();
  });

  it("counts three actions for a completed duel, with the replay link between the two buttons", () => {
    setup({ status: "completed" });
    const exit = screen.getByRole("link", { name: "Back to tables" });
    expect(exit.parentElement).toHaveAttribute("data-count", "3");
    expect(Array.from(exit.parentElement!.children).map((node) => node.textContent)).toEqual(["Back to tables", "Watch replay", "View board"]);
  });

  it("keeps a saved reason other than the bare word as the cancelled subtitle", () => {
    setup({ status: "cancelled", winner: null, reason: "Series cancelled", engine: false });
    expect(screen.getByText("Series cancelled")).toBeInTheDocument();
    expect(screen.queryByText("The table closed before the duel finished")).toBeNull();
  });

  it("calls onClose from View board", () => {
    const { onClose } = setup();
    fireEvent.click(screen.getByRole("button", { name: "View board" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("skips the intro on the first Esc and closes on the next", () => {
    const { onClose } = setup();
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("data-phase", "play");
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(dialog).toHaveAttribute("data-phase", "settled");
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("skips the intro on click and on Space", () => {
    const first = setup();
    fireEvent.click(screen.getByRole("dialog"));
    expect(screen.getByRole("dialog")).toHaveAttribute("data-phase", "settled");
    first.unmount();

    const { onClose } = setup();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: " " });
    expect(screen.getByRole("dialog")).toHaveAttribute("data-phase", "settled");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("settles by itself after the intro", () => {
    vi.useFakeTimers();
    setup();
    expect(screen.getByRole("dialog")).toHaveAttribute("data-phase", "play");
    act(() => {
      vi.advanceTimersByTime(1800);
    });
    expect(screen.getByRole("dialog")).toHaveAttribute("data-phase", "settled");
  });

  it("starts on the settled frame when motion is reduced", () => {
    setup({}, { reducedMotion: true });
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("data-phase", "settled");
    expect(dialog).toHaveAttribute("data-reduced", "true");
  });

  it("keeps Tab inside the dialog", () => {
    setup({ status: "completed" });
    const dialog = screen.getByRole("dialog");
    const back = screen.getByRole("link", { name: "Back to tables" });
    const board = screen.getByRole("button", { name: "View board" });

    board.focus();
    fireEvent.keyDown(board, { key: "Tab" });
    expect(back).toHaveFocus();

    fireEvent.keyDown(back, { key: "Tab", shiftKey: true });
    expect(board).toHaveFocus();

    dialog.focus();
    fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true });
    expect(board).toHaveFocus();
  });

  it("pulls focus back when it escapes the dialog", () => {
    setup();
    const dialog = screen.getByRole("dialog");
    act(() => {
      restoreFocus.focus();
    });
    expect(dialog).toHaveFocus();
  });

  it("renders the perspective headline for each seat", () => {
    const lose = setup({ mySeat: 0, winner: 1, lp: [0, 900] });
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("YOU LOSE");
    expect(screen.getByRole("dialog")).toHaveAttribute("data-outcome", "lose");
    lose.unmount();

    setup({ mySeat: null, winner: 1 });
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Practice Bot wins");
    expect(screen.getByRole("dialog")).toHaveAttribute("data-outcome", "spectator");
  });

  it("breaks the title on a loss, keeps it whole and gold on a win and ivory on a draw or a spectator view", () => {
    const variant = () => {
      const word = document.querySelector<HTMLElement>("[data-kind]")!;
      return { kind: word.dataset.kind, pieces: [...word.querySelectorAll<HTMLElement>("[data-p]")].map((piece) => piece.dataset.p) };
    };
    const lose = setup({ mySeat: 0, winner: 1, lp: [0, 900] });
    expect(screen.getByRole("dialog")).toHaveAttribute("data-title", "lose");
    expect(variant()).toEqual({ kind: "lose", pieces: ["t", "b"] });
    expect(document.querySelectorAll("[data-kind=lose] i")).toHaveLength(5);
    lose.unmount();

    const win = setup({ mySeat: 0, winner: 0 });
    expect(screen.getByRole("dialog")).toHaveAttribute("data-title", "win");
    expect(variant()).toEqual({ kind: "win", pieces: ["whole"] });
    win.unmount();

    const draw = setup({ mySeat: 0, winner: null, reason: null });
    expect(screen.getByRole("dialog")).toHaveAttribute("data-title", "calm");
    expect(variant()).toEqual({ kind: "calm", pieces: ["whole"] });
    draw.unmount();

    setup({ mySeat: null, winner: 1 });
    expect(variant()).toEqual({ kind: "calm", pieces: ["whole"] });
  });

  it("reads the title once: every painted copy is hidden from assistive tech", () => {
    setup({ mySeat: 0, winner: 1, lp: [0, 900] });
    const heading = screen.getByRole("heading", { level: 1 });
    expect(heading).toHaveAccessibleName("YOU LOSE");
    const painted = heading.querySelector("[data-kind]")!;
    expect(painted).toHaveAttribute("aria-hidden", "true");
    expect([...heading.children].filter((child) => !child.hasAttribute("aria-hidden")).map((child) => child.textContent)).toEqual(["YOU LOSE"]);
  });

  it("lays two duelists out side by side and anything else as one row each", () => {
    setup();
    expect(screen.getByRole("list", { name: "Final Life Points" })).toHaveAttribute("data-layout", "duo");
  });

  it("hides the LP unit from readers and spells out Life Points once", () => {
    setup({ lp: [3450, 0] });
    const first = screen.getByRole("list", { name: "Final Life Points" }).querySelector("li")!;
    expect(first.querySelector("i[aria-hidden]")).toHaveTextContent("LP");
    expect(first).toHaveTextContent("3,450LP Life Points");
  });
});

describe("result title logic", () => {
  it("maps outcomes to the three title looks", () => {
    expect(titleKindOf("lose")).toBe("lose");
    expect(titleKindOf("win")).toBe("win");
    for (const outcome of ["draw", "spectator", "interrupted", "cancelled", "ended"] as const) {
      expect(titleKindOf(outcome)).toBe("calm");
    }
  });

  it("puts the break in the middle of the last row, for one and for two rows", () => {
    const one = fractureGeometry(1);
    const two = fractureGeometry(2);
    expect(parseFloat(one.steel[1])).toBeLessThan(parseFloat(one.steel[2]));
    expect(parseFloat(one.glow[2])).toBeCloseTo(50, 5);
    expect(parseFloat(two.glow[2])).toBeCloseTo(75, 5);
    expect(two.steel.map(parseFloat)).toEqual([...two.steel.map(parseFloat)].sort((a, b) => a - b));
    expect(one.chipY).toHaveLength(5);
    // The upper half ends where the lower one starts.
    expect(one.top.startsWith("polygon(")).toBe(true);
    expect(one.bottom).toContain("-40.00%");
    expect(fractureGeometry(2)).toEqual(two);
  });

  it("sizes the title to its column but caps it by screen height and an upper limit", () => {
    // Fits the column: 600 available, 300 wide at 100px, so ~199px; the height cap (27% of 900 = 243) and max 210 do not bite.
    expect(titleFontSize({ available: 600, widthAt100: 300, viewportHeight: 900, rows: 1, max: 210 })).toBeCloseTo(199, 0);
    // Height cap.
    expect(titleFontSize({ available: 1200, widthAt100: 300, viewportHeight: 400, rows: 1, max: 210 })).toBeCloseTo(108, 5);
    // Upper limit.
    expect(titleFontSize({ available: 2000, widthAt100: 300, viewportHeight: 2000, rows: 1, max: 170 })).toBe(170);
    // Stacked rows share a smaller slice of the height.
    expect(titleFontSize({ available: 300, widthAt100: 150, viewportHeight: 800, rows: 2, max: 210 })).toBeCloseTo(120, 5);
    // Floor.
    expect(titleFontSize({ available: 40, widthAt100: 800, viewportHeight: 900, rows: 1, max: 210 })).toBe(28);
    // No layout (jsdom): leave the stylesheet's size.
    expect(titleFontSize({ available: 0, widthAt100: 0, viewportHeight: 900, rows: 1, max: 210 })).toBe(0);
  });
});

describe("short phone layout", () => {
  it("tightens the ground padding and gaps on a short phone so the match-won column fits 360 x 740", () => {
    const css = readFileSync(join(__dirname, "../../src/components/duel/duel-result.module.css"), "utf8");
    const block = css.match(/@media \(max-width: 600px\) and \(max-height: 780px\) \{([\s\S]*?)\n\}/);
    expect(block, "the short-phone media query").not.toBeNull();
    expect(block![1]).toMatch(/--gap:\s*10px/);
    expect(block![1]).toMatch(/\.scroll\s*\{[^}]*padding-block/);
  });
});

describe("result layout styles", () => {
  const css = readFileSync(join(__dirname, "../../src/components/duel/duel-result.module.css"), "utf8");

  it("fades the glow behind the title to nothing, so no straight box edge shows", () => {
    const light = css.match(/\.light\s*\{([^}]*)\}/);
    expect(light, "the .light rule").not.toBeNull();
    expect(light![1]).toMatch(/mask-image:\s*radial-gradient\(closest-side/);
  });

  it("centres equal-width actions instead of stretching the lead button", () => {
    const actions = css.match(/\n\.actions\s*\{([^}]*)\}/);
    expect(actions, "the .actions rule").not.toBeNull();
    expect(actions![1]).toMatch(/justify-content:\s*center/);
    expect(actions![1]).toMatch(/grid-auto-columns:\s*minmax\(0,\s*200px\)/);
    expect(css).not.toMatch(/1\.7fr/);
  });

  it("keeps the title out of the global reduced-motion transition, so the fit reads the size it just set", () => {
    // globals.css gives every element a 0.01ms transition under prefers-reduced-motion. A transition makes the
    // computed font size lag one read behind, so the fit measured the old size and the title overflowed.
    const rule = css.match(/\n\.title,\s*\.title \*\s*\{([^}]*)\}/);
    expect(rule, "the .title, .title * rule").not.toBeNull();
    expect(rule![1]).toMatch(/transition-property:\s*none/);
  });
});

describe("title fit", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("sets --fs from the measured width", () => {
    // jsdom has no layout: the column is 300px wide and the text is 600px wide at 100px, so it fits at about 50px.
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(300);
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(600);
    const room = makeRoom({ status: "cancelled", mySeat: 0, winner: null, reason: null, engine: false });
    render(<DuelResultScreen room={room} slug="abc" reducedMotion={false} soundEnabled={false} onClose={vi.fn()} />);
    const title = screen.getByRole("heading", { level: 1 });
    expect(Number.parseFloat(title.style.getPropertyValue("--fs"))).toBeCloseTo(49.75, 1);
  });
});
