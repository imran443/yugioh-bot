import { defaultDuelSettings, seatCountFor, type DuelAnswer, type DuelChainMode, type DuelEngineView,
  type DuelFormat, type ReplaySource } from "@yugidraft/shared/duels";
import type { DuelGameWorker, GameOptions } from "../../src/worker-client.js";

export function replaySource(format: DuelFormat = "1v1"): ReplaySource {
  const seats = Array.from({ length: seatCountFor(format) }, (_, seat) => ({ seat, playerId: seat + 1,
    displayName: `Seat ${seat}`, ready: true, isBot: false }));
  return { session: { id: 1, slug: "replay-source", kind: "play", guildId: "test-guild", name: "Source",
    organizerPlayerId: 1, format, mode: "normal", masterRule: 5, status: "interrupted",
    settings: defaultDuelSettings("normal"), seats, createdAt: "2026-10-10T00:00:00Z", endedAt: null,
    archivedAt: null, winnerPlayerId: null, winnerSeat: null, resultReason: "Interrupted" },
    decks: seats.map(() => ({ main: [100], extra: [200], side: [] })), seed: ["1", "2", "3", "4"],
    bundleVersion: "test-bundle", engineIdentity: null, setup: { firstTurnDraw: false, scriptErrorMode: "tolerant" },
    commands: [
      { storedSeq: 2, seat: 0, command: { revision: 1, promptId: "p1", answer: { choice: "next" } } },
      { storedSeq: 7, seat: 1, command: { revision: 2, promptId: "chain-mode:off", answer: {} } },
      { storedSeq: 11, seat: 0, command: { revision: 2, promptId: "p2", answer: { choice: "next" } } },
    ] };
}

export class ReplayWorker implements DuelGameWorker {
  running = true;
  revision = 1;
  created?: GameOptions;
  result: DuelEngineView["result"] = null;
  closed = 0;
  modes: Record<number, DuelChainMode> = {};
  async create(options: GameOptions) { this.created = options; }
  async view(viewer: number | null): Promise<DuelEngineView> {
    return { revision: this.revision, turn: 1, turnSeat: 0, phase: "main1",
      seats: this.created!.decks.map((_, seat) => {
        const card = { controller: seat, location: 1, sequence: 0, position: 2,
          ...(viewer === seat ? { code: 900 + seat } : {}) };
        return { seat, lp: 8000, hand: [card], extra: [{ ...card, location: 64 }], deckCount: 35, extraCount: 1,
          monsters: [{ ...card, location: 4 }], spells: [], graveyard: [], banished: [] };
      }),
      prompt: viewer === 0 && !this.result ? { id: `p${this.revision}`, seat: 0, kind: "choice", title: "Next",
        options: [{ id: "next", label: "Next" }] } : null,
      prioritySeat: this.result ? null : 0, ...(viewer === null ? {} : { chainMode: this.modes[viewer] ?? "always" }),
      chain: [], result: this.result,
      log: Array.from({ length: this.revision }, (_, index) => ({ id: index + 1, kind: "message" as const,
        text: viewer === null ? `Public ${index}` : `Private ${viewer} ${index}` })), events: [] };
  }
  async answer(_seat: number, _promptId: string, _answer: DuelAnswer) { this.revision++; }
  async setChainMode(seat: number, mode: DuelChainMode) { this.modes[seat] = mode; return false; }
  async search() { return []; }
  async close() { this.closed++; this.running = false; }
}
