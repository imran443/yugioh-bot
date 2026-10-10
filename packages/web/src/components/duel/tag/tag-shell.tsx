"use client";

import { multiTableTextStyle, tableTextBig, useCardTextSize, useMultiTableTextFloor } from "../card-text-size";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { teamOfSeat } from "@yugidraft/shared/duels";
import { AttackConfirm, CardActionMenu, CardHoverInfo, confirmSide, targetName } from "../card-interactions";
import { isBattlePhase, LOCATION_HAND } from "../constants";
import { DuelResultScreen } from "../duel-result";
import { SeatField } from "../field";
import { MoveSourceBoundary } from "../fx-boundary";
import { duelFxClock } from "../fx-clock";
import { duelFontClasses } from "../fonts";
import { leavingOnlySeats, outOrLeavingSeats, outSeatOptionIds } from "../multi-seat";
import { usePickContinuation } from "../pick-continuation";
import { useDuelPreferences, type DuelPreferences } from "../preferences";
import { centerKind, PromptCenter } from "../prompt-center";
import { fieldWaitsForReveal } from "../field-gate";
import { PhaseHub } from "../phase-hub";
import { optionZoneKeys, PromptTray, promptTrayVisible } from "../prompts";
import { useResultGate } from "../result-reveal";
import roomStyles from "../room.module.css";
import { SeriesBanner } from "../series-banner";
import { useIsNarrow } from "../side-panel";
import { resolveBattleStep, StationTrack } from "../station-track";
import { RowPreviewBoundary, useHudEscape, useHudPane, usePinSync, useRowPreview } from "../table/hud-layer";
import { clockStrip, hudClockBank, stationTrackProps } from "../table/hud-shared";
import { tagSeatCode } from "../table-format";
import { OpponentBar } from "../table/opponent-bar";
import { attackLockAt, toneBySeat } from "../table/seat-state";
import { tableLayout } from "../table/geometry";
import hudStyles from "../table/grid-hud.module.css";
import { AimArrow } from "../table/aim-arrow";
import { useAimFlow } from "../table/use-aim-flow";
import { useTableUi } from "../table/use-table-ui";
import { tableZoneAnchor } from "../table/zone-find";
import { carriedCamera, useReadOnlyReplayController, useReplayCarry, type ReplayCarryRef } from "../table/replay-mode";
import { SEAT_TONE_HEX, type ReplayShellMode, type TableController } from "../table/types";
import { lastEventId, lockForEvents } from "./fx-lock";
import { resolveTagExtras, tagCameraYields, tagInputSuspended, type TagShellPreviewProps } from "./live-tag";
import { initialRoofCamera, roofReducer } from "./roof-camera";
import { CameraDock } from "./roof-map";
import { resultBanner, teamLp } from "./tag-logic";
import { TagFx, tagPriority } from "./tag-fx";
import { TagHeader } from "./tag-header";
import { TagPileViewer, TagSide } from "./tag-side";
import { TagStage } from "./tag-stage";
import { TagBaton, TagTrack } from "./tag-track";
import { chainDecidingSeat, useChainPasses } from "./use-chain-passes";
import { useRoofKeys } from "./use-roof-keys";
import { gridKeyGates } from "../table/grid-focus";
import styles from "./tag-shell.module.css";

/**
 * What the Rooftop shell takes. The live room passes `TagShellLiveProps` (the seams of `TableShell` plus the team names).
 * A preview may leave the team names out and sets `preview`, which keeps the Rooftop result banner in place of the shared
 * result screen (a preview has no room to leave and no series to continue).
 * `initialOutOrder` is accepted for parity with `TableShell` and unused: a team table ends at the team's LP, there are no placings.
 */
export type TagShellProps = TagShellPreviewProps & {
  preview?: boolean;
};

type TagShellRootProps = TagShellProps & { replayCarry?: ReplayCarryRef };

/** A preview lock has no end: a time this far off never comes before the page reloads (and fits a timer). */
const OPEN_LOCK_MS = 1_000_000_000;

/** No legal zones: a hidden panel prompt lights nothing on the field. */
const NO_KEYS = new Set<string>();

/**
 * The live 2v2 table (the Rooftop): header, side panels, the roof stage, the camera dock, the turn track and station
 * track, menus, the result screen and the FX. It takes the same room seams as `TableShell` and the same shared hooks
 * (table UI, aim flow, reveal gate, pick continuation), and keeps the engine in the room: it only gets a controller.
 */
export function TagShell(props: TagShellProps) {
  return props.replay ? <ReplayTagShell {...props} replay={props.replay} /> : <TagShellRoot {...props} />;
}

/**
 * The Rooftop in replay mode (see `ReplayShellMode`). The controller is made read-only here, whatever the caller passes.
 * A new reset key remounts the table, so the loss history, the effect cursor and any camera lock of the old frame go;
 * the carry ref hands the next mount the camera the viewer chose and the panel they had open.
 */
function ReplayTagShell(props: TagShellProps & { replay: ReplayShellMode }) {
  const carry = useReplayCarry();
  const controller = useReadOnlyReplayController(props.controller);
  // Created here, not in the keyed root, so a seek does not reload the viewer's preferences.
  const own = useDuelPreferences();
  return <TagShellRoot key={props.replay.resetKey} {...props} controller={controller} preferences={props.preferences ?? own} replayCarry={carry} />;
}

function TagShellRoot(props: TagShellRootProps) {
  return props.preferences ? <TagShellBody {...props} preferences={props.preferences} /> : <TagShellOwnPreferences {...props} />;
}

/** A shell with no room above it (a preview): it keeps its own preferences, created once. */
function TagShellOwnPreferences(props: TagShellRootProps) {
  const preferences = useDuelPreferences();
  return <TagShellBody {...props} preferences={preferences} />;
}

function TagShellBody(props: TagShellRootProps & { preferences: DuelPreferences }) {
  const {
    preferences,
    controller: supplied,
    fillViewport = false,
    initialCamera,
    initialLock = null,
    actions,
    fxActive = true,
    busy: roomBusy = false,
    headerTools,
    modals,
    notices,
    settingsTools,
    connection,
    pickContinuation,
    inputSuspended = false,
    boardRef: roomBoardRef,
    preview = false,
    chainMode: chainModeProp = null,
    replay,
    replayCarry,
  } = props;
  const chainMode = replay ? null : chainModeProp;
  const { teamNames, mode } = resolveTagExtras(props, supplied);

  // A hidden panel prompt (see fieldWaitsForReveal) must not be answered from the field, and nothing glows for it yet.
  // A field pick (zone, tribute, card on the board) takes the click at once: its zones glow from the first frame.
  const given = useMemo(() => {
    const hidden = fieldWaitsForReveal(supplied.prompt, supplied.revealed);
    if (!roomBusy && !supplied.busy && !hidden) return supplied;
    const gated = { ...supplied, busy: true, canAct: false, seatPick: null };
    return hidden ? { ...gated, legalKeys: NO_KEYS } : gated;
  }, [roomBusy, supplied]);
  const localPick = usePickContinuation(pickContinuation ? null : given.prompt, given.engine.revision);
  const pick = replay ? localPick : pickContinuation ?? localPick;
  const onAnswer = useCallback<TableController["onAnswer"]>((answer) => {
    if (given.busy || !given.canAct || !given.prompt) return;
    if (!pickContinuation) pick.noteAnswer(given.prompt, answer);
    given.onAnswer(answer);
  }, [given, pick.noteAnswer, pickContinuation]);
  const tracked = useMemo(() => ({ ...given, onAnswer }), [given, onAnswer]);
  const narrow = useIsNarrow();
  // A wide screen swaps the bars and side columns for the floating HUD (table/hud-layer.tsx). The Card pane is a flyout
  // there: a hover must not fill it, only a click or Inspect does, so the list pane stays the starting one.
  const hud = !narrow;
  const hudState = useHudPane({ camera: true, initialPane: replayCarry?.current.hudPane });
  const ui = useTableUi(tracked, { initialPane: replayCarry?.current.sidePane ?? (hud ? "log" : undefined), hud, onOpenCard: hudState.openCard, onPinCard: hudState.pinCard });
  const rowPreview = useRowPreview(tracked.prompt?.id ?? null);
  const base = ui.controller;
  const { engine, room, viewerSeat, nameOf, prompt } = base;
  const layout = useMemo(
    () => tableLayout("tag", engine, viewerSeat),
    // The layout depends on who sits where, never on a card: the seat list is enough.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [engine.seats.length, viewerSeat],
  );
  const rootRef = useRef<HTMLDivElement>(null);
  const textSize = useCardTextSize();
  useMultiTableTextFloor();
  const ownBoardRef = useRef<HTMLDivElement>(null);
  const boardRef = roomBoardRef ?? ownBoardRef;
  const [sheetOpen, setSheetOpen] = useState(false);
  // One flag for the aim flow and the camera keys. A seat pick or an aim does not suspend input: they need their keys.
  const suspended = tagInputSuspended({ inputSuspended, menu: ui.menu, pile: ui.pile, narrow, sheetOpen });
  useHudEscape(hudState, hud, suspended);
  usePinSync(hudState, engine.seats);
  const hudOpen = hud && (hudState.pane != null || hudState.pinned != null);
  // A modal (Surrender) opened from the Settings flyout: the flyout closes so the modal owns Esc.
  const closeHud = hudState.close;
  useEffect(() => { if (inputSuspended) closeHud(); }, [inputSuspended, closeHud]);
  const flow = useAimFlow(base, layout, rootRef, { suspended });
  const controller = flow.controller;
  const [hideResult, setHideResult] = useState(false);

  const session = room.session;
  const domain = mode === "domain";
  const spectator = viewerSeat == null;
  const viewerOut = engine.seats.some((seat) => seat.seat === viewerSeat && (seat.eliminated || seat.pendingElimination));
  const terminal = session.status !== "active";
  const hasResult = engine.result != null || terminal;
  const resultReady = useResultGate({
    slug: session.slug,
    status: session.status,
    hasResult: engine.result != null,
    reason: engine.result?.reason ?? session.resultReason,
    reducedMotion: controller.reducedMotion,
    board: boardRef,
  });
  const showResult = !replay && !hideResult && resultReady && hasResult;

  // ---------- roof camera ----------
  const [camera, dispatchCamera] = useReducer(roofReducer, undefined, () =>
    initialRoofCamera({
      anchorSeat: layout.anchorSeat,
      camera: replayCarry?.current.camera ?? { ...initialCamera, ...(initialLock && !replay ? { lock: { reason: initialLock, untilMs: performance.now() + OPEN_LOCK_MS } } : {}) },
    }),
  );
  // A replay seek remounts the table: remember what the viewer chose, so the next mount starts from it (no lock).
  useEffect(() => {
    if (!replayCarry) return;
    // While an FX lock holds the overview, the camera the viewer chose is the one it will return to.
    const chosen = camera.lock && camera.resume ? { ...camera, mode: camera.resume.mode, focusSeat: camera.resume.focusSeat, lookSeat: camera.resume.lookSeat, fly: camera.resume.fly } : camera;
    replayCarry.current.camera = carriedCamera(chosen);
  }, [replayCarry, camera]);
  useEffect(() => {
    if (replayCarry) replayCarry.current.hudPane = hudState.pane;
  }, [replayCarry, hudState.pane]);
  useEffect(() => {
    if (replayCarry) replayCarry.current.sidePane = ui.pane;
  }, [replayCarry, ui.pane]);

  // The FX lock follows engine events newer than the last one handled. With reduced motion, or while the connection is
  // down (the FX replay nothing), no lock starts but the cursor still moves, so old events never lock the camera later.
  const lastEvent = useRef<number>(lastEventId(engine.events, 0));
  useEffect(() => {
    const lock = fxActive ? lockForEvents(engine.events, lastEvent.current, controller.reducedMotion, duelFxClock.factor()) : null;
    if (!lock) {
      lastEvent.current = lastEventId(engine.events, lastEvent.current);
      return;
    }
    lastEvent.current = lock.lastId;
    dispatchCamera({ type: "lock", reason: lock.reason, nowMs: performance.now(), ms: lock.ms });
  }, [engine.events, fxActive, controller.reducedMotion]);

  // An aim holds the camera where it is: a close-up goes back to the overview, and no click zooms in until the aim ends.
  useEffect(() => {
    dispatchCamera({ type: "aiming", on: flow.aiming });
  }, [flow.aiming]);

  const promptMine = prompt != null && !spectator && !viewerOut && prompt.seat === viewerSeat && !terminal;
  const centered = promptMine && centerKind(prompt) != null;
  const centeredUnrevealed = centered && !controller.revealed;
  // A prompt that picks zones on other fields than the focused one takes the camera back to the overview, so every
  // target stays in view and clickable. The prompt id keys it: a new prompt checks again, a click on a field does not.
  // The plain action menu (play a card, change phase) is not a pick: the hand is always in reach, and the rail can step
  // to the field that holds the card.
  const pickPrompt = promptMine && !(prompt?.kind === "choice" && prompt.context?.type === "action");
  const promptId = pickPrompt ? prompt?.id ?? null : null;
  const promptSeats = useMemo(() => {
    if (!pickPrompt || !prompt) return [];
    // A hand card is not on any field (the hand dock is always in reach): only board zones count.
    return [
      ...new Set(
        prompt.options
          .filter((option) => option.controller != null && option.location !== LOCATION_HAND && optionZoneKeys(option).length > 0)
          .map((option) => option.controller as number),
      ),
    ];
  }, [pickPrompt, prompt]);
  useEffect(() => {
    if (promptId != null && promptSeats.length > 0) dispatchCamera({ type: "needSeats", seats: promptSeats });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [promptId]);
  const gates = gridKeyGates({ prompt, viewerSeat, aiming: flow.aiming, seatKeys: flow.seatKeys, flyoutOpen: hudOpen });
  useRoofKeys({
    mode: camera.mode,
    escapeFree: gates.escapeFree,
    dispatch: dispatchCamera,
    anchorSeat: layout.anchorSeat,
    // The result screen owns the keys while it is shown.
    suspended: suspended || showResult,
    yields: tagCameraYields({ aiming: flow.aiming, seatKeys: flow.seatKeys, centeredUnrevealed }),
  });

  // ---------- derived ----------
  const tones = useMemo(() => toneBySeat(layout), [layout]);
  const toneOf = useCallback((seat: number) => SEAT_TONE_HEX[tones.get(seat) ?? "ice"], [tones]);
  const seatTones = useMemo(() => new Map([...tones].map(([seat, tone]) => [seat, SEAT_TONE_HEX[tone]])), [tones]);
  // Every viewer reads the deciding seat from the engine view, not only the seat that holds the prompt.
  const passes = useChainPasses(engine, prompt);
  const chainOpen = engine.chain.length > 0 && !terminal;
  const decidingSeat = chainDecidingSeat(engine, prompt);
  const priority = useMemo(
    () => (chainOpen ? tagPriority(engine, passes, decidingSeat) ?? undefined : undefined),
    [chainOpen, engine, passes, decidingSeat],
  );

  const battle = isBattlePhase(engine.phase);
  const battleStep = battle ? resolveBattleStep(engine.phase, engine.battleStep ?? null) : null;
  const myTurn = !spectator && engine.turnSeat === viewerSeat;
  const actionPrompt = prompt?.kind === "choice" && prompt.context?.type === "action";
  const actionOptions = prompt?.context?.type === "action" ? prompt.options : [];
  const trackCaption = terminal ? "Duel finished" : prompt == null ? null : promptMine ? (actionPrompt ? null : prompt.title) : `${nameOf(prompt.seat)} is choosing…`;
  const canAct = base.canAct && !base.busy;
  const trackProps = stationTrackProps({
    phase: engine.phase,
    battleStep,
    turn: engine.turn,
    turnSeat: engine.turnSeat,
    mySeat: viewerSeat,
    playerName: nameOf,
    promptMine,
    actionOptions,
    canAct,
    onAnswer: controller.onAnswer,
    caption: trackCaption,
    reducedMotion: controller.reducedMotion,
    chainMode,
  });
  const outSeats = engine.seats.filter((seat) => seat.eliminated).map((seat) => seat.seat);

  // The locked target of an attack: the confirm sits on the card. A locked seat keeps the opponent bar.
  const lockKey = flow.pointed?.zoneKey ?? null;
  const lockAnchor = lockKey && flow.bar?.kind === "confirm" ? tableZoneAnchor(lockKey, rootRef.current ?? document) : null;
  const barShown = flow.bar != null && !(flow.bar.kind === "confirm" && lockAnchor);
  const lockedOption = flow.pointed && prompt ? prompt.options.find((option) => option.id === flow.pointed?.optionId) : undefined;

  const viewerTeam = viewerSeat == null ? 0 : teamOfSeat("tag", viewerSeat);
  const banner = preview ? resultBanner(engine, viewerSeat, teamNames) : null;

  const tray = (
    <PromptTray
      prompt={prompt}
      mySeat={viewerSeat}
      slug={session.slug}
      busy={controller.busy}
      draft={controller.draft}
      onSubmit={controller.onAnswer}
      menuOpen={suspended} escapeHeld={hudOpen}
      active={!terminal && !viewerOut}
      aim={flow.promptAim ?? undefined}
      headless={centered}
      suspended={suspended || flow.seatKeys || centeredUnrevealed}
      waitingName={prompt ? nameOf(prompt.seat) : null}
      disabledIds={outSeatOptionIds(prompt, outOrLeavingSeats(engine.seats))}
    />
  );
  const cameraDock = (
    <CameraDock camera={camera} layout={layout} dispatch={dispatchCamera} nameOf={nameOf} turnSeat={engine.turnSeat} outSeats={outSeats} />
  );
  const side = (
    <TagSide
      controller={controller}
      ui={ui}
      preferences={preferences}
      connection={replay ? undefined : connection}
      settingsTools={replay ? undefined : settingsTools}
      replay={replay != null}
      sheetOpen={sheetOpen}
      onSheetOpenChange={setSheetOpen}
      tray={tray}
      leftClassName={styles.left}
      mastersClassName={styles.masters}
      hud={hud ? { state: hudState, hover: ui.hover, rowCard: rowPreview.card, trayVisible: promptTrayVisible(prompt, viewerSeat, !terminal && !viewerOut, centered), menuCard: ui.menu?.card ?? null, camera: cameraDock } : undefined}
    />
  );

  return (
    <div
      ref={rootRef}
      className={`${duelFontClasses} ${styles.shell}`}
      data-table-shell="tag"
      data-duel-fx-speed-root
      data-can-act={canAct ? "true" : "false"}
      data-aim-seats={flow.aimSeats.length > 0 ? flow.aimSeats.join(" ") : undefined}
      data-viewport={fillViewport ? "true" : undefined}
      data-domain={domain}
      data-phase={battle ? "battle" : undefined}
      data-turn={spectator ? "watch" : myTurn ? "you" : "opp"}
      data-reduced={controller.reducedMotion ? "true" : "false"}
      data-hud={hud ? "true" : undefined}
      data-text-big={tableTextBig(textSize)}
      style={multiTableTextStyle(textSize)}
    >
      <TagHeader
        session={session}
        engine={engine}
        viewerSeat={viewerSeat}
        nameOf={nameOf}
        teamNames={teamNames}
        preferences={preferences}
        connection={replay ? undefined : connection}
        headerTools={replay ? undefined : headerTools}
        replay={replay ? { tools: replay.tools } : undefined}
        onExit={!replay && hasResult && resultReady ? () => actions?.onExit?.() : undefined}
        onShowResult={!replay && hasResult && hideResult ? () => setHideResult(false) : undefined}
        hud={hud ? { baton: <TagBaton engine={engine} nameOf={nameOf} toneOf={toneOf} />, clock: replay ? null : hudClockBank(room.clock, session, controller.reducedMotion, (seat) => tagSeatCode("tag", seat)) } : undefined}
      />
      {hud || replay ? null : clockStrip(room.clock, session, controller.reducedMotion)}
      {room.series && !showResult && !replay ? (
        <SeriesBanner
          room={room}
          slug={session.slug}
          onChanged={() => actions?.onSeriesChanged?.()}
          onNavigate={(next) => actions?.onNavigate?.(next)}
        />
      ) : null}

      <div className={styles.main} data-masters={domain && !narrow ? "true" : "false"}>
        <div className={`${roomStyles.notices} ${hud ? styles.hudNotices : ""}`}>
          <div className="pointer-events-auto">{notices}</div>
        </div>
        {narrow ? null : side}
        <section className={styles.board} aria-label="Duel field">
          <div className={styles.boardBox} ref={boardRef} data-duel-board>
            <MoveSourceBoundary events={engine.events} duelKey={session.slug} root={boardRef}>
              <TagStage
                inspectIdleCards={hud}
                aimSeats={flow.aimSeats}
                controller={controller}
                layout={layout}
                camera={camera}
                dispatchCamera={dispatchCamera}
                renderSeatField={(fieldProps) => <SeatField {...fieldProps} />}
                teamNames={teamNames}
                hub={centered ? null : (
                  <PhaseHub
                    variant="table"
                    phase={engine.phase}
                    revision={engine.revision}
                    battleStep={battleStep}
                    turn={engine.turn}
                    turnSeat={engine.turnSeat}
                    mySeat={viewerSeat}
                    playerName={nameOf}
                    tone={engine.turnSeat != null ? toneOf(engine.turnSeat) : null}
                    actionOptions={promptMine ? actionOptions : []}
                    canAct={canAct}
                    onChoose={(id) => controller.onAnswer({ choice: id })}
                    reducedMotion={controller.reducedMotion}
                  />
                )}
                fx={<TagFx controller={controller} preferences={preferences} fxActive={fxActive} passedSeats={passes} />}
                promptCenter={
                  <RowPreviewBoundary row={rowPreview} enabled={hud}>
                  <PromptCenter
                    prompt={prompt ?? (!hasResult ? pick.waiting : null)}
                    mySeat={viewerSeat}
                    active={!terminal && !viewerOut}
                    slug={session.slug}
                    busy={controller.busy || (prompt == null && pick.waiting != null)}
                    offline={controller.offline}
                    draft={controller.draft}
                    onSubmit={controller.onAnswer}
                    menuOpen={suspended} escapeHeld={hudOpen}
                    chain={engine.chain}
                    aim={flow.promptAim ?? undefined}
                    aimLocked={flow.locked}
                    reducedMotion={controller.reducedMotion}
                    revision={engine.revision}
                    battleStep={battleStep}
                    outSeats={outOrLeavingSeats(engine.seats)}
                    leavingSeats={leavingOnlySeats(engine.seats)}
                    revealed={controller.revealed}
                    onInspectCard={hud ? rowPreview.show : (card) => ui.setInspect({ type: "info", card })}
                    nameOf={nameOf}
                    seatTones={seatTones}
                    priority={priority}
                  />
                  </RowPreviewBoundary>
                }
                overlay={
                  <>
                    {barShown && flow.bar ? (
                      <OpponentBar
                        kind={flow.bar.kind}
                        title={flow.bar.title}
                        targetLabel={flow.bar.targetLabel}
                        entries={flow.bar.entries}
                        onPick={(seat) => controller.seatPick?.onPick(seat)}
                        onConfirm={flow.confirm}
                        onCancel={flow.cancel}
                        cancelable={flow.bar.cancelable}
                      />
                    ) : null}
                    <TagPileViewer controller={controller} ui={ui} />
                    {banner && !hideResult ? (
                      <div className={styles.result} data-result={banner.outcome} role="dialog" aria-label="Duel result">
                        <div className={styles.resultCard}>
                          <p className={styles.resultKicker}>Tag duel finished</p>
                          <h2>{banner.headline}</h2>
                          <p className={styles.resultReason}>{engine.result?.reason ?? ""}</p>
                          <ul className={styles.resultTeams}>
                            {[0, 1].map((team) => (
                              <li key={team} data-mine={team === viewerTeam ? "true" : "false"} data-won={engine.result?.winnerTeam === team ? "true" : "false"}>
                                <span>{team === viewerTeam ? "◆" : "●"} {teamNames[team]}</span>
                                <b>{teamLp(engine, team).toLocaleString("en-US")}</b>
                              </li>
                            ))}
                          </ul>
                          <button type="button" onClick={() => setHideResult(true)}>View the board</button>
                        </div>
                      </div>
                    ) : null}
                  </>
                }
              />
            </MoveSourceBoundary>
          </div>
        </section>
        {narrow || hud ? null : (
          <aside className={styles.right} aria-label="Camera">
            <CameraDock camera={camera} layout={layout} dispatch={dispatchCamera} nameOf={nameOf} turnSeat={engine.turnSeat} outSeats={outSeats} />
          </aside>
        )}
      </div>

      {hud ? (
        <div className={`${hudStyles.bottom} ${styles.tagBottom}`} data-testid="hud-bottom" data-tag-track>
          {replay ? <div className={styles.replayCorner} data-testid="replay-transport">{replay.transport}</div> : null}
          <StationTrack
            {...trackProps}
            phases="hub"
            clock={null}
            attackLock={attackLockAt("tag", engine.seats.length || 4, engine.turn, prompt)}
            attackLockTestId="tag-attack-lock"
          />
        </div>
      ) : (
        <>
          {replay ? <div className={styles.replayBar} data-testid="replay-transport">{replay.transport}</div> : null}
          <TagTrack
            engine={engine}
            nameOf={nameOf}
            prompt={prompt}
            toneOf={toneOf}
          >
            <StationTrack {...trackProps} clock={null} />
          </TagTrack>
        </>
      )}
      {narrow ? side : null}

      {ui.menu ? (
        <CardActionMenu
          anchor={ui.menu.anchor}
          title={ui.menu.title}
          options={ui.menu.options}
          busy={controller.busy}
          onClose={ui.closeMenu}
          tone={ui.menu.tone}
          onChoose={(option) => {
            if (!ui.menu || ui.menu.promptId !== prompt?.id || ui.menu.revision !== engine.revision) return;
            ui.closeMenu();
            controller.onAnswer({ choice: option.id });
          }}
        />
      ) : null}
      {flow.arrow ? <AimArrow {...flow.arrow} /> : null}
      {lockAnchor && flow.pointed && !controller.busy ? (
        <AttackConfirm
          anchor={lockAnchor}
          targetName={lockedOption ? targetName(lockedOption) : flow.pointed.label}
          busy={controller.busy}
          prefer={confirmSide(ui.attackerKey, lockAnchor, rootRef.current ?? document)}
          onConfirm={flow.confirm}
          onBack={flow.cancel}
        />
      ) : null}
      {!hud && ui.hover && !ui.menu && !ui.pile?.open && !sheetOpen ? <CardHoverInfo card={ui.hover.card} anchor={ui.hover.anchor} /> : null}
      {showResult && !preview ? (
        <DuelResultScreen
          room={room}
          slug={session.slug}
          reducedMotion={controller.reducedMotion}
          soundEnabled={preferences.soundEnabled}
          onClose={() => setHideResult(true)}
          onExit={() => actions?.onExit?.()}
          onSeriesChanged={() => actions?.onSeriesChanged?.()}
          onNavigate={(next) => actions?.onNavigate?.(next)}
        />
      ) : null}
      {replay ? null : modals}
    </div>
  );
}
