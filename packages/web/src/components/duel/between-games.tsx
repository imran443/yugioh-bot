"use client";

import { Children, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { DuelDeck, DuelRoom, DuelSeriesSummary } from "@yugidraft/shared/duels";
import { CardArt } from "@/components/decks/card-art";
import deckStyles from "@/components/decks/editor.module.css";
import { useDeckCardMeta } from "./deck-card-types";
import { cancelSeries, chooseSeriesFirst, readySeries, saveSeriesSideDeck, unreadySeries } from "./api";
import { DeckCardPreview } from "./deck-card-preview";
import { cx, sheetRoot, SheetButton } from "./sheet-ui";
import ui from "./sheet-ui.module.css";
import styles from "./between-games.module.css";
import { betweenGamesInfo, canCancelInterrupted, formatCountdown, seriesCompactScore, seriesKindLabel, seriesPlayerIndex, viewerChoosesFirst } from "./series-model";
import { FirstChoiceGroup, OpponentFirstChip, OpponentSideChip, useSecondsUntil } from "./series-next";
import {
  hasMarks,
  isExtraDeckType,
  isMarkedIn,
  isMarkedOut,
  NO_MARKS,
  planSideDeck,
  sameDeck,
  toggleIn,
  toggleOut,
  type SideMarks,
  type SwapSection,
} from "./side-deck-model";

export type CardMeta = { name: string; type: number };

const EMPTY_DECK: DuelDeck = { main: [], extra: [], side: [] };

type Tag = "out" | "in";

/** A focusable thumbnail that can carry an OUT or IN mark. */
function Tile({ code, name, label, tag, extra, locked, onClick, onHover, onSelect }: {
  code: number;
  name: string;
  label: string;
  tag?: Tag;
  /** A Side card that goes to the Extra Deck when it comes in. */
  extra?: boolean;
  locked: boolean;
  onClick: () => void;
  onHover: (code: number | null) => void;
  onSelect: (code: number) => void;
}) {
  return (
    <li>
      <button type="button" className={cx(deckStyles["de-c"], styles.tile)} data-tag={tag} data-locked={locked ? "true" : undefined}
        aria-pressed={tag != null} aria-disabled={locked || undefined} aria-label={label} title={name}
        onClick={() => { onSelect(code); if (!locked) onClick(); }}
        onPointerEnter={(event) => { if (event.pointerType !== "touch") onHover(code); }}
        onPointerLeave={() => onHover(null)}
        onFocus={() => onHover(code)}
        onBlur={() => onHover(null)}>
        <CardArt code={code} name={name} />
        {tag ? <span className={styles.tag} data-tag={tag}>{tag === "out" ? "Out" : "In"}</span> : null}
        {extra && !tag ? <span className={styles.exTag}>Extra</span> : null}
      </button>
    </li>
  );
}

function Section({ title, count, target, tone, hint, children, empty }: {
  title: string;
  count: number;
  target: string;
  tone?: "ok" | "bad";
  hint?: string;
  children: ReactNode;
  empty: string;
}) {
  return (
    <section className={styles.section} aria-label={`${title} Deck`} data-testid={`section-${title.toLowerCase()}`}>
      <header className={styles.sectionHead}>
        <h2 className={styles.sectionTitle}>
          {title}
          <span className={cx(ui.num, styles.sectionCount)} data-tone={tone} data-testid={`count-${title.toLowerCase()}`}>{count}</span>
          <span className={styles.sectionTarget}>{target}</span>
        </h2>
        {hint ? <p className={styles.sectionHint}>{hint}</p> : null}
      </header>
      {Children.toArray(children).length === 0 ? <p className={styles.empty}>{empty}</p> : <ul className={styles.cards}>{children}</ul>}
    </section>
  );
}

/**
 * The screen between two games of a Best of 3, for a player. It replaces the table lobby: a deck view
 * like the deck editor (Main, Extra and Side) where cards come out of the Main or Extra Deck and go
 * in from the Side Deck. The count out must equal the count in, so the Side Deck never changes size.
 * Complete swaps save the deck for the next game; only Ready marks the player ready.
 * Every deck edit takes Ready back immediately, before saving. Editing stays locked
 * while Ready is in flight, and Ready waits for un-ready so the requests cannot land out of order.
 * When both players are ready the room follows the series to the next game.
 */
export function BetweenGamesScreen({ room, slug, onChanged, onNavigate, knownCards, initialMarks, autoSave = true }: {
  room: DuelRoom;
  slug: string;
  onChanged: () => void | Promise<unknown>;
  onNavigate: (slug: string) => void;
  /** Card names and types known up front (the FX lab has no card database). */
  knownCards?: ReadonlyMap<number, CardMeta>;
  /** Marks to start with (the FX lab shows siding in progress). */
  initialMarks?: SideMarks;
  /** Disable background writes for previews that have no duel server. */
  autoSave?: boolean;
}) {
  const series = room.series as DuelSeriesSummary;
  const index = seriesPlayerIndex(room, series);
  const info = betweenGamesInfo(room, slug);
  const seconds = useSecondsUntil(series.nextGameAt);
  // The window is over and the server is making the next game. A server restart or a missed socket message can delay it.
  const startingNext = seconds === 0 && series.status === "between_games";
  const side = room.mySide ?? null;
  const serverDeck = side?.currentDeck ?? EMPTY_DECK;
  const serverDeckKey = JSON.stringify(serverDeck);
  const [current, setCurrent] = useState(serverDeck);
  // Unlike the sided series deck, the completed duel's own deck survives reloads unchanged.
  const [resetDeck] = useState(room.myDeck ?? serverDeck);
  const base = side?.baseDeck ?? serverDeck;

  const [marks, setMarks] = useState<SideMarks>(initialMarks ?? NO_MARKS);
  const [busy, setBusy] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const meta = useDeckCardMeta(current, { initial: knownCards });
  const [hovered, setHovered] = useState<number | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const serverReady = index != null && series.sideReady[index];
  const [seenReady, setSeenReady] = useState(serverReady);
  // Local request results bridge polling delays; every edit still asks the server to clear Ready.
  const [knownReady, setKnownReady] = useState<boolean | null>(null);
  const [unreadied, setUnreadied] = useState(false);
  // Set from the Not ready click until its request settles, so a double click cannot ready the player again.
  const [unreadyPending, setUnreadyPending] = useState(false);
  const unreadying = useRef<Promise<void> | null>(null);
  const unreadyFailed = useRef(false);
  const unreadyAgain = useRef(false);
  const notReadyClicked = useRef(false);
  const [notice, setNotice] = useState<string | null>(null);
  const working = useRef(false);
  const [moving, setMoving] = useState(false);
  const advancing = useRef(false);
  const imReady = knownReady ?? serverReady;

  const savedDeckKey = useRef(JSON.stringify(current));
  const ownSaveKeys = useRef(new Map<string, number>());
  const inFlightSaveKey = useRef<string | null>(null);
  const saveOrder = useRef(0);
  const generation = useRef(0);
  const [seenServerKey, setSeenServerKey] = useState(serverDeckKey);
  const saveQueue = useRef(Promise.resolve());
  if (seenServerKey !== serverDeckKey) {
    setSeenServerKey(serverDeckKey);
    savedDeckKey.current = serverDeckKey;
    // Own save echoes keep the user's marks. External edits become the new editor state.
    const echoedOrder = ownSaveKeys.current.get(serverDeckKey);
    if (echoedOrder == null) {
      generation.current += 1;
      for (const key of ownSaveKeys.current.keys()) {
        if (key !== inFlightSaveKey.current) ownSaveKeys.current.delete(key);
      }
      setCurrent(serverDeck);
      setMarks(NO_MARKS);
    } else {
      // Polling may skip earlier saves. Retire them so a later external rollback is recognized.
      for (const [key, order] of ownSaveKeys.current) {
        if (order <= echoedOrder) ownSaveKeys.current.delete(key);
      }
    }
  }
  if (serverReady !== seenReady) {
    setSeenReady(serverReady);
    setKnownReady(null);
    if (serverReady) setUnreadied(false);
  }
  const persistDeck = useCallback((deck: DuelDeck) => {
    const key = JSON.stringify(deck);
    const editingGeneration = generation.current;
    // Serialize saves so a slower request cannot overwrite a newer swap or Reset. Ready waits too.
    const pending = saveQueue.current.catch(() => undefined).then(async () => {
      // Every edit's trailing un-ready must settle before its valid deck is written.
      while (unreadying.current) await unreadying.current;
      if (advancing.current) return;
      if (editingGeneration !== generation.current || savedDeckKey.current === key) return;
      ownSaveKeys.current.set(key, ++saveOrder.current);
      inFlightSaveKey.current = key;
      try {
        const saved = await saveSeriesSideDeck(slug, deck);
        if (editingGeneration === generation.current && index != null && saved) {
          setKnownReady(saved.series.sideReady[index]);
          if (imReady && !saved.series.sideReady[index]) setUnreadied(true);
        }
      } catch (cause) {
        ownSaveKeys.current.delete(key);
        throw cause;
      } finally {
        inFlightSaveKey.current = null;
      }
      // An obsolete in-flight write can finish; the new generation's queued save restores its deck.
      savedDeckKey.current = key;
    });
    saveQueue.current = pending;
    return pending;
  }, [imReady, index, slug]);

  useEffect(() => {
    if (!startingNext || !autoSave) return;
    // Read the room as soon as the window ends instead of at the next poll, in case the socket missed the new game.
    void Promise.resolve().then(onChanged).catch(() => undefined);
  }, [startingNext, autoSave, onChanged]);

  const types = useMemo(() => new Map([...meta].map(([code, info]) => [code, info.type] as const)), [meta]);
  const plan = useMemo(() => planSideDeck(current, marks, types, base), [current, marks, types, base]);

  useEffect(() => {
    if (!autoSave || index == null || (imReady && !hasMarks(marks)) || plan.reason || series.status !== "between_games") return;
    // Save valid deck state throughout the window; never submit an incomplete swap or mark Ready.
    void persistDeck(plan.deck).catch((cause) => {
      setError(cause instanceof Error ? cause.message : "Your side changes could not be saved. Try Ready again.");
    });
  }, [autoSave, index, imReady, marks, series.status, serverDeckKey, plan, persistDeck]);

  if (index == null) return null;
  const theirReady = series.sideReady[index === 0 ? 1 : 0];
  const hasSide = current.side.length > 0;
  const locked = busy || moving || !hasSide;
  const choosing = viewerChoosesFirst(series, index);
  const interrupted = series.nextGameAt == null;
  const nameOf = (code: number) => meta.get(code)?.name ?? String(code);
  const changed = hasMarks(marks);
  const sideShown = plan.counts.side;
  // With nothing hovered or picked, the rail shows the first card instead of an empty box.
  const previewCode = hovered ?? selected ?? current.main[0] ?? current.extra[0] ?? current.side[0] ?? null;

  const flag = (code: number, section: string, tag?: Tag, extra?: boolean) =>
    `${nameOf(code)}, ${section} Deck${tag === "out" ? ", going out" : tag === "in" ? ", coming in" : ""}${extra ? ", goes to the Extra Deck" : ""}`;

  async function refresh() {
    try {
      const pending = onChanged();
      if (!pending) return;
      await pending;
      // The room now holds a snapshot newer than any of our requests: it is the truth, even when its Ready
      // equals the last one seen (another tab may have changed it and changed it back meanwhile).
      setKnownReady(null);
    } catch { /* The next edit still sends un-ready after a failed refresh. */ }
  }

  function follow(nextSlug: string) {
    advancing.current = true;
    setMoving(true);
    onNavigate(nextSlug);
  }

  /**
   * Outside previews, every edit sends the idempotent un-ready (one at a time): Ready may have been clicked in another tab
   * without this screen seeing it yet, and only the server knows.
   */
  function leaveReady() {
    const wasReady = imReady;
    const before = knownReady;
    // Show the change at once, also when a request is already in flight (a Ready from another tab can show up meanwhile).
    if (wasReady) {
      setKnownReady(false);
      setUnreadied(true);
    }
    if (unreadying.current) {
      // A Ready from another tab may land after the request in flight: send one more when it settles.
      unreadyAgain.current = true;
      return;
    }
    if (!autoSave) return;
    unreadying.current = unreadySeries(slug).then(
      (result) => {
        if (unreadyFailed.current) {
          unreadyFailed.current = false;
          setError(null);
        }
        if (result.nextSlug) {
          if (notReadyClicked.current) setNotice("The next game started before Not ready reached the server.");
          follow(result.nextSlug);
        } else void refresh();
      },
      (cause: unknown) => {
        if (wasReady) {
          setKnownReady(before);
          setUnreadied(false);
        }
        unreadyFailed.current = true;
        setError(cause instanceof Error ? cause.message : "Could not take back your Ready. Try again.");
        // The request may have landed (a 502 while the server restarts) or the series may be closed: show what the server holds.
        void refresh();
      },
    ).finally(() => {
      unreadying.current = null;
      notReadyClicked.current = false;
      if (unreadyAgain.current && !advancing.current) {
        unreadyAgain.current = false;
        leaveReady();
      }
    });
  }

  function edit(next: SideMarks) {
    if (working.current || advancing.current || !hasSide) return;
    leaveReady();
    setMarks(next);
  }

  function reset() {
    if (working.current || advancing.current || !hasSide) return;
    leaveReady();
    setCurrent(resetDeck);
    setMarks(NO_MARKS);
  }

  async function run(work: () => Promise<void>) {
    if (working.current || advancing.current) return;
    working.current = true;
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Something went wrong. Try again.");
      await refresh();
    } finally {
      working.current = false;
      setBusy(false);
    }
  }

  /** Takes Ready back with no edit, so the player can change the deck again before the timer ends. */
  function notReady() {
    if (busy || moving || advancing.current || !imReady) return;
    setError(null);
    setUnreadyPending(true);
    notReadyClicked.current = true;
    leaveReady();
    const pending = unreadying.current;
    if (pending) void pending.finally(() => setUnreadyPending(false));
    else setUnreadyPending(false);
  }

  const ready = () => run(async () => {
    if (plan.reason) return;
    const readyGeneration = generation.current;
    // Wait out every un-ready, a queued one included, so none can land after this Ready.
    while (unreadying.current) await unreadying.current;
    if (advancing.current) return;
    await persistDeck(plan.deck);
    if (advancing.current) return;
    if (readyGeneration !== generation.current) throw new Error("Your deck changed. Review it and click Ready again.");
    if (changed) {
      setCurrent(plan.deck);
      setMarks(NO_MARKS);
    }
    const result = await readySeries(slug);
    setKnownReady(result.series.sideReady[index]);
    setUnreadied(false);
    if (result.nextSlug) follow(result.nextSlug);
    else await refresh();
  });
  const choose = (choice: "first" | "second") => run(async () => {
    if (choice === series.firstChoice) return;
    while (unreadying.current) await unreadying.current;
    if (advancing.current) return;
    // The server allows choice changes while ready and does not clear Ready for them.
    const result = await chooseSeriesFirst(slug, choice);
    if (result.nextSlug) follow(result.nextSlug);
    else await refresh();
  });
  const cancel = () => run(async () => {
    await cancelSeries(series.id);
    setConfirmCancel(false);
    await refresh();
  });

  const readyReason = imReady && !changed ? null : plan.reason;
  const counterState = !changed ? "none" : !plan.typesReady ? "loading" : plan.balanced ? "even" : "uneven";
  const counterNote = !changed ? "No changes" : !plan.typesReady ? "Loading card types…"
    : plan.balanced ? "Even" : plan.out === plan.inn ? "Section sizes changed" : "Not even";
  const status = imReady && changed
    ? "Saving these swaps clears your Ready. Click Ready again when you are done."
    : imReady
    ? (theirReady ? "Both players are ready." : "You are ready. Waiting for your opponent. Click Not ready to change your deck.")
    : unreadied ? "You are no longer ready. Finish your swaps, then click Ready again."
    : interrupted ? "The last game did not finish. Both players must click Ready to play on."
      : !hasSide ? "Your deck has no Side Deck, so there is nothing to change. Click Ready."
        : "Complete swaps are saved automatically. Click Ready, or wait for the timer.";

  const mainCards = current.main.map((code, i) => {
    const tag: Tag | undefined = isMarkedOut(marks, "main", i) ? "out" : undefined;
    return (
      <Tile key={`main-${i}`} code={code} name={nameOf(code)} label={flag(code, "Main", tag)} tag={tag} locked={locked}
        onClick={() => edit(toggleOut(marks, "main", i))} onHover={setHovered} onSelect={setSelected} />
    );
  });
  const extraCards = current.extra.map((code, i) => {
    const tag: Tag | undefined = isMarkedOut(marks, "extra", i) ? "out" : undefined;
    return (
      <Tile key={`extra-${i}`} code={code} name={nameOf(code)} label={flag(code, "Extra", tag)} tag={tag} locked={locked}
        onClick={() => edit(toggleOut(marks, "extra", i))} onHover={setHovered} onSelect={setSelected} />
    );
  });
  // A Side card that is marked in shows in the section it will join, with an IN mark; click to take it back.
  const incoming = (section: SwapSection) => [...plan.destination]
    .filter(([, to]) => to === section)
    .map(([sideIndex]) => {
      const code = current.side[sideIndex];
      return (
        <Tile key={`in-${section}-${sideIndex}`} code={code} name={nameOf(code)} label={flag(code, section === "main" ? "Main" : "Extra", "in")}
          tag="in" locked={locked} onClick={() => edit(toggleIn(marks, sideIndex))} onHover={setHovered} onSelect={setSelected} />
      );
    });
  const sideCards = current.side.map((code, i) => {
    const tag: Tag | undefined = isMarkedIn(marks, i) ? "in" : undefined;
    const type = types.get(code);
    const extra = type != null && isExtraDeckType(type);
    return (
      <Tile key={`side-${i}`} code={code} name={nameOf(code)} label={flag(code, "Side", tag, extra)} tag={tag} extra={extra} locked={locked}
        onClick={() => edit(toggleIn(marks, i))} onHover={setHovered} onSelect={setSelected} />
    );
  });

  const mainOk = plan.counts.main === current.main.length;
  const extraOk = plan.counts.extra === current.extra.length;
  const sideOk = plan.counts.side === current.side.length;
  const kind = seriesKindLabel(series);

  return (
    <div className={cx(sheetRoot, styles.screen)} data-testid="between-games" role="region" aria-label="Between games">
      <header className={styles.head}>
        <div className={styles.headMain}>
          <p className={styles.eyebrow}>Between games</p>
          <h1 className={styles.title}>{info?.next ?? `Game ${series.gameNumber + 1} of ${series.bestOf}`}</h1>
          <p className={styles.result} data-testid="between-result">{info?.result}</p>
        </div>
        <div className={styles.chips}>
          <span className={styles.chip} data-tone="score" title={`${series.displayNames[0]} ${series.wins[0]} – ${series.wins[1]} ${series.displayNames[1]}`}>
            Score <b>{seriesCompactScore(series, index)}</b>
          </span>
          <span className={styles.chip}>{kind}</span>
          <span className={styles.chip} data-tone={seconds != null ? "gold" : undefined} role="timer" data-testid="between-timer">
            {startingNext ? `Starting game ${series.gameNumber + 1}…`
              : seconds != null ? <>Starts in <b>{formatCountdown(seconds)}</b></> : "Waiting for both players"}
          </span>
        </div>
      </header>

      <div className={styles.body}>
        <div className={styles.deck}>
          <Section title="Main" count={plan.counts.main} target={`keep ${current.main.length} cards`}
            tone={mainOk ? undefined : "bad"} empty="No Main Deck cards.">
            {[...mainCards, ...incoming("main")]}
          </Section>
          <Section title="Extra" count={plan.counts.extra} target={`keep ${current.extra.length} cards`}
            tone={extraOk ? undefined : "bad"} hint="Only Extra Deck monsters come into the Extra Deck." empty="No Extra Deck cards.">
            {[...extraCards, ...incoming("extra")]}
          </Section>
          <Section title="Side" count={sideShown} target={sideOk ? "stays the same" : `was ${current.side.length}`}
            tone={sideOk ? undefined : "bad"} empty="No Side Deck. You play the same deck again.">
            {sideCards}
          </Section>
        </div>

        <aside className={styles.panel} aria-label="Siding">
          <div className={styles.preview}><DeckCardPreview code={previewCode} compact /></div>

          <div className={styles.counter} data-state={counterState} role="status" aria-live="polite" data-testid="swap-counter">
            <span className={ui.num}>{plan.out} out · {plan.inn} in</span>
            <span className={styles.counterNote}>{counterNote}</span>
          </div>
          <p className={styles.help}>
            Take cards out, then bring in Side cards. Main and Extra must each keep their count.
          </p>

          <div className={styles.nextBlock}>
            {choosing ? <FirstChoiceGroup series={series} busy={busy || moving} onChoose={(choice) => void choose(choice)} />
              : info && !(series.firstChooser != null && series.firstChoice == null)
                ? <p className={styles.first} data-testid="between-first">{info.first}</p> : null}
            <OpponentFirstChip series={series} index={index} />
            <OpponentSideChip series={series} index={index} />
            {series.vsBot ? <p className={styles.botNote}>The practice bot is always ready.</p> : null}
          </div>

          <div className={styles.actions}>
            <p className={styles.reason} role="status" data-testid="my-side-status">
              {unreadied || (imReady && changed) ? status : imReady ? "You are ready." : "You are not ready."}
            </p>
            {hasSide || !interrupted ? (
              <p className={styles.help}>
                {[hasSide ? "Changing your deck after Ready takes it back." : null,
                  !interrupted ? "When the timer ends, the next game starts with your last saved deck." : null].filter(Boolean).join(" ")}
              </p>
            ) : null}
            <p className={styles.reason} id="between-reason" data-testid="ready-reason">
              {readyReason ?? (unreadied || (imReady && changed) ? null : status)}
            </p>
            <div className={styles.buttons}>
              {imReady && !changed ? (
                <SheetButton key="not-ready" kind="secondary" size="lg" disabled={busy || moving} aria-describedby="between-reason" onClick={notReady}>
                  Not ready
                </SheetButton>
              ) : (
                <SheetButton key="ready" kind="primary" size="lg" loading={busy && !confirmCancel} disabled={busy || moving || unreadyPending || readyReason != null}
                  aria-describedby="between-reason" onClick={() => void ready()}>
                  Ready
                </SheetButton>
              )}
              <SheetButton kind="secondary" disabled={locked || (!changed && sameDeck(current, resetDeck))} onClick={reset}>
                Reset to the deck from last game
              </SheetButton>
              {canCancelInterrupted(series) ? (
                confirmCancel ? (
                  <>
                    <SheetButton kind="secondary" loading={busy} disabled={busy} onClick={() => void cancel()}>Confirm cancel</SheetButton>
                    <SheetButton kind="quiet" disabled={busy} onClick={() => setConfirmCancel(false)}>Keep series</SheetButton>
                  </>
                ) : (
                  <SheetButton kind="quiet" disabled={busy} onClick={() => setConfirmCancel(true)}>Cancel series</SheetButton>
                )
              ) : null}
            </div>
            {notice ? <p className={styles.reason} role="status" data-testid="between-notice">{notice}</p> : null}
            {error ? <p className={styles.error} role="alert">{error}</p> : null}
          </div>
        </aside>
      </div>
    </div>
  );
}

/** True when this room is the next game of an open series that the server is about to start. */
export function isStartingNextGame(room: Pick<DuelRoom, "session" | "series">): boolean {
  const series = room.series;
  return series != null && (series.status === "active" || series.status === "between_games")
    && room.session.status === "lobby" && (room.session.gameNumber ?? 1) > 1;
}

/**
 * The moment between Ready and the first prompt of the next game. Both players are already seated and
 * ready, so the table lobby and its settings never show. If the server is slow, a link opens the table.
 * The finished game's room shows it too once the series points at the next game, so the result screen
 * of the game that is over never flashes before the route changes.
 */
export function NextGameStarting({ room, game: gameOverride, onShowTable }: {
  room: DuelRoom;
  /** The game that is starting, when this room is the finished game before it. */
  game?: number;
  onShowTable: () => void;
}) {
  const game = gameOverride ?? room.session.gameNumber ?? 2;
  const bestOf = room.series?.bestOf ?? 3;
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setSlow(true), 12_000);
    return () => window.clearTimeout(timer);
  }, []);
  return (
    <div className={cx(sheetRoot, styles.starting)} data-testid="next-game-starting" role="status">
      <h1 className={styles.startingTitle}>Game {game} of {bestOf}</h1>
      <p className={styles.startingNote}>Starting the next game…</p>
      {slow ? <SheetButton kind="quiet" onClick={onShowTable}>Open the table</SheetButton> : null}
    </div>
  );
}
