"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  opponentSeatsOf,
  seatCountFor,
  seatsOfTeam,
  toOrdinaryReplayView,
  type DuelActorRole,
  type DuelEngineView,
  type DuelReplay,
  type DuelReplayV2,
  type DuelRoom,
  type DuelSession,
  type ReplayFrameV2,
  type ReplayOwnerCapabilities,
  type ReplayVisibility,
} from "@yugidraft/shared/duels";
import { DuelRequestError, getDuelReplayFrames } from "./api";
import { useCoinPlaying } from "./coin-toss-lock";
import { seatTeamLabel } from "./table-format";
import type { PromptDraft, TableController } from "./table/types";
import type { InspectTarget } from "./inspector";
import type { DuelActivateHandler, DuelHoverHandler } from "./field-keys";

export const BASE_STEP_MS = 1400;
export const SPEEDS = [0.5, 1, 2, 4] as const;
/** The query parameter that keeps the selected frame across a reload. */
export const FRAME_PARAM = "frame";

/* ------------------------------------------------------------------------------------------------
 * Replay model: one shape for the v2 contract and for the v1 answer of a server that predates it.
 * ---------------------------------------------------------------------------------------------- */

export interface ReplayModel {
  /** The contract the server answered with. A v1 answer has no frame IDs or cursors; they are made here. */
  version: 1 | 2;
  slug: string;
  /** What this client asked for. A v1 server ignores it and answers with the viewer's own cards. */
  requested: ReplayVisibility;
  /** The card visibility the frames really have. */
  visibility: ReplayVisibility;
  sourceVersion: string | null;
  session: DuelSession;
  role: DuelActorRole;
  /** The viewer's real seat. The camera never changes it. */
  mySeat: number | null;
  /** The seat the server projected the cards for. */
  dataSeat: number | null;
  frames: ReplayFrameV2[];
  capabilities?: ReplayOwnerCapabilities;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isReplayV2(raw: unknown): raw is DuelReplayV2 {
  return isRecord(raw) && raw.version === 2 && Array.isArray(raw.frames)
    && raw.frames.every((frame) => isRecord(frame) && typeof frame.frameId === "string" && isRecord(frame.view));
}

/** Stable frame ID of a v1 frame. The step is the same for every viewer, so it also holds across a visibility switch. */
export function legacyFrameId(step: number): string {
  return `step-${step}`;
}

export function normalizeReplay(raw: DuelReplay | DuelReplayV2, slug: string, requested: ReplayVisibility): ReplayModel {
  if (isReplayV2(raw)) {
    const frames = raw.frames.map((frame) => ({ ...frame, view: toOrdinaryReplayView(frame.view) }));
    return {
      version: 2,
      slug,
      requested,
      visibility: raw.visibility === "public" ? "public" : "mine",
      sourceVersion: raw.sourceVersion,
      session: raw.session,
      role: raw.role,
      mySeat: raw.mySeat,
      dataSeat: raw.dataSeat,
      frames,
      capabilities: raw.capabilities,
    };
  }
  const legacy = raw as DuelReplay;
  if (!isRecord(legacy) || !Array.isArray(legacy.frames) || !isRecord(legacy.session)) {
    throw new DuelRequestError("The server returned an invalid replay.", 502);
  }
  const lastIndex = legacy.frames.length - 1;
  const frames: ReplayFrameV2[] = legacy.frames.map((frame, index) => {
    const base = {
      frameId: legacyFrameId(frame.step),
      step: frame.step,
      actorSeat: frame.actorSeat,
      view: toOrdinaryReplayView(frame.view),
    };
    // The saved final board and the synthetic result carry no actor; neither one can be a restart point.
    if (index > 0 && index === lastIndex && frame.actorSeat == null) return { ...base, kind: "result", cursor: null };
    return { ...base, kind: index === 0 ? "opening" : "engine", cursor: null };
  });
  return {
    version: 1,
    slug,
    requested,
    visibility: "mine",
    sourceVersion: null,
    session: legacy.session,
    role: legacy.role,
    mySeat: legacy.mySeat,
    dataSeat: legacy.mySeat,
    frames,
  };
}

/* ------------------------------------------------------------------------------------------------
 * Errors
 * ---------------------------------------------------------------------------------------------- */

export interface ReplayFailure {
  message: string;
  /** Offer the saved final board. False only when the server says it has none. */
  finalBoard: boolean;
}

const FAILURE_COPY: Record<string, string> = {
  ENGINE_UNAVAILABLE_FOR_SOURCE:
    "The game engine that played this duel is no longer installed, so the move-by-move replay cannot run. The saved final board is still available.",
  REPLAY_MISMATCH:
    "The saved moves of this duel no longer replay the same way, so the replay cannot run. The saved final board is still available.",
  NOT_PLAYABLE: "This duel cannot be replayed move by move. The saved final board is still available.",
  ENGINE_BUSY: "The duel engine is busy. Try again in a moment.",
  ACCESS_UNAVAILABLE: "Access to this duel cannot be checked right now. Try again in a moment.",
};

export function replayFailure(error: unknown, fallback = "Could not load this replay."): ReplayFailure {
  if (error instanceof DuelRequestError) {
    const typed = error.code ? FAILURE_COPY[error.code] : undefined;
    const message = typed ?? (error.message || fallback);
    const reasonFinalBoard = error.code === "ENGINE_UNAVAILABLE_FOR_SOURCE" || error.code === "REPLAY_MISMATCH"
      || error.code === "NOT_PLAYABLE";
    // A typed engine failure says "final board is still available" in its copy; honor an explicit "none".
    const none = error.finalBoard === "none";
    const text = reasonFinalBoard && none ? message.replace(/ The saved final board is still available\.$/, "") : message;
    return { message: text, finalBoard: !none && error.code !== "ACCESS_DENIED" };
  }
  return { message: error instanceof Error && error.message ? error.message : fallback, finalBoard: true };
}

/* ------------------------------------------------------------------------------------------------
 * Data: one request per (slug, visibility). Only the newest request may write.
 * ---------------------------------------------------------------------------------------------- */

export interface ReplayData {
  /** The newest answer for this slug. While a different visibility loads it can still be the old one. */
  model: ReplayModel | null;
  /** True when `model` answers the current request. */
  settled: boolean;
  error: unknown;
  reload: () => void;
}

export function useReplayData(slug: string, visibility: ReplayVisibility): ReplayData {
  const [model, setModel] = useState<ReplayModel | null>(null);
  const [failure, setFailure] = useState<{ slug: string; visibility: ReplayVisibility; error: unknown } | null>(null);
  const [nonce, setNonce] = useState(0);
  const generation = useRef(0);

  useEffect(() => {
    if (!slug) return;
    const mine = ++generation.current;
    const abort = new AbortController();
    getDuelReplayFrames(slug, visibility, abort.signal)
      .then((raw) => {
        if (mine !== generation.current) return;
        const next = normalizeReplay(raw, slug, visibility);
        setModel(next);
        setFailure(null);
      })
      .catch((error: unknown) => {
        if (mine !== generation.current || abort.signal.aborted) return;
        setFailure({ slug, visibility, error });
      });
    return () => abort.abort();
  }, [slug, visibility, nonce]);

  const current = model && model.slug === slug ? model : null;
  const error = failure && failure.slug === slug && failure.visibility === visibility ? failure.error : null;
  return {
    model: current,
    settled: current != null && current.requested === visibility,
    error,
    reload: useCallback(() => {
      setFailure(null);
      setNonce((value) => value + 1);
    }, []),
  };
}

/* ------------------------------------------------------------------------------------------------
 * Transport: the selected frame, play state, speed and the camera. Camera and cards are separate.
 * ---------------------------------------------------------------------------------------------- */

export function readFrameParam(search: string): string | null {
  const value = new URLSearchParams(search).get(FRAME_PARAM);
  return value && value.length <= 200 ? value : null;
}

export function withFrameParam(href: string, frameId: string | null): string {
  const url = new URL(href, "http://replay.local");
  if (frameId == null) url.searchParams.delete(FRAME_PARAM);
  else url.searchParams.set(FRAME_PARAM, frameId);
  return `${url.pathname}${url.search}${url.hash}`;
}

/** The seat the board is drawn from: the choice, else the viewer's own seat, else seat 0; always a real seat. */
export function resolveCameraSeat(choice: number | null, mySeat: number | null, seatCount: number): number {
  const count = Math.max(seatCount, 1);
  const pick = choice ?? mySeat ?? 0;
  return Number.isInteger(pick) && pick >= 0 && pick < count ? pick : 0;
}

/** The seat drawn across from the camera on the two-seat board: the choice if valid, else the first opponent. */
export function resolveFocusSeat(session: Pick<DuelSession, "format">, camera: number, choice: number | null): number {
  const count = seatCountFor(session.format);
  if (choice != null && choice !== camera && choice >= 0 && choice < count) return choice;
  return opponentSeatsOf(session.format, camera)[0] ?? (camera === 0 ? 1 : 0);
}

export type ReplayKeyAction = "toggle" | "next" | "previous" | "first" | "last";

/** The keyboard map of the replay. Fields, dialogs and focused buttons keep their own keys. */
export function replayKeyAction(event: KeyboardEvent, doc: Pick<Document, "querySelector"> = document): ReplayKeyAction | null {
  if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return null;
  const target = event.target instanceof HTMLElement ? event.target : null;
  const tag = target?.tagName;
  if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA" || target?.isContentEditable) return null;
  // A dialog owns the keyboard, whether focus is inside it or still on the page behind it.
  if (target?.closest("[role='dialog']") || doc.querySelector("[role='dialog'][aria-modal='true']:not([inert])")) return null;
  switch (event.key) {
    case " ":
    case "Spacebar":
      return tag === "BUTTON" || tag === "A" ? null : "toggle";
    case "ArrowRight": return "next";
    case "ArrowLeft": return "previous";
    case "Home": return "first";
    case "End": return "last";
    default: return null;
  }
}

/**
 * Autoplay: steps to the next frame every BASE_STEP_MS / speed and stops at the last one. A coin toss in
 * the replay plays on its own clock, so autoplay waits until it is gone and then steps on.
 */
export function useReplayAutoplay({ playing, index, last, speed, setIndex, setPlaying }: {
  playing: boolean;
  index: number;
  last: number;
  speed: number;
  setIndex: (update: (value: number) => number) => void;
  setPlaying: (playing: boolean) => void;
}): void {
  const coinPlaying = useCoinPlaying();
  useEffect(() => {
    if (!playing) return;
    if (index >= last) {
      setPlaying(false);
      return;
    }
    if (coinPlaying) return;
    const timer = window.setTimeout(() => setIndex((value) => Math.min(value + 1, last)), BASE_STEP_MS / speed);
    return () => window.clearTimeout(timer);
  }, [playing, index, speed, last, coinPlaying, setIndex, setPlaying]);
}

export interface ReplayController {
  index: number;
  last: number;
  frameId: string | null;
  playing: boolean;
  speed: number;
  /** Changes on every seek, camera move and visibility change: the board and effects restart from a clean state. */
  epoch: number;
  camera: number;
  seek: (target: number) => void;
  seekToFrame: (frameId: string) => void;
  stepForward: () => void;
  stepBack: () => void;
  togglePlay: () => void;
  pause: () => void;
  setSpeed: (speed: number) => void;
  setCamera: (seat: number) => void;
  /** Cancel running effects and animations without moving the frame (for example after a visibility switch). */
  resetEffects: () => void;
}

interface Selection {
  frameId: string | null;
  index: number;
}

/**
 * Selection is kept by frame ID, so the same frame stays selected when the frames are replaced (another card
 * visibility) or the page is reloaded (`?frame=`). The index is only the fallback when the ID is gone.
 */
export function useReplayController({ slug, frames, seatCount, mySeat }: {
  slug: string;
  frames: readonly Pick<ReplayFrameV2, "frameId">[] | null;
  seatCount: number;
  mySeat: number | null;
}): ReplayController {
  const [selection, setSelection] = useState<Selection>(() => ({
    frameId: typeof window === "undefined" ? null : readFrameParam(window.location.search),
    index: 0,
  }));
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<number>(1);
  const [epoch, setEpoch] = useState(0);
  const [cameraChoice, setCameraChoice] = useState<number | null>(null);

  const length = frames?.length ?? 0;
  const last = Math.max(length - 1, 0);
  const index = useMemo(() => {
    if (!frames || frames.length === 0) return 0;
    if (selection.frameId != null) {
      const found = frames.findIndex((frame) => frame.frameId === selection.frameId);
      if (found >= 0) return found;
    }
    return Math.min(Math.max(selection.index, 0), frames.length - 1);
  }, [frames, selection]);
  const frameId = frames?.[index]?.frameId ?? null;

  const indexRef = useRef(index);
  indexRef.current = index;
  const framesRef = useRef(frames);
  framesRef.current = frames;

  // A different duel starts at its opening frame, paused, with a fresh camera.
  const lastSlug = useRef(slug);
  useEffect(() => {
    if (lastSlug.current === slug) return;
    lastSlug.current = slug;
    setSelection({ frameId: null, index: 0 });
    setPlaying(false);
    setCameraChoice(null);
    setEpoch((value) => value + 1);
  }, [slug]);

  const select = useCallback((target: number, restart: boolean) => {
    const list = framesRef.current;
    if (!list || list.length === 0) return;
    const clamped = Math.min(Math.max(Math.trunc(target) || 0, 0), list.length - 1);
    setSelection({ frameId: list[clamped].frameId, index: clamped });
    if (restart) setEpoch((value) => value + 1);
  }, []);

  const seek = useCallback((target: number) => select(target, true), [select]);
  const seekToFrame = useCallback((id: string) => {
    const found = framesRef.current?.findIndex((frame) => frame.frameId === id) ?? -1;
    if (found >= 0) select(found, true);
  }, [select]);
  // Forward steps keep the effects of the frame they arrive at; everything else starts clean.
  const setIndexByUpdate = useCallback((update: (value: number) => number) => {
    select(update(indexRef.current), false);
  }, [select]);
  const stepForward = useCallback(() => select(indexRef.current + 1, false), [select]);
  const stepBack = useCallback(() => select(indexRef.current - 1, true), [select]);
  const pause = useCallback(() => setPlaying(false), []);
  const togglePlay = useCallback(() => {
    if (playing) {
      setPlaying(false);
      return;
    }
    if (indexRef.current >= (framesRef.current?.length ?? 1) - 1) select(0, true);
    setPlaying(true);
  }, [playing, select]);
  const setCamera = useCallback((seat: number) => {
    setCameraChoice(seat);
    setEpoch((value) => value + 1);
  }, []);
  const resetEffects = useCallback(() => setEpoch((value) => value + 1), []);

  useReplayAutoplay({ playing, index, last, speed, setIndex: setIndexByUpdate, setPlaying });

  // Keep the selected frame in the address so a reload comes back to it. Debounced: browsers cap history writes.
  useEffect(() => {
    if (typeof window === "undefined" || frameId == null) return;
    const timer = window.setTimeout(() => {
      const next = withFrameParam(`${window.location.pathname}${window.location.search}${window.location.hash}`, frameId);
      if (next !== `${window.location.pathname}${window.location.search}${window.location.hash}`) {
        window.history.replaceState(window.history.state, "", next);
      }
    }, 500);
    return () => window.clearTimeout(timer);
  }, [frameId]);

  useEffect(() => {
    if (!frames) return;
    const onKey = (event: KeyboardEvent) => {
      const action = replayKeyAction(event);
      if (!action) return;
      event.preventDefault();
      if (action === "toggle") togglePlay();
      else if (action === "next") stepForward();
      else if (action === "previous") stepBack();
      else if (action === "first") seek(0);
      else seek(Math.max((framesRef.current?.length ?? 1) - 1, 0));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [frames, togglePlay, stepForward, stepBack, seek]);

  return {
    index,
    last,
    frameId,
    playing,
    speed,
    epoch,
    camera: resolveCameraSeat(cameraChoice, mySeat, seatCount),
    seek,
    seekToFrame,
    stepForward,
    stepBack,
    togglePlay,
    pause,
    setSpeed,
    setCamera,
    resetEffects,
  };
}

/* ------------------------------------------------------------------------------------------------
 * Read-only table controller: what the shared table shells receive in replay mode.
 * ---------------------------------------------------------------------------------------------- */

const NOOP = () => undefined;

function inertDraft(): PromptDraft {
  return {
    selected: [], setSelected: NOOP, counts: {}, setCounts: NOOP, value: 0, setValue: NOOP,
    cardCode: null, setCardCode: NOOP, highlight: 0, setHighlight: NOOP,
  };
}

export function replayRoom(model: Pick<ReplayModel, "session" | "role" | "mySeat">, engine: DuelEngineView): DuelRoom {
  return {
    session: model.session,
    role: model.role,
    mySeat: model.mySeat,
    myDeck: null,
    engine,
    clock: null,
    metadataOnly: false,
  };
}

/**
 * A controller that cannot act. No prompt, no legal or selected keys, no seat pick or aim, and an answer
 * callback that does nothing, so a shell given this controller can inspect and move the camera but never
 * send a live action. `viewerSeat` is the camera seat.
 */
export function createReadOnlyTableController(input: {
  room: DuelRoom;
  engine: DuelEngineView;
  camera: number;
  nameOf: (seat: number) => string;
  reducedMotion: boolean;
  onActivate: DuelActivateHandler;
  onInspect: (target: InspectTarget) => void;
  onHoverCard?: DuelHoverHandler;
}): TableController {
  return {
    room: input.room,
    engine: input.engine,
    viewerSeat: input.camera,
    nameOf: input.nameOf,
    prompt: null,
    promptSeat: null,
    canAct: false,
    busy: false,
    revealed: false,
    draft: inertDraft(),
    legalKeys: new Set(),
    selectedKeys: new Set(),
    aim: null,
    seatPick: null,
    reducedMotion: input.reducedMotion,
    onAnswer: NOOP,
    onActivate: input.onActivate,
    onInspect: input.onInspect,
    onHoverCard: input.onHoverCard,
    attackAim: null,
  };
}

/* ------------------------------------------------------------------------------------------------
 * Words
 * ---------------------------------------------------------------------------------------------- */

/** "Opening board", "<name> acted", "Final result" for a frame. */
export function frameCaption(frame: Pick<ReplayFrameV2, "kind" | "actorSeat">, index: number, atEnd: boolean, playerName: (seat: number) => string): string {
  if (index === 0) return "Opening board";
  if (frame.actorSeat == null) return frame.kind === "result" || atEnd ? "Final result" : "Update";
  return `${playerName(frame.actorSeat)} acted`;
}

export function replayResultHeadline(
  session: Pick<DuelSession, "status" | "format">,
  result: { winnerSeat: number | null; winnerTeam?: number | null } | null,
  playerName: (seat: number) => string,
): string {
  if (session.status === "interrupted") return "Interrupted";
  const winner = result?.winnerSeat;
  if (winner == null) return "Draw";
  if (session.format === "tag") {
    const teamIndex = result?.winnerTeam ?? winner % 2;
    const team = seatTeamLabel(session.format, teamIndex) ?? "Team";
    const members = seatsOfTeam(session.format, teamIndex).map(playerName).join(" & ");
    return `${team} wins · ${members}`;
  }
  return `${playerName(winner)} wins`;
}
