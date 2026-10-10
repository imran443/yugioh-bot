import { seatCountFor, type DuelEngineView, type DuelRoom, type ReplayForkSetup, type DuelSession } from "@yugidraft/shared/duels";
import { revealReplayHands } from "./replay-builder.js";

export function initialForkSeat(view: DuelEngineView): number {
  // Pending loss is still playable until the engine eliminates the seat.
  const promptSeat = view.prioritySeat;
  if (promptSeat != null && view.seats.some(s => s.seat === promptSeat && !s.eliminated)) return promptSeat;
  return view.seats.find(s => !s.eliminated)?.seat ?? 0;
}

export function resolveReplayForkSeat(session: DuelSession, requested: unknown, fallback = 0): number {
  const seat = requested === undefined ? fallback : requested;
  if (!Number.isInteger(seat) || (seat as number) < 0 || (seat as number) >= seatCountFor(session.format)) {
    throw new Error("Invalid replay fork acting seat");
  }
  return seat as number;
}

/** Caller has checked current creator access. Only hands/Extra Decks share projections. */
export function replayForkRoom(room: DuelRoom, setup: ReplayForkSetup, ownViews: Array<DuelEngineView | null>, actingSeat: number,
  reveal = true): DuelRoom {
  const view = ownViews[actingSeat] ?? null;
  const chainModes = Object.fromEntries(ownViews.flatMap((own, seat) => {
    const state = view?.seats.find(s => s.seat === seat);
    return state && !state.eliminated && own?.chainMode ? [[seat, own.chainMode]] : [];
  }));
  return { ...room, mySeat: 0, engine: view && reveal ? revealReplayHands(view, ownViews as DuelEngineView[]) : view,
    fork: { identitySeat: 0, actingSeat, manualSeats: room.session.seats.map(s => s.seat), revealHands: reveal, chainModes,
      origin: { sourceSlug: setup.origin.sourceSlug, sourceFrameId: setup.origin.frameId, sourceStep: setup.origin.step,
        sourceSeats: setup.origin.sourceSeats } } };
}
