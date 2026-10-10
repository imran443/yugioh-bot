"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { ChevronLeft, ChevronRight, Pause, Play, PlayCircle, SkipBack, SkipForward } from "lucide-react";
import { isCustomDomain, seatCountFor, type DuelCard, type DuelMasterRule, type ReplayVisibility } from "@yugidraft/shared/duels";
import { Sheet } from "@/components/ui/sheet";
import { CardHoverInfo } from "./card-interactions";
import { phaseLabel } from "./constants";
import { DeckMasterRail, DuelField } from "./field";
import { CoinTossFx } from "./coin-toss-fx";
import { useHeldTossLogIds, withoutHeldTossLines } from "./coin-toss-lock";
import { DuelFeedback } from "./feedback";
import { MoveSourceBoundary } from "./fx-boundary";
import { CardInspector, cardScrollerProps, type InspectTarget } from "./inspector";
import { DuelLogLine, useLogCategories } from "./log-line";
import { useDuelPreferences } from "./preferences";
import {
  SPEEDS,
  createReadOnlyTableController,
  frameCaption,
  replayFailure,
  replayResultHeadline,
  replayRoom,
  resolveFocusSeat,
  useReplayController,
  useReplayData,
} from "./replay-controller";
import { ReplayTag } from "./replay-tag";
import { ReplayFfa, isFfaFormat } from "./replay-ffa";
import { buildReplayTimeline, type ReplayLogEntry } from "./replay-timeline";
import { formatLabel } from "./table-format";
import type { TableController } from "./table/types";
import styles from "./room.module.css";
import replayStyles from "./replay.module.css";
import { duelFontClasses } from "./fonts";

export { useReplayAutoplay } from "./replay-controller";

const PHASES = [
  { label: "DP", name: "Draw" },
  { label: "SP", name: "Standby" },
  { label: "M1", name: "Main 1" },
  { label: "BP", name: "Battle" },
  { label: "M2", name: "Main 2" },
  { label: "EP", name: "End" },
];
const noActions = () => [];
const noop = () => undefined;

/** The replay's Text log. Lines look like the live match sheet's (DuelLogLine); lines new at this step are lit. */
export function LogList({ entries: allEntries, freshIds, reducedMotion, playerName }: {
  entries: ReplayLogEntry[];
  freshIds: Set<number>;
  reducedMotion: boolean;
  playerName: (seat: number) => string;
}) {
  const endRef = useRef<HTMLLIElement>(null);
  // The replay's coin toss line also waits for the coin to land.
  const entries = withoutHeldTossLines(allEntries, useHeldTossLogIds());
  const categories = useLogCategories(entries);
  const count = entries.length;
  // Follow the newest entry id: the engine caps the log at 400 lines, so the length stops changing.
  const lastId = entries[count - 1]?.id;
  useEffect(() => {
    endRef.current?.scrollIntoView?.({ block: "nearest", behavior: reducedMotion ? "auto" : "smooth" });
  }, [lastId, count, reducedMotion]);
  return (
    <ol className={styles.log} aria-label="Duel log">
      {entries.map((entry, i) => (
        <DuelLogLine key={`${entry.id}-${i}`} ref={i === count - 1 ? endRef : undefined} text={entry.text} category={categories[i]}
          playerName={playerName} className={freshIds.has(entry.id) ? replayStyles.logNew : undefined} />
      ))}
    </ol>
  );
}

/**
 * The board of a replay frame. The two-seat field draws the camera seat at the bottom and one opposite seat on
 * top; the table layouts for Tag and free-for-all plug in here and read the same read-only `table` controller.
 */
function ReplayBoard({ table, masterRule, camera, focusSeat, mySeat, playerName }: {
  table: TableController;
  masterRule: DuelMasterRule;
  camera: number;
  focusSeat: number;
  mySeat: number | null;
  playerName: (seat: number) => string;
}) {
  // The cards a seat shows were fixed by the server; the camera only decides which seat is drawn at the bottom.
  const ownCamera = mySeat != null && camera === mySeat;
  return (
    <DuelField engine={table.engine} mySeat={ownCamera ? mySeat : null} bottomSeat={camera} topSeat={focusSeat}
      masterRule={masterRule} reducedMotion={table.reducedMotion}
      legalKeys={table.legalKeys} selectedKeys={table.selectedKeys} onActivate={table.onActivate}
      onHoverCard={table.onHoverCard} onInspect={table.onInspect}
      bottomName={playerName(camera)} topName={playerName(focusSeat)} />
  );
}

export function DuelReplayView({ slug }: { slug: string }) {
  const [visibility, setVisibility] = useState<ReplayVisibility>("mine");
  const [notice, setNotice] = useState<string | null>(null);
  const { model, settled, error } = useReplayData(slug, visibility);
  const preferences = useDuelPreferences();
  const [focusChoice, setFocusChoice] = useState<number | null>(null);
  const [inspect, setInspect] = useState<InspectTarget | null>(null);
  const [pane, setPane] = useState<"card" | "log">("card");
  const [mobileInspect, setMobileInspect] = useState(false);
  const [hover, setHover] = useState<{ card: DuelCard; anchor: HTMLElement } | null>(null);
  const boardRef = useRef<HTMLDivElement>(null);

  const frames = model?.frames ?? null;
  const seatCount = model ? seatCountFor(model.session.format) : 2;
  const controller = useReplayController({ slug, frames, seatCount, mySeat: model?.mySeat ?? null });
  const { index, last, playing, speed, epoch, camera } = controller;
  const timeline = useMemo(() => (frames ? buildReplayTimeline(frames) : null), [frames]);

  useEffect(() => {
    setVisibility("mine");
    setNotice(null);
    setFocusChoice(null);
    setInspect(null);
    setHover(null);
  }, [slug]);

  // A failed switch of card visibility keeps what is on screen and says why.
  useEffect(() => {
    if (!error || !model) return;
    setNotice(replayFailure(error, "Could not switch the card view.").message);
    setVisibility(model.visibility);
  }, [error, model]);

  const engine = useMemo(() => (timeline && timeline.length > 0 ? timeline.viewAt(index) : null), [timeline, index]);
  const freshIds = useMemo(
    () => new Set(timeline?.newLogAt(index).map((entry) => entry.id) ?? []),
    [timeline, index],
  );

  function changeVisibility(next: ReplayVisibility) {
    if (next === visibility) return;
    // The inspector, hover card and running effects belong to the old card view.
    setInspect(null);
    setHover(null);
    setMobileInspect(false);
    setNotice(null);
    controller.pause();
    controller.resetEffects();
    setVisibility(next);
  }

  const awaiting = model != null && !settled && model.visibility !== visibility;
  if ((!model || awaiting) && !error) return <div className="p-6 text-sm text-text-secondary" aria-busy="true">Loading replay…</div>;
  if (error && !model) {
    const failure = replayFailure(error);
    return (
      <div className={replayStyles.state}>
        <p role="alert" className="text-accent-cta">{failure.message}</p>
        <div className={replayStyles.stateLinks}>
          {failure.finalBoard ? <Link href={`/duels/${slug}`} className="text-sm text-text-secondary underline">Final board</Link> : null}
          <Link href="/duels?view=history" className="text-sm text-text-secondary underline">Match history</Link>
        </div>
      </div>
    );
  }
  if (!model || !timeline || !engine || timeline.length === 0) {
    return (
      <div className={replayStyles.state}>
        <p role="alert" className="text-accent-cta">{model ? "This replay has no recorded moves." : "Could not load this replay."}</p>
        <div className={replayStyles.stateLinks}>
          <Link href={`/duels/${slug}`} className="text-sm text-text-secondary underline">Final board</Link>
          <Link href="/duels?view=history" className="text-sm text-text-secondary underline">Match history</Link>
        </div>
      </div>
    );
  }

  const session = model.session;
  // Tag draws the Rooftop table (four seats, team LP, shared Extra Monster zones) in its own page.
  if (session.format === "tag") {
    return <ReplayTag slug={slug} model={model} timeline={timeline} engine={engine} controller={controller}
      visibility={visibility} onVisibilityChange={changeVisibility} notice={notice} />;
  }
  const frame = timeline.frame(index);
  const domain = session.mode === "domain";
  const focusSeat = resolveFocusSeat(session, camera, focusChoice);
  const playerName = (seat: number) =>
    session.seats.find((player) => player.seat === seat)?.displayName ?? `Player ${seat + 1}`;
  const modeText = domain
    ? isCustomDomain(session.masterRule, session.settings) ? "Custom Domain" : "Domain"
    : `MR${session.masterRule}`;
  const atEnd = index >= last;
  const result = atEnd ? (engine.result ?? (session.resultReason ? { winnerSeat: session.winnerSeat, reason: session.resultReason } : null)) : null;
  const newLines = timeline.newLogAt(index);
  const actor = frameCaption(frame, index, atEnd, playerName);
  const resultHeadline = replayResultHeadline(session, result, playerName);
  const multiSeat = seatCount > 2;
  const canSwitchCards = model.version === 2 && model.mySeat != null;

  // 3-way and 4-way free-for-all tables draw every field in the shared table shell (replay mode).
  if (isFfaFormat(session.format)) {
    return (
      <ReplayFfa slug={slug} model={model} frames={model.frames} engine={engine} controller={controller} preferences={preferences}
        visibility={visibility} canSwitchCards={canSwitchCards} onVisibility={changeVisibility} notice={notice}
        newLines={newLines} onCamera={() => { setInspect(null); setHover(null); setFocusChoice(null); }} />
    );
  }

  function showInspector(target: InspectTarget, mobile = false) {
    setInspect(target);
    setPane("card");
    if (mobile && window.matchMedia("(max-width: 900px)").matches) setMobileInspect(true);
  }
  function onHoverCard(card: DuelCard | null, anchor: HTMLElement | null) {
    if (!card || !anchor || card.code == null) {
      setHover(null);
      return;
    }
    setHover({ card, anchor });
    if (pane === "card") setInspect({ type: "card", card });
  }
  function onActivate(_keys: string[], card: DuelCard | null) {
    setHover(null);
    if (card) showInspector({ type: "card", card }, true);
  }

  // The shells and the field only ever see this controller: it has no prompt and its answer callback does nothing.
  const table = createReadOnlyTableController({
    room: replayRoom(model, engine),
    engine,
    camera,
    nameOf: playerName,
    reducedMotion: preferences.reducedMotion,
    onActivate,
    onInspect: (target) => showInspector(target, true),
    onHoverCard,
  });

  const inspector = (
    <CardInspector target={inspect} onInspectCard={(card) => setInspect({ type: "card", card })} />
  );
  const sideContent = pane === "card" ? inspector : (
    <LogList entries={engine.log} freshIds={freshIds} reducedMotion={preferences.reducedMotion} playerName={playerName} />
  );
  const tabs = (mobile: boolean) => (
    <div className={`${styles.tabs} ${replayStyles.tabs}`} role="group" aria-label={mobile ? "Mobile replay panels" : "Replay panels"}>
      {(["card", "log"] as const).map((tab) => (
        <button key={tab} type="button" aria-pressed={pane === tab} aria-haspopup={mobile ? "dialog" : undefined}
          onClick={() => { setPane(tab); if (mobile) setMobileInspect(true); }}>
          {tab[0].toUpperCase() + tab.slice(1)}
        </button>
      ))}
    </div>
  );
  const seats = Array.from({ length: seatCount }, (_, seat) => seat);

  return (
    <div className={`${styles.shell} ${duelFontClasses} -mx-4 -my-4 sm:-mx-6 sm:-my-6 lg:-mx-8 lg:-my-8`} data-domain={domain}
      data-replay-frame={controller.frameId ?? undefined} data-replay-visibility={model.visibility}>
      <header className={styles.header}>
        <div className={styles.identity}>
          <Link href="/duels?view=history">Match history</Link>
          <strong className={replayStyles.badge}><PlayCircle size={14} aria-hidden /> Replay</strong>
          <span>{modeText} · {formatLabel(session.format)}</span>
        </div>
        <div className={styles.turn}>
          <strong>Turn {engine.turn}</strong><span>{phaseLabel(engine.phase)}</span>
        </div>
        <div className={styles.status}>
          <span className={styles.pref}>{session.name}</span>
        </div>
      </header>
      <div className={styles.layout}>
        <aside className={styles.inspector}>
          <span className={styles.chamfer} aria-hidden="true" />
          {tabs(false)}
          <div className={styles.sideContent} role="region" aria-label={pane === "card" ? "Card" : "Duel log"} {...cardScrollerProps(pane === "card")}>{sideContent}</div>
        </aside>
        <section className={styles.boardColumn} aria-label="Replay field">
          <div className={styles.board} ref={boardRef}>
            <MoveSourceBoundary events={engine.events} duelKey={`${slug}:replay:${epoch}`} root={boardRef}>
            <ReplayBoard key={`${slug}:${camera}:${focusSeat}`} table={table} masterRule={session.masterRule}
              camera={camera} focusSeat={focusSeat} mySeat={model.mySeat} playerName={playerName} />
            <DuelFeedback events={engine.events} duelKey={`${slug}:replay:${epoch}`} attackToast
              soundEnabled={preferences.soundEnabled} soundVolume={preferences.soundVolume} reducedMotion={preferences.reducedMotion} />
            {/* The replay plays the coin too, passive: nothing is locked and the cover takes no pointer. */}
            <CoinTossFx events={engine.events} duelKey={`${slug}:replay:${epoch}`} reducedMotion={preferences.reducedMotion} passive />
            </MoveSourceBoundary>
          </div>
          <nav className={styles.phases} aria-label="Duel phases">
            {PHASES.map((phase) => (
              <button key={phase.label} type="button" disabled aria-label={phase.name}
                aria-current={phaseLabel(engine.phase) === phase.name ? "step" : undefined}>
                {phase.label}
              </button>
            ))}
          </nav>
          {engine.chain.length ? (
            <section className={styles.chain} aria-label="Current chain">
              <strong>Chain · resolves highest link first</strong>
              <ol>{engine.chain.map((link) => (
                <li key={link.index}><b>{link.index}</b><span>{link.name ?? "Effect"}<small>{playerName(link.seat)}{link.description ? ` · ${link.description}` : ""}</small></span></li>
              ))}</ol>
            </section>
          ) : null}
          <div className={styles.promptDock} data-idle="true">
            <div className={replayStyles.controls}>
              {result ? (
                <div className={replayStyles.result} role="status">
                  <strong>{resultHeadline}</strong>
                  <span>{result.reason}</span>
                </div>
              ) : null}
              <div className={replayStyles.caption} aria-live="off">
                <span className={replayStyles.actor}>{actor}</span>
                <ul className={replayStyles.captionLines}>
                  {newLines.slice(-4).map((entry, i) => <li key={`${entry.id}-${i}`}>{entry.text}</li>)}
                </ul>
              </div>
              <div className={replayStyles.transport}>
                <div className={replayStyles.buttons} role="group" aria-label="Replay controls">
                  <button type="button" className={replayStyles.iconButton} aria-label="First move"
                    disabled={index === 0} onClick={() => controller.seek(0)}><SkipBack size={18} aria-hidden /></button>
                  <button type="button" className={replayStyles.iconButton} aria-label="Previous move"
                    disabled={index === 0} onClick={controller.stepBack}><ChevronLeft size={20} aria-hidden /></button>
                  <button type="button" className={`${replayStyles.iconButton} ${replayStyles.play}`}
                    aria-label={playing ? "Pause" : "Play"} onClick={controller.togglePlay}>
                    {playing ? <Pause size={20} aria-hidden /> : <Play size={20} aria-hidden />}
                  </button>
                  <button type="button" className={replayStyles.iconButton} aria-label="Next move"
                    disabled={atEnd} onClick={controller.stepForward}><ChevronRight size={20} aria-hidden /></button>
                  <button type="button" className={replayStyles.iconButton} aria-label="Last move"
                    disabled={atEnd} onClick={() => controller.seek(last)}><SkipForward size={18} aria-hidden /></button>
                </div>
                <input type="range" className={replayStyles.slider} aria-label="Replay position"
                  min={0} max={last} step={1} value={index}
                  aria-valuetext={`Move ${index} of ${last}`}
                  onChange={(event) => controller.seek(Number(event.target.value))} />
                <div className={replayStyles.meta}>
                  <span>Move {index} / {last}</span>
                  <label className="flex items-center gap-2">
                    <span className="sr-only">Playback speed</span>
                    <select className={replayStyles.select} value={speed} aria-label="Playback speed"
                      onChange={(event) => controller.setSpeed(Number(event.target.value))}>
                      {SPEEDS.map((value) => <option key={value} value={value}>{value}×</option>)}
                    </select>
                  </label>
                </div>
              </div>
              <div className={replayStyles.viewBar} role="group" aria-label="Replay view">
                <label className={replayStyles.viewField}>
                  <span>View from</span>
                  <select className={replayStyles.select} value={camera} aria-label="View from seat"
                    onChange={(event) => {
                      setInspect(null);
                      setHover(null);
                      setFocusChoice(null);
                      controller.setCamera(Number(event.target.value));
                    }}>
                    {seats.map((seat) => <option key={seat} value={seat}>{playerName(seat)}</option>)}
                  </select>
                </label>
                {multiSeat ? (
                  <label className={replayStyles.viewField}>
                    <span>Across from</span>
                    <select className={replayStyles.select} value={focusSeat} aria-label="Opposite seat"
                      onChange={(event) => { setInspect(null); setHover(null); setFocusChoice(Number(event.target.value)); controller.resetEffects(); }}>
                      {seats.filter((seat) => seat !== camera).map((seat) => <option key={seat} value={seat}>{playerName(seat)}</option>)}
                    </select>
                  </label>
                ) : null}
                {canSwitchCards ? (
                  <div className={replayStyles.segmented} role="group" aria-label="Card visibility">
                    {(["mine", "public"] as const).map((value) => (
                      <button key={value} type="button" aria-pressed={visibility === value}
                        onClick={() => changeVisibility(value)}>
                        {value === "mine" ? "My cards" : "Public"}
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
              {notice ? <p role="alert" className={replayStyles.note}>{notice}</p> : null}
              {model.mySeat == null || model.visibility === "public"
                ? <p className={replayStyles.note}>Public view — hidden cards stay hidden</p> : null}
              {multiSeat ? <p className={replayStyles.note}>Two seats are drawn at a time. Pick them with the view controls.</p> : null}
              <p className={replayStyles.note}>
                <Link href={`/duels/${slug}`} className={replayStyles.link}>Final board</Link>
              </p>
            </div>
          </div>
        </section>
        {domain ? <aside className={styles.masters} aria-label="Deck Masters">
          <DeckMasterRail engine={engine} mySeat={model.mySeat} bottomSeat={camera} topSeat={focusSeat} legalKeys={table.legalKeys}
            selectedKeys={table.selectedKeys} canAct={false} legalActionsFor={noActions}
            onActivate={onActivate} onChooseAction={noop}
            onHoverCard={onHoverCard} onInspect={(target) => showInspector(target, true)} />
        </aside> : null}
      </div>
      <div className={styles.mobileBar}>{tabs(true)}</div>
      {hover && !mobileInspect ? <CardHoverInfo card={hover.card} anchor={hover.anchor} /> : null}
      <Sheet open={mobileInspect} onClose={() => setMobileInspect(false)} title={pane === "card" ? "Card" : "Duel log"}>
        {sideContent}
      </Sheet>
    </div>
  );
}
