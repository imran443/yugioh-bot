"use client";

import { useMemo, useState } from "react";
import { DUEL_OPENING_PICK_MS, DUEL_OPENING_TIE_REVEAL_MS, defaultDuelSettings, type DuelDeck, type DuelRpsOpeningView, type DuelRoom, type DuelSeriesSummary } from "@yugidraft/shared/duels";
import { SeriesGameLabel } from "../series-banner";
import { DuelResultScreen } from "../duel-result";
import { BetweenGamesScreen, type CardMeta } from "../between-games";
import { NO_MARKS, type SideMarks } from "../side-deck-model";
import styles from "../room.module.css";
import { OpeningScreen } from "../opening";
import type { LabBoard, LabOpening, LabSeries } from "./board";
import { CARDS as C } from "./cards";

/**
 * The Best of 3 part of the FX lab: a room for the series scenarios, the real header label and the
 * real Between games and match screens. The buttons that save or ready call the real API, which
 * answers with an error in the lab; that is the only part that is not live.
 */

const NAMES: [string, string] = ["Sulman", "Imran"];
const BOT_NAMES: [string, string] = ["Sulman", "Practice Bot"];
const namesOf = (spec: LabSeries) => (spec.vsBot ? BOT_NAMES : NAMES);

/** Full sections expose layout regressions that a six-card fixture would hide. */
const MAIN_CODES = [C.sangan.code, C.kuriboh.code, C.potOfGreed.code, C.monsterReborn.code, C.blueEyes.code, C.darkMagician.code];
const EXTRA_CODES = [C.darkPaladin.code, C.stardust.code, C.utopia.code];
const SIDE_CODES = [C.cyberDragon.code, C.summonedSkull.code, C.utopia.code];
const SIDE_DECK: DuelDeck = {
  main: Array.from({ length: 40 }, (_, i) => MAIN_CODES[i % MAIN_CODES.length]),
  extra: Array.from({ length: 15 }, (_, i) => EXTRA_CODES[i % EXTRA_CODES.length]),
  side: Array.from({ length: 15 }, (_, i) => SIDE_CODES[i % SIDE_CODES.length]),
};

const NO_SIDE_DECK: DuelDeck = { ...SIDE_DECK, side: [] };
const MAX_SIDE_DECK: DuelDeck = { ...SIDE_DECK, main: Array.from({ length: 60 }, (_, i) => MAIN_CODES[i % MAIN_CODES.length]) };

/** Names and types of the lab cards, so the screen routes Extra Deck monsters without a card database. */
const KNOWN_CARDS: ReadonlyMap<number, CardMeta> = new Map(
  Object.values(C).map((card) => [card.code, { name: card.name, type: card.type }] as const),
);

/** Siding in progress: a Main card and an Extra card out, a Main card and an Extra monster in (or one fewer in). */
function labMarks(spec: LabSeries): SideMarks {
  if (spec.marks === "even") return { out: [{ section: "main", index: 1 }, { section: "extra", index: 0 }], inn: [0, 2] };
  if (spec.marks === "uneven") return { out: [{ section: "main", index: 1 }, { section: "main", index: 2 }], inn: [0] };
  return NO_MARKS;
}

function summary(spec: LabSeries): DuelSeriesSummary {
  const over = spec.screen === "won";
  const between = spec.screen === "ready" || spec.screen === "side";
  const nextLive = spec.screen === "next-live";
  return {
    id: 7,
    bestOf: 3,
    ranked: false,
    status: over ? "completed" : between ? "between_games" : "active",
    playerIds: [1, spec.vsBot ? 0 : 2],
    displayNames: namesOf(spec),
    wins: spec.wins,
    gameNumber: nextLive ? spec.game + 1 : spec.game,
    currentDuelSlug: nextLive ? "fx-lab-next" : "fx-lab",
    winnerPlayerId: over ? (spec.wins[0] > spec.wins[1] ? 1 : spec.vsBot ? null : 2) : null,
    tournamentId: null,
    tournamentSlug: null,
    tournamentMatchId: null,
    nextGameAt: between ? new Date(Date.now() + (spec.secondsLeft ?? 45) * 1000).toISOString() : null,
    // The practice bot is ready at once and never sides.
    // Humans still click Ready when they have no Side Deck.
    sideReady: [false, spec.vsBot ? true : spec.opponentReady === true],
    hasSide: [spec.noSide !== true, !spec.vsBot],
    // The loser of the game on screen chooses: you when the opponent leads, the opponent when you lead.
    firstChooser: between ? (spec.wins[0] > spec.wins[1] ? 1 : 0) : null,
    // The bot chooses to go first by itself when it lost the game.
    firstChoice: between ? (spec.vsBot && spec.wins[0] > spec.wins[1] ? "first" : spec.choice ?? null) : null,
    vsBot: spec.vsBot === true,
  };
}

export function labSeriesRoom(board: LabBoard, spec: LabSeries): DuelRoom {
  const finished = spec.screen !== "label";
  const spectator = spec.viewer === "spectator";
  // Game 1 is the one you just won or lost: the leader of the score won it. Game 3 of the match was won by the match winner.
  const winnerSeat = spec.wins[0] > spec.wins[1] ? 0 : 1;
  const result = finished ? { winnerSeat, reason: "Life points reached 0" } : null;
  const deck = spec.noSide ? NO_SIDE_DECK : spec.mainCount === 60 ? MAX_SIDE_DECK : SIDE_DECK;
  return {
    session: {
      id: 1,
      slug: "fx-lab",
      kind: "play",
      name: "FX lab",
      guildId: "lab",
      organizerPlayerId: 1,
      mode: "normal",
      format: "1v1",
      masterRule: 5,
      status: finished ? "completed" : "active",
      settings: { ...defaultDuelSettings("normal"), visibility: spec.visibility ?? "public" },
      seats: [
        { seat: 0, playerId: 1, displayName: NAMES[0], ready: true, isBot: false },
        { seat: 1, playerId: spec.vsBot ? null : 2, displayName: namesOf(spec)[1], ready: true, isBot: spec.vsBot === true },
      ],
      createdAt: "",
      endedAt: null,
      archivedAt: null,
      winnerPlayerId: finished ? (winnerSeat === 0 ? 1 : spec.vsBot ? null : 2) : null,
      winnerSeat: finished ? winnerSeat : null,
      resultReason: finished ? "Life points reached 0" : null,
      bestOf: 3,
      seriesId: 7,
      gameNumber: spec.game,
    },
    role: spectator ? "spectator" : "player",
    mySeat: spectator ? null : 0,
    myDeck: null,
    clock: null,
    metadataOnly: false,
    engine: {
      revision: 99,
      turn: 5,
      turnSeat: 0,
      phase: "end",
      seats: board.seats,
      prompt: null,
      chain: [],
      events: [],
      log: [],
      result,
    },
    series: summary(spec),
    mySide: spectator ? null : { baseDeck: deck, currentDeck: deck },
  };
}

/** The room header as a duel shows it, so the label is seen where it ships (top right, by the Live pill). */
export function SeriesLabHeader({ room }: { room: DuelRoom }) {
  return (
    <header className={styles.header}>
      <div className={styles.identity}>
        <span>Dueling Domain</span>
        <span className={styles.format}>MR5 · 1v1</span>
      </div>
      <div className={styles.turn}>
        <strong>Turn 3</strong><span className={styles.phaseName}>Main Phase 1</span>
      </div>
      <div className={styles.status}>
        <SeriesGameLabel room={room} />
        <span className={styles.connectionStatus} data-live="true"><i className={styles.liveDot} aria-hidden />Live duel</span>
      </div>
    </header>
  );
}

/** The screen a scenario opens: the real Between games screen (ready, side) or the match result (won). */
export function SeriesLabScreen({ room, spec, reduced, sound }: { room: DuelRoom; spec: LabSeries; reduced: boolean; sound: boolean }) {
  const [closed, setClosed] = useState(false);
  if (spec.screen === "label" || !room.series) return null;
  if (spec.viewer !== "spectator" && (spec.screen === "ready" || spec.screen === "side")) {
    return (
      <BetweenGamesScreen room={room} slug="fx-lab" knownCards={KNOWN_CARDS} initialMarks={labMarks(spec)} autoSave={false}
        onChanged={() => undefined} onNavigate={() => undefined} />
    );
  }
  if (closed) return null;
  return (
    <DuelResultScreen room={room} slug="fx-lab" reducedMotion={reduced} soundEnabled={sound}
      onClose={() => setClosed(true)} onExit={() => setClosed(true)}
      onSeriesChanged={() => undefined} onNavigate={() => undefined} />
  );
}

/** The opening view a lab scenario stands for. You are seat 0; the deadline is set when the scenario plays. */
export function labOpeningView(spec: LabOpening, now = Date.now()): DuelRpsOpeningView {
  const base: DuelRpsOpeningView = {
    serverNow: now,
    phase: "rps", round: 1, deadlineAt: new Date(now + DUEL_OPENING_PICK_MS).toISOString(), picked: [false, spec.opponentChose === true],
    myPick: null, reveal: null, winnerSeat: null, choice: null, choiceByTimeout: false,
  };
  // The tie deadline carries its reveal plus the full next pick window, just like the server.
  const afterReveal = new Date(now + DUEL_OPENING_TIE_REVEAL_MS + DUEL_OPENING_PICK_MS).toISOString();
  switch (spec.stage) {
    case "pick": return base;
    case "pick-chosen": return { ...base, picked: [true, spec.opponentChose === true], myPick: "paper" };
    case "reveal-tie": return { ...base, round: 2, deadlineAt: afterReveal, reveal: { round: 1, picks: ["scissors", "scissors"], winnerSeat: null } };
    case "choose": return { ...base, phase: "choose", winnerSeat: 0, picked: [true, true], reveal: { round: 1, picks: ["paper", "rock"], winnerSeat: 0 } };
    case "wait-choose": return { ...base, phase: "choose", winnerSeat: 1, picked: [true, true], reveal: { round: 1, picks: ["rock", "paper"], winnerSeat: 1 } };
    case "start": return { ...base, phase: "start", winnerSeat: 0, choice: "first", picked: [true, true], reveal: { round: 1, picks: ["paper", "rock"], winnerSeat: 0 } };
  }
}

/** The real opening screen over the lab board. The reveal and the choice are on a fresh deadline each run. */
export function OpeningLabScreen({ spec }: { spec: LabOpening }) {
  // A tie opens with its reveal still to play; other stages open with their controls ready.
  const opening = useMemo(() => labOpeningView(spec), [spec]);
  const [error, setError] = useState<string | null>(null);
  const fail = () => setError("The lab has no server: this button calls the real API.");
  return <OpeningScreen opening={opening} mySeat={0} names={NAMES} error={error} onPick={fail} onChoose={fail} />;
}
