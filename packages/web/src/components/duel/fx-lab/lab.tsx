"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DuelCard, DuelChainLink, DuelEngineView, DuelEvent, DuelRoom } from "@yugidraft/shared/duels";
import { DeckMasterRail, DuelField } from "../field";
import { DuelAnimationSpeedControl, useDuelAnimationSpeed } from "../animation-speed-control";
import { BattleFx } from "../battle-fx";
import { DestroyFx } from "../destroy-fx";
import { DuelFeedback } from "../feedback";
import { SummonFx } from "../summon-fx";
import { MoveFx } from "../move-fx";
import { PositionFx } from "../position-fx";
import { ChainFx } from "../chain-fx";
import { MasterReturnFx } from "../master-return-fx";
import { PromptCenter } from "../prompt-center";
import { activatePromptFromField, promptSelectedKeys, type PromptDraft } from "../prompts";
import { PickRefusalHint, shakeRefusedCard } from "../card-interactions";
import { DuelResultScreen } from "../duel-result";
import { DeckSurrenderContext, type DeckSurrenderValue } from "../deck-surrender";
import { SurrenderModal } from "../surrender-modal";
import { FxBoundary, MoveSourceBoundary } from "../fx-boundary";
import { duelFontClasses } from "../fonts";
import { isBattlePhase } from "../constants";
import { getSharedFx3d } from "../fx3d/shared";
import styles from "../room.module.css";
import fx from "./fx-lab.module.css";
import { applyEdits, numberSteps, scriptDurationMs, withHandIds, type LabBoard, type LabScenario, type LabScript } from "./board";
import { LAB_CATEGORIES, LAB_SCENARIOS, findScenario, scenariosIn } from "./scenarios";
import { installTimeShim, type TimeShim } from "./time-shim";
import { DiceLabScreen } from "./dice-view";
import { labSeriesRoom, OpeningLabScreen, SeriesLabHeader, SeriesLabScreen } from "./series-view";
import { withDestroyCards } from "../destroy-cards";

/**
 * The FX lab: the real duel board and effect layers, fed by a scripted engine instead of a server.
 * Every effect on screen is the component that ships; only the engine view is made up here.
 * Speed (1x, 0.5x, 0.25x) comes from time-shim.ts. Open it at /dev/fx-lab.
 */

const SPEEDS = [1, 0.5, 0.25] as const;
type Speed = (typeof SPEEDS)[number];
type Status = "idle" | "preparing" | "playing" | "done";

/** Lead-in after the remount, before the first step: the board and the layers settle first (real time). */
const MOUNT_MS = 350;
/** The wait for the 3D canvas, so the first run is not drawn with the flat fallback (real time). */
const CANVAS_WAIT_MS = 8000;

type Live = {
  runKey: number;
  board: LabBoard;
  chain: DuelChainLink[];
  events: DuelEvent[];
  revision: number;
  /** The layers opened on a finished first step (a room's first load): they replay its events from the start. */
  preloaded?: boolean;
};

const noop = () => undefined;
const NO_KEYS: ReadonlySet<string> = new Set();
/** The lab never answers: the prompt draft holds nothing and sends nothing. */
function labDraft(selected: string[]): PromptDraft {
  return {
    selected, setSelected: noop, counts: {}, setCounts: noop, value: 0, setValue: noop,
    cardCode: null, setCardCode: noop, highlight: 0, setHighlight: noop,
  };
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`;
}

function engineOf(live: Live): DuelEngineView {
  return {
    revision: live.revision,
    turn: 3,
    turnSeat: live.board.turnSeat,
    prioritySeat: live.board.prioritySeat,
    phase: live.board.phase,
    battleStep: null,
    seats: live.board.seats,
    prompt: null,
    chain: live.chain,
    events: live.events,
    log: [],
    result: null,
  };
}

function resultRoom(board: LabBoard, result: { winnerSeat: number | null; reason: string }): DuelRoom {
  return {
    session: {
      id: 1,
      slug: "fx-lab",
      kind: "play",
      name: "FX lab",
      guildId: "lab",
      organizerPlayerId: 1,
      mode: board.seats.some((seat) => seat.deckMaster) ? "domain" : "normal",
      masterRule: 5,
      format: "1v1",
      status: "completed",
      settings: {} as DuelRoom["session"]["settings"],
      seats: [
        { seat: 0, playerId: 1, displayName: "You", ready: true, isBot: false },
        { seat: 1, playerId: 2, displayName: "Practice Bot", ready: true, isBot: true },
      ],
      createdAt: "",
      endedAt: null,
      archivedAt: null,
      winnerPlayerId: null,
      winnerSeat: result.winnerSeat,
      resultReason: result.reason,
    },
    role: "player",
    mySeat: 0,
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
  };
}

export function FxLab() {
  const [selectedId, setSelectedId] = useState<string>(LAB_SCENARIOS[0].id);
  const [speed, setSpeed] = useState<Speed>(1);
  const [reduced, setReduced] = useState(false);
  const animationSpeed = useDuelAnimationSpeed(reduced);
  const playbackSpeed = reduced ? 1 : speed * animationSpeed;
  const [loop, setLoop] = useState(false);
  const [sound, setSound] = useState(false);
  const [status, setStatus] = useState<Status>("idle");
  const [note, setNote] = useState("");
  const [result, setResult] = useState<{ winnerSeat: number | null; reason: string } | null>(null);
  const [confirmSurrender, setConfirmSurrender] = useState(false);
  const [live, setLive] = useState<Live>(() => ({
    runKey: 0,
    board: findScenario(LAB_SCENARIOS[0].id)!.build().initial,
    chain: [],
    events: [],
    revision: 1,
  }));

  const shimRef = useRef<TimeShim | null>(null);
  const timers = useRef<number[]>([]);
  const token = useRef(0);
  const nextId = useRef(0);
  const boardRef = useRef<LabBoard>(live.board);
  const stageRef = useRef<HTMLDivElement>(null);
  const optionsRef = useRef({ speed: playbackSpeed, reduced, loop });
  optionsRef.current = { speed: playbackSpeed, reduced, loop };

  const scenario = findScenario(selectedId) ?? LAB_SCENARIOS[0];
  const script = useMemo<LabScript>(() => scenario.build(), [scenario]);
  const expectedMs = useMemo(() => scriptDurationMs(script), [script]);
  const legalKeys = useMemo(() => new Set(script.legalKeys ?? []), [script]);
  // An interactive pick scenario: clicks toggle the pick here, with the same rules and feedback as a duel.
  const interactive = script.prompt?.interactive === true;
  const [picked, setPicked] = useState<string[]>([]);
  const [pickHint, setPickHint] = useState<{ anchor: HTMLElement; text: string } | null>(null);
  const clearPickHint = useCallback(() => setPickHint(null), []);
  useEffect(() => {
    setPicked(script.prompt?.selected ?? []);
    setPickHint(null);
  }, [script, live.runKey]);
  const pickedIds = interactive ? picked : (script.prompt?.selected ?? []);
  const pickedKeys = useMemo(
    () => (interactive && script.prompt ? promptSelectedKeys(script.prompt.prompt, picked) : NO_KEYS),
    [interactive, script, picked],
  );
  const onActivate = (keys: string[], card: DuelCard | null, anchor: HTMLElement) => {
    if (!interactive || !script.prompt) return;
    const draft: PromptDraft = { ...labDraft(picked), setSelected: setPicked };
    activatePromptFromField(script.prompt.prompt, true, keys, card, draft, undefined, (refusal) => {
      shakeRefusedCard(anchor, reduced);
      setPickHint({ anchor, text: refusal.text });
    });
  };

  useEffect(() => {
    shimRef.current = installTimeShim();
    return () => {
      shimRef.current?.uninstall();
      shimRef.current = null;
    };
  }, []);

  const clearTimers = useCallback(() => {
    const shim = shimRef.current;
    for (const id of timers.current) (shim ? shim.realClearTimeout(id) : window.clearTimeout(id));
    timers.current = [];
  }, []);
  useEffect(() => clearTimers, [clearTimers]);

  const later = useCallback((ms: number, fn: () => void) => {
    const shim = shimRef.current;
    const id = shim ? shim.realSetTimeout(fn, ms) : window.setTimeout(fn, ms);
    timers.current.push(id);
  }, []);

  const play = useCallback(
    (target: LabScenario) => {
      const shim = shimRef.current;
      if (!shim) return;
      const run = ++token.current;
      clearTimers();
      shim.setFactor(1);
      setResult(null);
      setConfirmSurrender(false);
      setStatus("preparing");
      setNote("");

      const built = target.build();
      const base = nextId.current + 1000;
      const numbered = numberSteps(built.steps, base);
      nextId.current = base + numbered.reduce((sum, entry) => sum + entry.events.length, 0) + 10;
      boardRef.current = built.initial;
      // Fresh layers: a new key remounts the field and every effect with an empty event list.
      setLive((prev) => ({ runKey: prev.runKey + 1, board: built.initial, chain: built.initial.chain, events: [], revision: prev.revision + 1 }));

      const { speed: rate, reduced: reducedNow } = optionsRef.current;
      const started = () => run === token.current;

      const begin = () => {
        if (!started()) return;
        shim.setFactor(rate);
        shim.resetTimeline();
        setStatus("playing");
        let steps = numbered;
        if (built.preload && numbered.length > 0) {
          // A room's first load: the finished board and its events are there when the layers mount.
          const [first, ...rest] = numbered;
          const dealt = withHandIds(applyEdits(built.initial, first.step.edits ?? []), first.events, built.mySeat === undefined ? 0 : built.mySeat);
          boardRef.current = dealt.board;
          steps = rest;
          setLive((prev) => ({ runKey: prev.runKey + 1, board: dealt.board, chain: first.step.chain ?? prev.chain, events: dealt.events, revision: prev.revision + 1, preloaded: true }));
        }
        if (built.deckMenu) {
          // The deck menu scenes press the real controls: the deck, then (for the confirm) Surrender.
          later(500, () => {
            if (started()) stageRef.current?.querySelector<HTMLElement>('[data-field-seat][data-side="bottom"] [data-kind="deck"] button')?.click();
          });
          if (built.deckMenu === "confirm") {
            later(1400, () => {
              if (started()) document.querySelector<HTMLElement>('[role="menuitem"][aria-label="Surrender"]')?.click();
            });
          }
        }
        for (const { step, events } of steps) {
          later(step.at / rate, () => {
            if (!started()) return;
            const nextBoard = applyEdits(boardRef.current, step.edits ?? []);
            boardRef.current = nextBoard;
            setLive((prev) => ({
              runKey: prev.runKey,
              board: nextBoard,
              chain: step.chain ?? prev.chain,
              events: [...prev.events, ...events],
              revision: prev.revision + 1,
              preloaded: prev.preloaded,
            }));
            if (step.result) setResult(step.result);
          });
        }
        later(scriptDurationMs(built) / rate, () => {
          if (!started()) return;
          setStatus("done");
          if (optionsRef.current.loop) later(900, () => started() && play(target));
        });
      };

      // Wait for the mount and, with motion on, for the 3D canvas (the first run loads it).
      const waitStart = Date.now();
      const poll = () => {
        if (!started()) return;
        if (reducedNow || getSharedFx3d() || Date.now() - waitStart > CANVAS_WAIT_MS) {
          setNote(!reducedNow && !getSharedFx3d() ? "The 3D canvas did not load; the flat fallback effects play." : "");
          begin();
          return;
        }
        setNote("Loading the 3D effects...");
        later(120, poll);
      };
      later(MOUNT_MS, poll);
    },
    [clearTimers, later],
  );

  const choose = useCallback(
    (id: string) => {
      setSelectedId(id);
      try {
        window.history.replaceState(null, "", `#${id}`);
      } catch {
        // a locked history is not a problem
      }
      const next = findScenario(id);
      if (next) play(next);
    },
    [play],
  );

  // A link with #scenario-id opens that scenario (it waits for the first click to play, like any page with sound).
  useEffect(() => {
    const id = window.location.hash.replace(/^#/, "");
    const found = id ? findScenario(id) : undefined;
    if (found) {
      setSelectedId(found.id);
      const initial = found.build().initial;
      setLive((prev) => ({ ...prev, runKey: prev.runKey + 1, board: initial, chain: initial.chain }));
    }
  }, []);

  // A change of speed applies on the next Play; a change of motion or sound remounts the layers at once.
  const toggleReduced = (value: boolean) => {
    setReduced(value);
    clearTimers();
    token.current += 1;
    shimRef.current?.setFactor(1);
    setStatus("idle");
    setResult(null);
    setLive((prev) => ({ runKey: prev.runKey + 1, board: script.initial, chain: script.initial.chain, events: [], revision: prev.revision + 1 }));
  };

  const engine = engineOf(live);
  engine.prompt = script.prompt?.prompt ?? null;
  engine.result = result;
  // Between games and opening RPS are not live engine decisions.
  if (script.opening || script.diceOpening || script.series?.screen) engine.turn = 0;
  const duelKey = `lab-${live.runKey}`;
  // Your own deck opens the Surrender menu here too. The lab's confirm sends nothing.
  const deckSurrender: DeckSurrenderValue = {
    seat: script.mySeat === undefined ? 0 : script.mySeat,
    available: result == null && script.mySeat !== null,
    busy: false,
    onSurrender: () => setConfirmSurrender(true),
  };
  const viewerSeat = script.mySeat === undefined ? 0 : script.mySeat;
  const stageHeight = "clamp(560px, calc(100dvh - 250px), 900px)";
  const battle = isBattlePhase(live.board.phase);
  const canvasReady = Boolean(getSharedFx3d());
  // A Best of 3 scenario: the header label always shows; the between-games or match screen opens once it plays.
  const seriesRoom = useMemo(() => script.series ? {
    ...labSeriesRoom(script.initial, script.series),
    mySeat: viewerSeat,
    role: viewerSeat == null ? "spectator" as const : "player" as const,
  } : null, [script, live.runKey, viewerSeat]);

  return (
    <div className={fx.page}>
      <header className={fx.head}>
        <h1>Duel animation lab</h1>
        <p>The real board and effects with a scripted engine. Click a scenario to play it.</p>
      </header>
      <div className={fx.body}>
        <nav className={fx.list} aria-label="Scenarios">
          {LAB_CATEGORIES.map((category) => (
            <section key={category} className={fx.group}>
              <h2>{category}</h2>
              {scenariosIn(category).map((item) => (
                <button key={item.id} type="button" className={fx.item} aria-current={item.id === selectedId} onClick={() => choose(item.id)}>
                  {item.name}
                </button>
              ))}
            </section>
          ))}
        </nav>
        <main className={fx.main}>
          <div className={fx.bar}>
            <button type="button" className={fx.btn} onClick={() => play(scenario)}>
              {status === "idle" ? "Play" : "Replay"}
            </button>
            <span className={fx.seg} role="group" aria-label="Review speed">
              {SPEEDS.map((value) => (
                <button key={value} type="button" aria-pressed={speed === value} onClick={() => setSpeed(value)}>
                  {value}x
                </button>
              ))}
            </span>
            <label className={fx.check}>
              <input type="checkbox" checked={reduced} onChange={(event) => toggleReduced(event.target.checked)} /> Reduced motion
            </label>
            <label className={fx.check}>
              <input type="checkbox" checked={loop} onChange={(event) => setLoop(event.target.checked)} /> Loop
            </label>
            <label className={fx.check}>
              <input type="checkbox" checked={sound} onChange={(event) => setSound(event.target.checked)} /> Sound
            </label>
          </div>
          <div className={fx.pace}><DuelAnimationSpeedControl /></div>
          <div className={fx.caption} aria-live="polite">
            <strong>{scenario.name}</strong>
            <p>{scenario.description}</p>
            <p>
              Scenario <code>{scenario.id}</code> · about {seconds(expectedMs)} at 1x
              {playbackSpeed !== 1 ? ` (${seconds(expectedMs / playbackSpeed)} at ${playbackSpeed.toFixed(2)}x)` : ""} ·{" "}
              <span className={fx.status}>
                {status === "idle" ? "Ready" : status === "preparing" ? "Preparing" : status === "playing" ? "Playing" : "Done"}
              </span>
              {note ? ` · ${note}` : ""}
              {!reduced && !canvasReady && status === "idle" ? " · 3D effects load on the first Play" : ""}
            </p>
          </div>
          <div
            className={`${styles.shell} ${duelFontClasses}`}
            style={{ height: stageHeight, borderRadius: 8, border: "1px solid rgb(181 153 99 / 0.25)" }}
            data-duel-fx-speed-root
            data-domain={script.domain ? "true" : "false"}
            data-fit="true"
            data-phase={battle ? "battle" : undefined}
            data-turn={live.board.turnSeat === (viewerSeat ?? 0) ? "you" : "opp"}
            data-reduced={reduced ? "true" : "false"}
          >
            {seriesRoom ? <SeriesLabHeader room={seriesRoom} /> : null}
            <div className={fx.row}>
              <div className={fx.boardWrap}>
                <div className={styles.board} ref={stageRef}>
                  <MoveSourceBoundary key={live.runKey} events={engine.events} duelKey={duelKey} root={stageRef}>
                    <DeckSurrenderContext.Provider value={deckSurrender}>
                    <DuelField
                      engine={engine}
                      mySeat={viewerSeat}
                      masterRule={script.masterRule ?? 5}
                      reducedMotion={reduced}
                      legalKeys={legalKeys as Set<string>}
                      selectedKeys={pickedKeys as Set<string>}
                      onActivate={onActivate}
                      onInspect={noop}
                      bottomName={viewerSeat == null ? "Seat 0" : "You"}
                      topName={viewerSeat == null ? "Seat 1" : "Practice Bot"}
                    />
                    </DeckSurrenderContext.Provider>
                    <FxBoundary>
                      <DuelFeedback events={engine.events} duelKey={duelKey} soundEnabled={sound} soundVolume={0.6} reducedMotion={reduced} replayFrom={live.preloaded ? 0 : null} />
                      <SummonFx events={withDestroyCards(engine.events)} duelKey={duelKey} reducedMotion={reduced} shake="medium" />
                      <MoveFx events={withDestroyCards(engine.events)} duelKey={duelKey} reducedMotion={reduced} replayFrom={live.preloaded ? 0 : null} />
                      <PositionFx events={engine.events} duelKey={duelKey} reducedMotion={reduced} />
                      <ChainFx seats={engine.seats} events={withDestroyCards(engine.events)} chain={engine.chain} duelKey={duelKey} reducedMotion={reduced} mySeat={0} playerName={(seat) => (seat === 0 ? "You" : "Practice Bot")} />
                      <MasterReturnFx events={engine.events} seats={engine.seats} duelKey={duelKey} reducedMotion={reduced} mySeat={0} />
                      <BattleFx events={withDestroyCards(engine.events)} seats={engine.seats} reducedMotion={reduced} active aim={script.aim} result={engine.result} />
                      <DestroyFx events={withDestroyCards(engine.events)} reducedMotion={reduced} active mySeat={0} />
                    </FxBoundary>
                    {script.prompt ? (
                      <PromptCenter
                        prompt={script.prompt.prompt}
                        mySeat={viewerSeat}
                        active
                        slug="fx-lab"
                        busy={false}
                        draft={interactive ? { ...labDraft(pickedIds), setSelected: setPicked } : labDraft(pickedIds)}
                        onSubmit={noop}
                        menuOpen={false}
                        chain={engine.chain}
                        aimLocked={false}
                        reducedMotion={reduced}
                        revision={engine.revision}
                        battleStep={script.prompt.battleStep ?? null}
                      />
                    ) : null}
                  </MoveSourceBoundary>
                </div>
              </div>
              {script.domain ? (
                <aside className={`${styles.masters} ${fx.rail}`} aria-label="Deck Masters">
                  <DeckMasterRail
                    key={live.runKey}
                    engine={engine}
                    mySeat={0}
                    legalKeys={legalKeys as Set<string>}
                    selectedKeys={NO_KEYS as Set<string>}
                    canAct={false}
                    legalActionsFor={(_card: DuelCard | null) => []}
                    onActivate={noop}
                    onChooseAction={noop}
                    onInspect={noop}
                  />
                </aside>
              ) : null}
            </div>
          </div>
        </main>
      </div>
      <SurrenderModal open={confirmSurrender} busy={false} onClose={() => setConfirmSurrender(false)}
        onConfirm={() => { setConfirmSurrender(false); setNote("Confirmed. The duel would call the surrender action now; the lab sends nothing."); }} />
      {pickHint && pickHint.anchor.isConnected ? (
        <PickRefusalHint anchor={pickHint.anchor} text={pickHint.text} onDone={clearPickHint} />
      ) : null}
      {seriesRoom && script.series && status !== "idle" ? (
        <SeriesLabScreen key={`${scenario.id}-${live.runKey}`} room={seriesRoom} spec={script.series} reduced={reduced} sound={sound} />
      ) : null}
      {script.opening && status !== "idle" ? (
        <OpeningLabScreen key={`${scenario.id}-${live.runKey}`} spec={script.opening} />
      ) : null}
      {script.diceOpening && status !== "idle" ? (
        <DiceLabScreen key={`${scenario.id}-${live.runKey}`} spec={script.diceOpening} reduced={reduced} />
      ) : null}
      {result ? (
        <DuelResultScreen
          room={resultRoom(live.board, result)}
          slug="fx-lab"
          reducedMotion={reduced}
          soundEnabled={sound}
          onClose={() => setResult(null)}
          onExit={() => setResult(null)}
        />
      ) : null}
    </div>
  );
}
