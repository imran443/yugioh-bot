"use client";

import Link from "next/link";
import { forwardRef, memo } from "react";
import { useDraftStore } from "@/lib/stores/draft-store";
import { ARROW } from "./card-img";
import { CANCEL_ICON } from "./cancel-confirm";
import { motionLabel } from "./motion-menu";
import type { Motion } from "./motion";
import { formatClock, passLabel } from "./room-model";

export interface WhereProps {
  theme: boolean;
  extra: boolean;
  packRound: number;
  packsPerPlayer: number;
  pickStep: number;
  packSize: number;
  direction: 1 | -1;
  /** Theme drafts: picks made in this phase, and the phase's size. */
  phaseDone: number;
  phaseOf: number;
  /** Booster drafts: the Extra Deck round is on, and its pack size. */
  boosterExtraSize?: number;
}

function Where(w: WhereProps) {
  if (w.theme) {
    return (
      <div className="where">
        <span className="w">{w.extra ? "Extra deck" : "Main deck"}</span>
        <span className="w">
          Pick <b>{Math.min(w.phaseDone + 1, w.phaseOf)}</b> of {w.phaseOf}
        </span>
        <span className="pass">Private pack</span>
      </div>
    );
  }
  if ((w.boosterExtraSize ?? 0) > 0 && w.packRound > w.packsPerPlayer) {
    return (
      <div className="where">
        <span className="w">Extra Deck round</span>
        <span className="w">
          Pick <b>{w.pickStep}</b> of {w.boosterExtraSize}
        </span>
        <span className="pass">
          {ARROW}
          {passLabel(w.direction)}
        </span>
      </div>
    );
  }
  return (
    <div className="where">
      <span className="w">
        Pack <b>{w.packRound}</b> of {w.packsPerPlayer}
      </span>
      <span className="w">
        Pick <b>{w.pickStep}</b> of {w.packSize}
      </span>
      <span className="pass">
        {ARROW}
        {passLabel(w.direction)}
      </span>
    </div>
  );
}

function ClockText() {
  const seconds = useDraftStore((s) => s.timerSeconds);
  return <b>{formatClock(seconds)}</b>;
}

export interface RoomBarProps {
  name: string;
  sub: string;
  where: WhereProps;
  motion: Motion;
  motionOpen: boolean;
  onMotion: () => void;
  /** Seated players can say a line to the table. */
  canSay: boolean;
  sayOpen: boolean;
  onSay: (anchor: HTMLElement) => void;
  /** The host or an owner: the Cancel draft button, which opens the confirm. */
  canCancel?: boolean;
  onCancel?: (anchor: HTMLElement) => void;
  /** 0 to 1: how far through the draft you are. */
  progress: number;
}

export const SAY_ICON = (
  <svg viewBox="0 0 20 20" aria-hidden="true">
    <path d="M4 4.5h12a1.5 1.5 0 0 1 1.5 1.5v6.5A1.5 1.5 0 0 1 16 14H9l-4 3v-3H4a1.5 1.5 0 0 1-1.5-1.5V6A1.5 1.5 0 0 1 4 4.5Z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
  </svg>
);

export const RoomBar = memo(
  forwardRef<HTMLButtonElement, RoomBarProps>(function RoomBar(p, motionRef) {
    return (
      <header className="bar">
        <div className="id">
          <Link className="back" href="/drafts" aria-label="Back to drafts">
            ‹
          </Link>
          <div className="room-name">
            <b>{p.name}</b>
            <small>{p.sub}</small>
          </div>
        </div>
        <Where {...p.where} />
        <div className="right">
          {p.canSay ? (
            <button
              className="ibtn say-btn"
              type="button"
              aria-expanded={p.sayOpen}
              aria-controls="sayPop"
              aria-label="Say something to the table"
              onClick={(e) => p.onSay(e.currentTarget)}
            >
              {SAY_ICON}
              <span className="t">Say</span>
            </button>
          ) : null}
          {p.canCancel ? (
            <button
              className="ibtn cancel-btn"
              type="button"
              aria-haspopup="dialog"
              aria-label="Cancel draft"
              data-tone="danger"
              onClick={(e) => p.onCancel?.(e.currentTarget)}
            >
              {CANCEL_ICON}
              <span className="t">Cancel draft</span>
            </button>
          ) : null}
          <button
            ref={motionRef}
            className="ibtn"
            type="button"
            aria-expanded={p.motionOpen}
            aria-controls="motionPop"
            aria-label={`Animations: ${motionLabel(p.motion)}`}
            onClick={p.onMotion}
          >
            <svg viewBox="0 0 20 20" aria-hidden="true">
              <path d="M2 10c2.2 0 2.2-5 4.4-5s2.2 10 4.4 10 2.2-10 4.4-10S17.4 10 18 10" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
            <span className="t">Animations</span>
          </button>
          <div className="clock" role="timer" aria-label="Time left to pick">
            <small>Pick clock</small>
            <ClockText />
          </div>
        </div>
        <div className="progress" aria-hidden="true">
          <i style={{ "--p": p.progress } as React.CSSProperties} />
        </div>
      </header>
    );
  }),
);
