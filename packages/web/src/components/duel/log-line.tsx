// One line of the Text log, shared by the live room's match sheet and the replay, so both colour and label
// lines the same way. The line sits inside an <ol className={styles.log}> from room.module.css.
// The 1v1 room and the table shell share the match sheet (text-log re-exports it).
"use client";

import { Fragment, useEffect, useMemo, useRef, type CSSProperties, type ReactNode, type Ref } from "react";
import { phaseTitle } from "./constants";
import { categoriesForLog, categoryForLogText, summonMethodForLogText, type LogCategory } from "./log-category";
import { LogCategoryGlyph } from "./log-category-glyph";
import { useHeldTossLogIds, withoutHeldTossLines } from "./coin-toss-lock";
import baseStyles from "./room.module.css";
import { useSkinStyles } from "./skin";

const LOG_PHASE_KEYS: ReadonlySet<string> = new Set([
  "draw", "standby", "main1", "battle_start", "battle_step", "damage", "damage_cal", "battle", "main2", "end",
]);

export type LogKind = "turn" | "phase" | "loss" | "gain" | "chain" | "result" | "line";

export function logKind(text: string): LogKind {
  if (/^Turn \d+/.test(text)) return "turn";
  if (LOG_PHASE_KEYS.has(text)) return "phase";
  if (/ wins \(|^Draw \(/.test(text)) return "result";
  if (/ takes \d+ damage| pays \d+ LP/.test(text)) return "loss";
  if (/ gains \d+ LP/.test(text)) return "gain";
  if (/ is activating$|^(A|Player \d+'s) chain link was negated$|^Chain ended$|^Chain Link \d+: .+ targets |^Only legal target: /.test(text)) return "chain";
  return "line";
}

/** The engine log names seats "Player N"; show the table's display names instead (a table has up to four seats), and phase keys as titles. */
export function logText(text: string, kind: LogKind, playerName: (seat: number) => string): string {
  if (kind === "phase") return phaseTitle(text);
  return text.replace(/\bPlayer ([1-4])\b/g, (_match, seat: string) => playerName(Number(seat) - 1));
}

/** The colour of each seat at a table (`main`), by seat. The 1v1 room has none: its lines stay plain. */
export type LogSeatTones = ReadonlyMap<number, { main: string; ink: string }>;

/**
 * The line as nodes: each "Player N" becomes the seat's display name with the seat's colour and a dot, so a table of 3 or 4
 * (or two teams) shows who did what. Without tones, or for a phase line, it is the plain text of `logText`.
 */
function logNodes(text: string, kind: LogKind, playerName: (seat: number) => string, tones: LogSeatTones | undefined, seatClass: string): ReactNode {
  if (!tones || kind === "phase") return logText(text, kind, playerName);
  const parts: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(/\bPlayer ([1-4])\b/g)) {
    const seat = Number(match[1]) - 1;
    const tone = tones.get(seat);
    parts.push(text.slice(last, match.index));
    parts.push(tone
      ? <b key={match.index} className={seatClass} data-seat={seat} style={{ "--seat-main": tone.main } as CSSProperties}>{playerName(seat)}</b>
      : playerName(seat));
    last = match.index + match[0].length;
  }
  parts.push(text.slice(last));
  return parts.map((part, index) => <Fragment key={index}>{part}</Fragment>);
}

/** The categories of a whole log (see categoriesForLog), recomputed only when the entries change. */
export function useLogCategories(entries: ReadonlyArray<{ text: string }>): Array<LogCategory | null> {
  return useMemo(() => categoriesForLog(entries.map((entry) => entry.text)), [entries]);
}

export function DuelLogLine({
  text,
  category: given,
  playerName,
  seatTones,
  className,
  ref,
}: {
  /** The raw engine line, before display names are filled in. */
  text: string;
  /** The line's category in context (useLogCategories); without it the line is classified on its own. */
  category?: LogCategory | null;
  playerName: (seat: number) => string;
  /** A table's seat colours: the player names of the line wear them. */
  seatTones?: LogSeatTones;
  className?: string;
  ref?: Ref<HTMLLIElement>;
}) {
  const styles = useSkinStyles(baseStyles, "history");
  const kind = logKind(text);
  // Classify the raw line: a display name can never pass for one of the engine's sentence templates.
  const category = given === undefined ? categoryForLogText(text) : given;
  const summon = summonMethodForLogText(text);
  return (
    <li ref={ref} className={className} data-kind={kind} data-cat={category ?? undefined} data-summon={summon ?? undefined}>
      {category ? <LogCategoryGlyph category={category} className={styles.logGlyph} /> : null}
      {logNodes(text, kind, playerName, seatTones, styles.logSeat)}
    </li>
  );
}

/** The live room's Text log (the match sheet). It follows the newest line. */
export function MatchSheetLog({
  entries: allEntries,
  playerName,
  players,
  seatTones,
}: {
  entries: ReadonlyArray<{ id: number; text: string; eventId?: number }>;
  playerName: (seat: number) => string;
  players: string;
  /** A table's seat colours (see DuelLogLine). The 1v1 room passes none. */
  seatTones?: LogSeatTones;
}) {
  const styles = useSkinStyles(baseStyles, "history");
  const listRef = useRef<HTMLOListElement>(null);
  // A coin toss line stays out until its result has landed (coin-toss-fx).
  const entries = withoutHeldTossLines(allEntries, useHeldTossLogIds());
  const categories = useLogCategories(entries);
  const count = entries.length;
  // Follow the newest entry id: the engine caps the log at 400 lines, so the length stops changing.
  const lastId = entries[count - 1]?.id;
  useEffect(() => {
    // Scroll only the sheet's own list; scrollIntoView would also scroll the side pane
    // and push the history rail above it out of view.
    const list = listRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [lastId, count]);
  return (
    <div className={styles.sheet}>
      <div className={styles.sheetHead}>
        <h2>Match sheet</h2>
        <span>{players}</span>
      </div>
      <ol ref={listRef} className={styles.log} aria-label="Duel log">
        {entries.map((entry, i) => (
          <DuelLogLine key={entry.id} text={entry.text} category={categories[i]} playerName={playerName} seatTones={seatTones} />
        ))}
      </ol>
    </div>
  );
}
