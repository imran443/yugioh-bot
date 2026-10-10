import { useMemo, useRef, type MutableRefObject } from "react";
import type { DuelEngineView, DuelRoom, DuelSession } from "@yugidraft/shared/duels";
import type { HudPane } from "./grid-hud";
import type { CameraState, TableController } from "./types";
import type { SidePane } from "../side-panel";

/**
 * Replay mode of the shared table shells (see `ReplayShellMode` in types.ts). The shells call these; the replay page
 * only passes `replay`. Nothing here talks to the server.
 */

const NOOP = () => undefined;
const NO_KEYS = new Set<string>();

/**
 * The status a replayed frame has. The saved duel is over, but a frame in the middle of it is not: only the frame that
 * holds the result reads as ended. An interrupted or cancelled duel keeps its own status on that frame.
 */
export function replayFrameStatus(status: DuelSession["status"], engine: Pick<DuelEngineView, "result">): DuelSession["status"] {
  if (engine.result == null) return "active";
  return status === "active" || status === "lobby" ? "completed" : status;
}

/**
 * Makes any controller unable to act, whatever the caller passes in: no prompt, no keys, no pick, no aim, an answer
 * that does nothing, no clock, no series and a status that follows the frame. Inspection, hover and the camera seat stay.
 */
export function readOnlyReplayController(controller: TableController): TableController {
  const { room, engine } = controller;
  const session: DuelSession = { ...room.session, status: replayFrameStatus(room.session.status, engine) };
  const readOnlyRoom: DuelRoom = { ...room, session, clock: null, series: null, mySide: null, opening: null, fork: undefined, inviteCode: undefined, error: undefined, stale: false };
  const readOnlyEngine: DuelEngineView = { ...engine, prompt: null, prioritySeat: null, chainMode: undefined };
  return {
    ...controller,
    room: readOnlyRoom,
    engine: readOnlyEngine,
    prompt: null,
    promptSeat: null,
    canAct: false,
    busy: false,
    offline: false,
    revealed: false,
    legalKeys: NO_KEYS,
    selectedKeys: NO_KEYS,
    seatPick: null,
    aim: null,
    attackAim: null,
    onAnswer: NOOP,
    onAim: undefined,
  };
}

/** Same object while the inputs the table reads stay the same, so the shell's memos hold between frames of one view. */
export function useReadOnlyReplayController(controller: TableController): TableController {
  const { room, engine, viewerSeat, nameOf, reducedMotion, draft, onActivate, onInspect, onHoverCard } = controller;
  return useMemo(
    () => readOnlyReplayController(controller),
    // The fields above are all the table reads from a replay controller.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [room, engine, viewerSeat, nameOf, reducedMotion, draft, onActivate, onInspect, onHoverCard],
  );
}

/**
 * What a seek keeps: the camera the viewer chose and the panel they had open. The table remounts on a new reset key;
 * this ref is what the next mount starts from. It never carries a lock, so no effect of an old frame holds the camera.
 */
export interface ReplayCarry {
  camera?: CameraState;
  hudPane?: HudPane | null;
  sidePane?: SidePane;
}

export type ReplayCarryRef = MutableRefObject<ReplayCarry>;

export function useReplayCarry(): ReplayCarryRef {
  return useRef<ReplayCarry>({});
}

/** The camera to remember: the viewer's choice without the lock timer. */
export function carriedCamera(state: CameraState): CameraState {
  return { ...state, lock: null };
}
