import { readFileSync } from "node:fs";
import type { DuelEngineView, DuelFormat } from "@yugidraft/shared/duels";
import { describe, expect, it, vi } from "vitest";
import { playDuel } from "./fuzz-n/driver.js";
import { CHECKS, NChecker } from "./fuzz-n/invariants.js";
import { currentDomainMultiWasm, describeWithCores, needs } from "./support/cores.js";
import { liveNseat } from "./support/live-nseat.js";
import { engineDataDirectory } from "./engine-data-dir.js";

// Catalog growth changes generated decks even with the same seed. Pin this
// coverage fixture, while keeping the real engine, random answers and checker.
// Inaba White Rabbit returns to hand in the End Phase after its Normal Summon,
// giving recall opportunities without relying on opponents destroying a master.
vi.mock("./fuzz-n/decks.js", () => ({
  buildSeatDecks: (_catalog: unknown, _rng: unknown, _mode: unknown, seats: number) => {
    const cards = [
      // Low-level Normal Monsters: no summon prerequisites or effect loops.
      5053103, 15025844, 21844576, 32452818, 38289717, 40374923,
      53829412, 66602787, 67724379, 69247929, 84327329, 91152256,
      // Removal and draw keep real battles and chains in the fuzz run.
      12580477, 53129443, 55144522, 44095762, 94192409, 5318639, 19613556, 83764718,
    ];
    return {
      decks: Array.from({ length: seats }, () => ({
        main: cards.flatMap((code) => [code, code, code]), extra: [], side: [], deckMaster: 77084837,
      })),
      notes: Array.from({ length: seats }, () => "Fixed Spirit Deck Master recall fixture"),
      disjoint: false,
    };
  },
}));

function responseOrderViolations(format: DuelFormat, turnSeat: number, responses: number[]) {
  const n = format === "ffa3" ? 3 : 4;
  const spectator: DuelEngineView = {
    revision: 1, format, turn: 4, turnSeat, phase: "main1", prompt: null, events: [], log: [], result: null,
    seats: Array.from({ length: n }, (_, seat) => ({
      seat, lp: 8000, hand: [], deckCount: 30, extraCount: 0, extra: [], monsters: [], spells: [], graveyard: [], banished: [],
    })),
    chain: [{ index: 1, seat: turnSeat }, { index: 2, seat: 1 }],
  };
  return new NChecker(format).check(0, {
    seats: Array.from({ length: n }, () => spectator), spectator,
  }, responses.map((seat) => ({ turn: 4, phase: "main1", kind: "response", seat, detail: "1 choice(s), chain 2" })))
    .filter((entry) => entry.invariant === CHECKS.responseOrder);
}

describe("Domain fuzz response-order invariant", () => {
  it.each([
    ["ffa3", 0, [2, 0, 1]],
    ["ffa4", 3, [2, 3, 0, 1]],
  ] as const)("%s: follows the non-turn activating seat clockwise", (format, turnSeat, responses) => {
    expect(responseOrderViolations(format, turnSeat, [...responses])).toEqual([]);
  });

  it("ffa4: rejects restarting at the turn seat after another seat adds a link", () => {
    expect(responseOrderViolations("ffa4", 3, [3, 0, 1, 2])).not.toHaveLength(0);
  });
});

describeWithCores("Domain fuzz proves real Deck Master play", [liveNseat, ...needs.domainMulti()], () => {
  for (const format of ["ffa3", "ffa4", "tag"] as const) {
    it(`${format}: counts real leaves and completed returns`, async () => {
      const bytes = readFileSync(currentDomainMultiWasm());
      const result = await playDuel({ format, seed: 1, mode: "domain", masterRule: 5, maxSteps: 1000, eliminateRate: 0.5 }, {
        dataDirectory: engineDataDirectory,
        multiWasmBinary: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      });
      expect(result.failure).toBeNull();
      expect(result.decks.every((deck) => !!deck.deckMaster)).toBe(true);
      expect(result.stats["domain-masters"]).toBe(result.decks.length);
      expect(Object.entries(result.stats).filter(([key]) => key.startsWith("domain-leaves-seat-")).reduce((sum, [, n]) => sum + n, 0)).toBeGreaterThan(0);
      expect(Object.entries(result.stats).filter(([key]) => key.startsWith("domain-returns-seat-")).reduce((sum, [, n]) => sum + n, 0)).toBeGreaterThan(0);
    }, 30_000);
  }
});
