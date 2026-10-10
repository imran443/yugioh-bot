// @vitest-environment jsdom
import React from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CubeCheck } from "@/components/cubes/cube-check";
import { boosterReadiness } from "@/components/cubes/readiness";
import type { CubePoolsDto } from "@/lib/cube-pools";

vi.mock("next/font/google", () => {
  const font = () => ({ variable: "font-var", className: "font-class" });
  return { Oxanium: font, Sofia_Sans_Semi_Condensed: font, Sofia_Sans_Extra_Condensed: font, Newsreader: font };
});

/** `names` different cards, each with `copies` copies. */
function pool(names: number, copies: number, start = 1) {
  return Array.from({ length: names }, (_, i) => ({ catalogCardId: start + i, pool: "main" as const, maxCopies: copies }));
}
const pools = (main: number, extra = 0, copies = 3): CubePoolsDto => ({
  main: pool(main, copies),
  extra: pool(extra, copies, 1000).map((e) => ({ ...e, pool: "extra" as const })),
});

describe("boosterReadiness", () => {
  it("uses copies and legal reach for ten names with ten copies", () => {
    const r = boosterReadiness(100, 30);
    expect(r).toMatchObject({ cardsPerPlayer: 40, packSize: 15, waves: 3, maxPlayers: 2, state: "ready" });
    expect(r.reach).toMatchObject({ have: 30, need: 40, short: 10 });
    expect(r.copies2).toMatchObject({ have: 100, need: 90, short: 0 });
  });
  it("blocks thirty singletons", () => {
    expect(boosterReadiness(30, 30)).toMatchObject({ maxPlayers: 0, state: "blocked" });
  });
  it("counts seats by copies divided by all packs", () => {
    expect(boosterReadiness(135, 135).maxPlayers).toBe(3);
    expect(boosterReadiness(89, 89).copies2.short).toBe(1);
  });
  it("uses saved pack settings", () => {
    expect(boosterReadiness(120, 120, { packsPerPlayer: 4 }).waves).toBe(4);
  });
  it("blocks a deck that needs more picks than the packs hold", () => {
    expect(boosterReadiness(100, 100, { cardsPerPlayer: 60, packsPerPlayer: 3, packSize: 15 }).state).toBe("blocked");
  });
});

describe("CubeCheck", () => {
  it.each(["booster", "any"] as const)("%s: shows a pack slot error for an invalid saved setup", (type) => {
    render(<CubeCheck type={type} pools={pools(100, 0, 1)} settings={{ cardsPerPlayer: 60, packsPerPlayer: 3, packSize: 15 }} />);
    expect(screen.getByText(/Packs hold 45 cards per player; 60 are needed/)).toBeInTheDocument();
    expect(screen.queryByText(/Ready for a cube draft|ready for up to/)).not.toBeInTheDocument();
  });

  it("theme: the existing theme draft check with its 'can't start' line", () => {
    render(<CubeCheck type="theme" pools={pools(2, 0, 1)} />);
    expect(screen.getByRole("heading", { name: "Theme draft check" })).toBeInTheDocument();
    expect(screen.getByText(/40 main copies short/)).toBeInTheDocument();
    expect(screen.getByText(/A theme draft can.t start with it/)).toBeInTheDocument();
  });

  it("theme: ready once main and extra are covered", () => {
    render(<CubeCheck type="theme" pools={pools(14, 6)} />);
    expect(screen.getByText("Ready for a theme draft.")).toBeInTheDocument();
  });

  it("booster: the cube draft check, with the pool size against two players", () => {
    render(<CubeCheck type="booster" pools={pools(10)} />);
    expect(screen.getByRole("heading", { name: "Cube draft check" })).toBeInTheDocument();
    expect(screen.getByText("40 cards each, 3 packs of 15")).toBeInTheDocument();
    expect(screen.getByText("60 more copies needed.")).toBeInTheDocument();
    expect(screen.getByText(/Two players need 90 copies./)).toBeInTheDocument();
    expect(screen.queryByText(/theme/i)).not.toBeInTheDocument();
  });

  it("booster: says how many players a big enough cube seats", () => {
    render(<CubeCheck type="booster" pools={pools(45, 20)} />);
    expect(screen.getByText("Ready for a cube draft.")).toBeInTheDocument();
    expect(screen.getByText(/Seats up to 3 players/)).toBeInTheDocument();
  });

  it("booster: only the Main pool counts, Extra cards do not make a cube draft ready", () => {
    render(<CubeCheck type="booster" pools={pools(25, 10)} />);
    expect(screen.queryByText("Ready for a cube draft.")).not.toBeInTheDocument();
    expect(screen.getByText("15 more copies needed.")).toBeInTheDocument();
    expect(screen.getByRole("meter", { name: "75 of 90 copies for 2 players" })).toBeInTheDocument();
  });

  it("any: Extra cards do not count towards the cube draft line either", () => {
    render(<CubeCheck type="any" pools={pools(25, 10)} />);
    expect(screen.getByText(/needs 15 more copies/)).toBeInTheDocument();
  });

  it("booster: reach is a warning with enough copies", () => {
    render(<CubeCheck type="booster" pools={pools(10, 0, 10)} />);
    expect(screen.getByText("One player can reach 30 of 40 cards.")).toBeInTheDocument();
    expect(screen.getByText(/A draft can start/)).toBeInTheDocument();
  });
  it("config pools are checked at draft start", () => {
    render(<CubeCheck type="booster" pools={pools(0)} settings={{ poolFromConfig: true }} />);
    expect(screen.getByText(/checked at draft start/i)).toBeInTheDocument();
    expect(screen.queryByText(/copies needed/)).not.toBeInTheDocument();
  });

  it("any: both checks as short lines and no theme warning", () => {
    render(<CubeCheck type="any" pools={pools(2, 0, 1)} themeDraftsEnabled />);
    expect(screen.getByRole("heading", { name: "Cube check" })).toBeInTheDocument();
    expect(screen.getByText(/needs 40 more main copies/)).toBeInTheDocument();
    expect(screen.getByText(/needs 88 more copies/)).toBeInTheDocument();
    expect(screen.queryByText(/can.t start/)).not.toBeInTheDocument();
    expect(screen.queryByText(/short\./)).not.toBeInTheDocument();
  });

  it("any: ready lines for a cube that suits both", () => {
    render(<CubeCheck type="any" pools={pools(30, 10)} themeDraftsEnabled />);
    expect(screen.getByText("Theme draft:").parentElement).toHaveTextContent("Theme draft: ready.");
    expect(screen.getByText("Cube draft:").parentElement).toHaveTextContent("Cube draft: ready for up to 2 players.");
  });

  it("any, theme drafts closed: names no theme draft and keeps the cube draft line", () => {
    const { container } = render(<CubeCheck type="any" pools={pools(30, 10)} />);
    expect(container).not.toHaveTextContent(/theme/i);
    expect(screen.getByText("Cube draft:").parentElement).toHaveTextContent("Cube draft: ready for up to 2 players.");
  });

  it("theme cube, theme drafts closed: an existing theme cube keeps its own check", () => {
    render(<CubeCheck type="theme" pools={pools(14, 6)} />);
    expect(screen.getByRole("heading", { name: "Theme draft check" })).toBeInTheDocument();
  });
});
