"use client";

import { useCallback, useMemo } from "react";
import Link from "next/link";
import { ChevronLeft, ChevronRight, Pause, Play, SkipBack, SkipForward } from "lucide-react";
import type { DuelEngineView, DuelSession, ReplayFrameV2, ReplayVisibility } from "@yugidraft/shared/duels";
import { isEliminated } from "./multi-seat";
import type { DuelPreferences } from "./preferences";
import {
  SPEEDS,
  createReadOnlyTableController,
  frameCaption,
  replayResultHeadline,
  replayRoom,
  type ReplayController,
  type ReplayModel,
} from "./replay-controller";
import type { ReplayLogEntry } from "./replay-timeline";
import { TableShell } from "./table/table-shell";
import type { ReplayShellMode } from "./table/types";
import replayStyles from "./replay.module.css";
import styles from "./replay-ffa.module.css";

/** The replay of a free-for-all table of 3 or 4: the shared table shell (plaza or 2x2 grid) in replay mode. */
export function isFfaFormat(format: DuelSession["format"]): boolean {
  return format === "ffa3" || format === "ffa4";
}

/**
 * Who had lost by the selected frame, earliest first. Seats that lose in one frame share a group (and a place). It reads
 * the frames up to `index`, so a seek, a rewind or a reload gives the same order as watching from the start; it does not
 * depend on the capped text log. Seats that were already out at the first frame form one group: their order is unknown.
 */
export function lossOrderAt(frames: ReadonlyArray<Pick<ReplayFrameV2, "view">>, index: number): number[][] {
  const groups: number[][] = [];
  const seen = new Set<number>();
  const end = Math.min(Math.max(index, 0), frames.length - 1);
  for (let at = 0; at <= end; at += 1) {
    const added: number[] = [];
    for (const seat of frames[at].view.seats) {
      if (isEliminated(seat) && !seen.has(seat.seat)) {
        seen.add(seat.seat);
        added.push(seat.seat);
      }
    }
    if (added.length > 0) groups.push(added);
  }
  return groups;
}

interface TransportProps {
  slug: string;
  controller: ReplayController;
  seatCount: number;
  playerName: (seat: number) => string;
  caption: string;
  newLines: ReplayLogEntry[];
  result: { headline: string; reason: string } | null;
  visibility: ReplayVisibility;
  hiddenNote: boolean;
  /** Card visibility can be switched (the viewer has a real seat and the server speaks version 2). */
  canSwitchCards: boolean;
  onVisibility: (next: ReplayVisibility) => void;
  onCamera: (seat: number) => void;
  notice: string | null;
}

/**
 * The transport of the table replay: first, previous, play, next, last, the slider, the speed, the seat the board is drawn
 * from and the card visibility. It sits in the shell's transport slot; it never sends an action.
 */
export function ReplayTableTransport({
  slug, controller, seatCount, playerName, caption, newLines, result, visibility, hiddenNote, canSwitchCards, onVisibility, onCamera, notice,
}: TransportProps) {
  const { index, last, playing, speed, camera } = controller;
  const atEnd = index >= last;
  const seats = Array.from({ length: seatCount }, (_, seat) => seat);
  // One slim line says what happened: who acted, then the newest log line of this frame (the full log is in the side pane).
  const said = newLines.length > 0 ? newLines[newLines.length - 1].text : "";
  const icon = `${replayStyles.iconButton} ${styles.icon}`;
  return (
    <div className={styles.bar} data-replay-table-transport>
      {result ? (
        <div className={styles.result} role="status">
          <strong>{result.headline}</strong>
          <span>{result.reason}</span>
        </div>
      ) : null}
      <div className={styles.top}>
        <span className={styles.say} aria-live="off" title={said ? `${caption}. ${said}` : caption}>
          <b>{caption}</b>{said ? <> · {said}</> : null}
        </span>
        <Link href={`/duels/${slug}`} className={replayStyles.link}>Final board</Link>
      </div>
      <div className={styles.row}>
        <div className={replayStyles.buttons} role="group" aria-label="Replay controls">
          <button type="button" className={icon} aria-label="First move"
            disabled={index === 0} onClick={() => controller.seek(0)}><SkipBack size={16} aria-hidden /></button>
          <button type="button" className={icon} aria-label="Previous move"
            disabled={index === 0} onClick={controller.stepBack}><ChevronLeft size={18} aria-hidden /></button>
          <button type="button" className={`${icon} ${replayStyles.play}`}
            aria-label={playing ? "Pause" : "Play"} onClick={controller.togglePlay}>
            {playing ? <Pause size={18} aria-hidden /> : <Play size={18} aria-hidden />}
          </button>
          <button type="button" className={icon} aria-label="Next move"
            disabled={atEnd} onClick={controller.stepForward}><ChevronRight size={18} aria-hidden /></button>
          <button type="button" className={icon} aria-label="Last move"
            disabled={atEnd} onClick={() => controller.seek(last)}><SkipForward size={16} aria-hidden /></button>
        </div>
        <div className={styles.meta}>
          <span>Move {index} / {last}</span>
          <label>
            <span className="sr-only">Playback speed</span>
            <select className={`${replayStyles.select} ${styles.speed}`} value={speed} aria-label="Playback speed"
              onChange={(event) => controller.setSpeed(Number(event.target.value))}>
              {SPEEDS.map((value) => <option key={value} value={value}>{value}×</option>)}
            </select>
          </label>
        </div>
      </div>
      <input type="range" className={`${replayStyles.slider} ${styles.slider}`} aria-label="Replay position"
        min={0} max={last} step={1} value={index}
        aria-valuetext={`Move ${index} of ${last}`}
        onChange={(event) => controller.seek(Number(event.target.value))} />
      <div className={styles.view} role="group" aria-label="Replay view">
        <label>
          <span>View from</span>
          <select className={`${replayStyles.select} ${styles.camera}`} value={camera} aria-label="View from seat"
            onChange={(event) => onCamera(Number(event.target.value))}>
            {seats.map((seat) => <option key={seat} value={seat}>{playerName(seat)}</option>)}
          </select>
        </label>
        {canSwitchCards ? (
          <div className={`${replayStyles.segmented} ${styles.cards}`} role="group" aria-label="Card visibility">
            {(["mine", "public"] as const).map((value) => (
              <button key={value} type="button" aria-pressed={visibility === value}
                onClick={() => onVisibility(value)}>
                {value === "mine" ? "My cards" : "Public"}
              </button>
            ))}
          </div>
        ) : null}
      </div>
      {notice ? <p role="alert" className={styles.note}>{notice}</p> : null}
      {hiddenNote ? <p className={styles.note}>Public view — hidden cards stay hidden</p> : null}
    </div>
  );
}

export interface ReplayFfaProps {
  slug: string;
  model: ReplayModel;
  /** The selected frame's engine view and its neighbours. */
  frames: readonly ReplayFrameV2[];
  engine: DuelEngineView;
  controller: ReplayController;
  preferences: DuelPreferences;
  visibility: ReplayVisibility;
  canSwitchCards: boolean;
  onVisibility: (next: ReplayVisibility) => void;
  /** Called before the board is drawn from another seat (the page drops its inspector state). */
  onCamera?: (seat: number) => void;
  notice: string | null;
  /** The log lines new at this frame (for the caption). */
  newLines: ReplayLogEntry[];
  /** Extra header controls (for example Jump in). */
  tools?: ReplayShellMode["tools"];
}

/**
 * The 3-way plaza and the 4-way 2x2 grid of a replay. All fields are drawn at once from the selected frame; the engine's
 * own view decides who shares Extra Monster Zones and who is out. The controller is read-only: the shell cannot answer.
 * The card visibility was fixed by the server; the camera seat only decides where each field is drawn.
 */
export function ReplayFfa({
  slug, model, frames, engine, controller, preferences, visibility, canSwitchCards, onVisibility, onCamera, notice, newLines, tools,
}: ReplayFfaProps) {
  const { index, last, epoch, camera } = controller;
  const session = model.session;
  const seatCount = session.seats.length;
  const atEnd = index >= last;
  const frame = frames[index];
  // One function per seat list, so the table's memos hold while a frame plays.
  const playerName = useCallback(
    (seat: number) => session.seats.find((player) => player.seat === seat)?.displayName ?? `Player ${seat + 1}`,
    [session.seats],
  );
  const result = atEnd ? (engine.result ?? (session.resultReason ? { winnerSeat: session.winnerSeat, reason: session.resultReason } : null)) : null;
  const table = useMemo(() => createReadOnlyTableController({
    room: replayRoom(model, engine),
    engine,
    camera,
    nameOf: playerName,
    reducedMotion: preferences.reducedMotion,
    // The shell shows the card in its own panel; the page owns nothing here.
    onActivate: () => undefined,
    onInspect: () => undefined,
  }), [model, engine, camera, playerName, preferences.reducedMotion]);
  // The table remounts on a new key. Losses are read from the frames, so a seek lands on the same order as playing there.
  const initialOutOrder = useMemo(() => lossOrderAt(frames, index), [frames, index]);
  const resetKey = `${slug}:${model.visibility}:${epoch}`;
  const transport = (
    <ReplayTableTransport
      slug={slug}
      controller={controller}
      seatCount={seatCount}
      playerName={playerName}
      caption={frameCaption(frame, index, atEnd, playerName)}
      newLines={newLines}
      result={result ? { headline: replayResultHeadline(session, result, playerName), reason: result.reason } : null}
      visibility={visibility}
      hiddenNote={model.mySeat == null || model.visibility === "public"}
      canSwitchCards={canSwitchCards}
      onVisibility={onVisibility}
      onCamera={(seat) => { onCamera?.(seat); controller.setCamera(seat); }}
      notice={notice}
    />
  );
  const replay: ReplayShellMode = { transport, resetKey, tools };
  return (
    <div data-replay-frame={controller.frameId ?? undefined} data-replay-visibility={model.visibility} data-replay-format={session.format}
      className="-mx-4 -my-4 sm:-mx-6 sm:-my-6 lg:-mx-8 lg:-my-8">
      <TableShell controller={table} replay={replay} preferences={preferences} initialOutOrder={initialOutOrder} fillViewport />
    </div>
  );
}
