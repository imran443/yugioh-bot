"use client";

import type { CSSProperties, ReactNode } from "react";
import Link from "next/link";
import { Eye, Film, Radio, Volume2, VolumeX } from "lucide-react";
import { isCustomDomain, teamOfSeat, type DuelEngineView, type DuelSession } from "@yugidraft/shared/duels";
import { connectionLabel as labelForConnection } from "../connection-label";
import { isBattlePhase, phaseTitle } from "../constants";
import type { DuelPreferences } from "../preferences";
import roomStyles from "../room.module.css";
import hudStyles from "../table/grid-hud.module.css";
import type { TableConnection } from "../table/table-settings";
import { SEAT_TONE_HEX } from "../table/types";
import { hexToRgbTriplet } from "../table/seat-angle";
import { tagTurnText, type TagTeamNames } from "./live-tag";
import styles from "./tag-header.module.css";

/** The tone of a Rooftop seat: team 0 violet, team 1 gold-leaning rose, so the pill reads without the camera. */
const TEAM_TONE = [SEAT_TONE_HEX.violet, SEAT_TONE_HEX.rose] as const;

export interface TagHeaderProps {
  /** The mode label (Domain or MR) and the title come from the session, never from a fixed word. */
  session: DuelSession;
  engine: Pick<DuelEngineView, "turn" | "turnSeat" | "phase" | "battleStep">;
  viewerSeat: number | null;
  nameOf: (seat: number) => string;
  teamNames: TagTeamNames;
  /** The account preference from `useDuelPreferences()`: the same object the shell gives the FX and sound. */
  preferences: Pick<DuelPreferences, "soundEnabled" | "setSoundEnabled">;
  connection?: TableConnection;
  /** Room controls, such as the Surrender button. */
  headerTools?: ReactNode;
  /** Shown when the room can leave the finished duel. */
  onExit?: () => void;
  /** Shown when the player hid the result screen. */
  onShowResult?: () => void;
  /**
   * The floating HUD (wide screens): the header is three glass pills over the board, and `baton` (the turn order)
   * sits in the middle one. The nodes inside stay the same, so the e2e hooks (`data-tag-turn`, the who pill) hold.
   */
  /** `clock`: the clock block pill (hudClockBank), right of the identity pill. */
  hud?: { baton: ReactNode; clock?: ReactNode };
  /** Replay mode: the connection label reads "Replay", `tools` replace `headerTools`, and "Your turn" reads as a name (the camera seat is not a player). */
  replay?: { tools?: ReactNode };
}

/** The mode label of the pill: "Domain", "Custom Domain" or "MR5". */
export function tagModeLabel(session: Pick<DuelSession, "mode" | "masterRule" | "settings">): string {
  if (session.mode === "domain") return isCustomDomain(session.masterRule, session.settings) ? "Custom Domain" : "Domain";
  return `MR${session.masterRule}`;
}

/**
 * The header of the live Rooftop: title, mode, "Turn N" (its own node, so e2e can match it), the phase, who plays,
 * header tools, the connection label and the sound switch. Styles come from the shell's tokens (--duel-*).
 */
export function TagHeader({ session, engine, viewerSeat, nameOf, teamNames, preferences, connection, headerTools, onExit, onShowResult, hud, replay }: TagHeaderProps) {
  const spectator = viewerSeat == null;
  const turnSeat = engine.turnSeat;
  const myTurn = !spectator && turnSeat === viewerSeat;
  const youTurn = myTurn && !replay;
  const terminal = session.status !== "active";
  const connectionLabel = labelForConnection(terminal, connection);
  const live = connectionLabel === "Live";
  const phase = isBattlePhase(engine.phase) ? "Battle Phase" : phaseTitle(engine.phase);
  const turnTeam = teamOfSeat("tag", turnSeat);
  const tone = TEAM_TONE[turnTeam] ?? TEAM_TONE[0];
  const soundLabel = preferences.soundEnabled ? "On" : "Off";
  const identityNode = (
    <div className={styles.identity}>
      <Link href="/duels">Dueling Domain</Link>
      <i aria-hidden>/</i>
      <span className={styles.title} title={session.name}>{session.name}</span>
      <em className={styles.format}>{tagModeLabel(session)} &middot; Tag duel (2v2)</em>
      {spectator ? (
        <strong className={styles.spectator} title="You are watching. Hidden cards stay private.">
          <Eye size={13} strokeWidth={1.75} aria-hidden /> You are spectating
        </strong>
      ) : null}
    </div>
  );
  const turnNode = (
    <div className={styles.turn}>
      <strong data-tag-turn>{tagTurnText(engine.turn)}</strong>
      <span className={styles.phase}>{phase}</span>
      <span
        className={styles.turnPill}
        data-mine={myTurn ? "true" : "false"}
        data-testid="who-pill"
        style={{ "--turn": hexToRgbTriplet(tone.main) } as CSSProperties}
      >
        <span className={styles.turnLabel}>
          {spectator ? `${nameOf(turnSeat)} to play` : youTurn ? "Your turn" : `${nameOf(turnSeat)}'s turn`}
        </span>
        <small>&middot; {teamNames[turnTeam]}</small>
      </span>
    </div>
  );
  const statusNode = (
    <div className={styles.status}>
      {replay ? replay.tools : headerTools}
      {replay ? (
        <span className={roomStyles.connectionStatus} data-replay-label>
          <Film size={15} strokeWidth={1.75} aria-hidden />
          <span className={roomStyles.connectionText}>Replay</span>
        </span>
      ) : (
        <span className={roomStyles.connectionStatus} role="status" aria-live="polite" data-live={live}>
          {live ? <i className={roomStyles.liveDot} aria-hidden /> : <Radio size={15} strokeWidth={1.75} aria-hidden />}
          <span className={roomStyles.connectionText}>
            {live ? (spectator ? "Live duel · watching" : "Live duel") : connectionLabel}
          </span>
        </span>
      )}
      {onShowResult ? <button type="button" className={styles.tool} onClick={onShowResult}><span>Show result</span></button> : null}
      {onExit ? <button type="button" className={styles.tool} onClick={onExit}><span>Exit duel</span></button> : null}
      <button
        type="button"
        className={styles.tool}
        data-sound-toggle
        aria-label={`Sound effects ${soundLabel.toLowerCase()}`}
        aria-pressed={preferences.soundEnabled}
        onClick={() => preferences.setSoundEnabled(!preferences.soundEnabled)}
      >
        {preferences.soundEnabled ? <Volume2 size={15} strokeWidth={1.75} aria-hidden /> : <VolumeX size={15} strokeWidth={1.75} aria-hidden />}
      </button>
    </div>
  );
  if (hud) {
    return (
      <header className={`${hudStyles.top} ${styles.hudTop}`} data-tag-header data-testid="hud-top">
        <div className={hudStyles.topLeft}>{identityNode}</div>
        {hud.clock}
        <div className={hudStyles.topMid}>{hud.baton}</div>
        <div className={hudStyles.topRight}>{turnNode}{statusNode}</div>
      </header>
    );
  }
  return (
    <header className={styles.header} data-tag-header>
      {identityNode}
      {turnNode}
      {statusNode}
    </header>
  );
}
