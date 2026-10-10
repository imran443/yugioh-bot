"use client";

import { useCallback, useMemo, type ReactNode } from "react";
import Link from "next/link";
import { ChevronLeft, ChevronRight, Flag, History, Pause, Play, SkipBack, SkipForward } from "lucide-react";
import { type DuelEngineView, type ReplayVisibility } from "@yugidraft/shared/duels";
import { useDuelPreferences } from "./preferences";
import { useIsNarrow } from "./side-panel";
import {
  SPEEDS,
  createReadOnlyTableController,
  frameCaption,
  replayResultHeadline,
  replayRoom,
  type ReplayController,
  type ReplayModel,
} from "./replay-controller";
import type { ReplayTimeline } from "./replay-timeline";
import { defaultTeamNames } from "./tag/live-tag";
import { TagShell } from "./tag/tag-shell";
import styles from "./replay-tag.module.css";

const noop = () => undefined;

export interface ReplayTagProps {
  slug: string;
  model: ReplayModel;
  timeline: ReplayTimeline<ReplayModel["frames"][number]>;
  /** The cumulative board of the selected frame (`timeline.viewAt(controller.index)`). */
  engine: DuelEngineView;
  controller: ReplayController;
  /** The card view the frames were fetched for. */
  visibility: ReplayVisibility;
  onVisibilityChange: (next: ReplayVisibility) => void;
  /** A failed card-view switch: what is on screen stays, this says why. */
  notice?: string | null;
  /** Extra header controls (for example Jump in, owner only). They sit before the view controls. */
  tools?: ReactNode;
}

/**
 * The Tag replay: the live Rooftop table (four seats, teams 0+2 and 1+3, team LP plates, shared Extra Monster zones)
 * in read-only replay mode. The shell only ever sees a controller that cannot act. The camera seat decides which
 * seat is drawn at home; the cards each seat shows were fixed by the server for the card view that was asked for,
 * so a camera change never reveals a card and never refetches.
 */
export function ReplayTag({ slug, model, timeline, engine, controller, visibility, onVisibilityChange, notice, tools }: ReplayTagProps) {
  const preferences = useDuelPreferences();
  const narrow = useIsNarrow();
  const { session } = model;
  const { index, last, playing, speed, camera } = controller;
  const frame = timeline.frame(index);
  const teamNames = useMemo(() => defaultTeamNames(), []);

  const nameOf = useCallback(
    (seat: number) => session.seats.find((player) => player.seat === seat)?.displayName ?? `Player ${seat + 1}`,
    [session.seats],
  );
  const room = useMemo(() => replayRoom(model, engine), [model, engine]);
  const table = useMemo(
    () => createReadOnlyTableController({
      room, engine, camera, nameOf, reducedMotion: preferences.reducedMotion,
      onActivate: noop, onInspect: noop, onHoverCard: noop,
    }),
    [room, engine, camera, nameOf, preferences.reducedMotion],
  );

  const atEnd = index >= last;
  const result = atEnd ? (engine.result ?? (session.resultReason ? { winnerSeat: session.winnerSeat, reason: session.resultReason } : null)) : null;
  const actor = frameCaption(frame, index, atEnd, nameOf);
  const headline = replayResultHeadline(session, result, nameOf);
  const canSwitchCards = model.version === 2 && model.mySeat != null;
  const publicOnly = model.mySeat == null || model.visibility === "public";
  const seats = [0, 1, 2, 3];

  // The seat, card view and page links: in the header on a wide screen, in the transport bar on a narrow one.
  const viewControls = (
    <div className={styles.tools} role="group" aria-label="Replay view">
      <label className={styles.field}>
        <span>View from</span>
        <select className={styles.select} value={camera} aria-label="View from seat" title="View from seat" onChange={(event) => controller.setCamera(Number(event.target.value))}>
          {seats.map((seat) => (
            <option key={seat} value={seat}>{nameOf(seat)} ({teamNames[seat % 2]})</option>
          ))}
        </select>
      </label>
      {canSwitchCards ? (
        <div className={styles.segmented} role="group" aria-label="Card visibility">
          {(["mine", "public"] as const).map((value) => (
            <button key={value} type="button" aria-pressed={visibility === value} onClick={() => onVisibilityChange(value)}>
              {value === "mine" ? "My cards" : "Public"}
            </button>
          ))}
        </div>
      ) : null}
      <Link href="/duels?view=history" className={styles.linkIcon} aria-label="Match history" title="Match history"><History size={16} aria-hidden /></Link>
      <Link href={`/duels/${slug}`} className={styles.linkIcon} aria-label="Final board" title="Final board"><Flag size={16} aria-hidden /></Link>
    </div>
  );

  const transport = (
    <div className={styles.panel} data-narrow={narrow ? "true" : undefined}>
      <div className={styles.text} aria-live="off">
        {result ? (
          <div role="status" data-replay-result className={styles.result}>
            <strong title={headline}>{headline}</strong>
            <span title={result.reason}>{result.reason}</span>
          </div>
        ) : (
          <p className={styles.actor}>{actor}</p>
        )}
        {result ? <p className={styles.actor}>{actor}</p> : null}
      </div>
      <div className={styles.buttons} role="group" aria-label="Replay controls">
        <button type="button" className={styles.icon} aria-label="First move" disabled={index === 0} onClick={() => controller.seek(0)}><SkipBack size={16} aria-hidden /></button>
        <button type="button" className={styles.icon} aria-label="Previous move" disabled={index === 0} onClick={controller.stepBack}><ChevronLeft size={18} aria-hidden /></button>
        <button type="button" className={`${styles.icon} ${styles.play}`} aria-label={playing ? "Pause" : "Play"} onClick={controller.togglePlay}>
          {playing ? <Pause size={18} aria-hidden /> : <Play size={18} aria-hidden />}
        </button>
        <button type="button" className={styles.icon} aria-label="Next move" disabled={atEnd} onClick={controller.stepForward}><ChevronRight size={18} aria-hidden /></button>
        <button type="button" className={styles.icon} aria-label="Last move" disabled={atEnd} onClick={() => controller.seek(last)}><SkipForward size={16} aria-hidden /></button>
      </div>
      <div className={styles.scrub}>
        <input type="range" className={styles.slider} aria-label="Replay position" min={0} max={last} step={1} value={index}
          aria-valuetext={`Move ${index} of ${last}`} onChange={(event) => controller.seek(Number(event.target.value))} />
        <span className={styles.count}>{index} / {last}</span>
        <label className={styles.speed}>
          <span className="sr-only">Playback speed</span>
          <select className={styles.select} value={speed} aria-label="Playback speed" onChange={(event) => controller.setSpeed(Number(event.target.value))}>
            {SPEEDS.map((value) => <option key={value} value={value}>{value}×</option>)}
          </select>
        </label>
      </div>
      {narrow ? viewControls : null}
    </div>
  );

  const headerTools = (
    <>
      {tools}
      {narrow ? null : viewControls}
    </>
  );

  const notices = (notice || publicOnly) ? (
    <div className={styles.notices}>
      {notice ? <p role="alert" className={styles.note}>{notice}</p> : null}
      {publicOnly ? <p className={styles.note} data-replay-public-note>Public view · hidden cards stay hidden</p> : null}
    </div>
  ) : null;

  return (
    <div data-replay-frame={controller.frameId ?? undefined} data-replay-visibility={model.visibility} data-replay-camera={camera}>
      <TagShell
        controller={table}
        teamNames={teamNames}
        mode={session.mode}
        fillViewport
        preferences={preferences}
        notices={notices}
        replay={{ transport, resetKey: controller.epoch, tools: headerTools }}
      />
    </div>
  );
}
