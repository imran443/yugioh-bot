"use client";

import { multiTableTextStyle, tableTextBig, useCardTextSize, useMultiTableTextFloor } from "../card-text-size";
import { eliminationOrder } from "@/lib/duel/elimination-order";
import { connectionLabel as labelForConnection } from "../connection-label";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import Link from "next/link";
import { Circle, Diamond, Eye, Film, Radio, Volume2, VolumeX } from "lucide-react";
import type { DuelCard } from "@yugidraft/shared/duels";
import { isCustomDomain } from "@yugidraft/shared/duels";
import { BattleFx } from "../battle-fx";
import { AttackConfirm, CardActionMenu, CardHoverInfo, confirmSide, targetName } from "../card-interactions";
import { ChainFx } from "../chain-fx";
import { ownPromptOpen } from "../chain-narrate";
import { projectChainNames } from "../chain-state";
import { CoinTossFx } from "../coin-toss-fx";
import { isBattlePhase, phaseTitle, zoneKey } from "../constants";
import { DestroyFx } from "../destroy-fx";
import { DuelResultScreen } from "../duel-result";
import { resolveEquipLinks } from "../equip-links";
import { DuelFeedback } from "../feedback";
import { DeckMasterRail, SeatField } from "../field";
import { FxBoundary, MoveSourceBoundary } from "../fx-boundary";
import { duelFontClasses } from "../fonts";
import { DuelHistoryRail } from "../history-rail";
import { CardInspector, type InspectTarget } from "../inspector";
import { MasterReturnFx } from "../master-return-fx";
import { MoveFx } from "../move-fx";
import { engineFormat, formatLabel, leavingOnlySeats, outOrLeavingSeats, outSeatOptionIds } from "../multi-seat";
import { PileViewer } from "../pile-viewer";
import { livePileCards } from "../pile-focus";
import { MatchSheetLog } from "../text-log";
import { PositionFx } from "../position-fx";
import { centerKind, PromptCenter } from "../prompt-center";
import { fieldWaitsForReveal } from "../field-gate";
import { optionsForCard, PromptTray } from "../prompts";
import { priorityOrder } from "../priority-chips";
import { usePickContinuation, type PickContinuation } from "../pick-continuation";
import { useResultGate } from "../result-reveal";
import { firstInspectCard } from "../tag/tag-logic";
import { SeatStrip } from "../seat-strip";
import { SeriesBanner } from "../series-banner";
import { CardTabEmpty, useIsNarrow } from "../side-panel";
import { battleStepLabel, resolveBattleStep, StationTrack, type BattleStep } from "../station-track";
import { PhaseHub } from "../phase-hub";
import { SummonFx } from "../summon-fx";
import { useDuelPreferences, type DuelPreferences } from "../preferences";
import type { ChainModeControl } from "../use-chain-mode";
import roomStyles from "../room.module.css";
import { CameraControls } from "./camera-controls";
import { isFaceOff } from "./camera-model";
import { tableLayout } from "./geometry";
import { GridStage } from "./grid-stage";
import { CAPTION_TEXT, useGridFinale } from "./grid-finale";
import { gridKeyGates, useGridFocus } from "./grid-focus";
import { hudPreview } from "./hud-preview";
import { HudLayer, RowPreviewBoundary, useHudEscape, useHudPane, usePinSync, useRowPreview } from "./hud-layer";
import { clockStrip, hudClockBank, hudMasterProps, stationTrackProps } from "./hud-shared";
import { gridCells, usesGridLayout } from "./grid-layout";
import { HistoryStrip } from "./history-strip";
import { MasterChip } from "./master-chip";
import { OpponentBar } from "./opponent-bar";
import { attackLockAt, placeLabel, placings, toneBySeat, trackOutOrder } from "./seat-state";
import { TableDrawer, TableRail } from "./table-rail";
import { TableSettings, type TableConnection } from "./table-settings";
import { TablePhonePanes } from "./table-phone-panes";
import { TableStage } from "./table-stage";
import { tableZoneAnchor } from "./zone-find";
import { AimArrow } from "./aim-arrow";
import { useAimFlow } from "./use-aim-flow";
import { useCamera } from "./use-camera";
import { useTableDrawer } from "./use-table-drawer";
import { useTableUi } from "./use-table-ui";
import { carriedCamera, useReadOnlyReplayController, useReplayCarry, type ReplayCarryRef } from "./replay-mode";
import { SEAT_TONE_HEX, type CameraLockReason, type CameraState, type ReplayShellMode, type TableController, type TableFormat } from "./types";
import hudStyles from "./grid-hud.module.css";
import styles from "./table-shell.module.css";
import { withDestroyCards } from "../destroy-cards";

export interface TableShellActions {
  onExit?: () => void;
  onSeriesChanged?: () => void;
  onNavigate?: (slug: string) => void;
}

export interface TableShellProps {
  controller: TableController;
  /** Live duel pages have no height-bound parent; previews keep their container's height. */
  fillViewport?: boolean;
  /** Starting camera; the preview passes what its URL asks for. */
  initialCamera?: Partial<CameraState>;
  /** Start with the FX lock on (the preview shows the chip with it). It stays on until the page reloads. */
  initialLock?: CameraLockReason | null;
  /** What the room does with the result screen and the series. A preview leaves them out. */
  actions?: TableShellActions;
  /**
   * Losses before mount, earliest first. Engine groups and retained elimination logs update this history live.
   * Seats whose older losses cannot be recovered share a place.
   */
  initialOutOrder?: readonly (readonly number[])[];
  /**
   * Seams for the room that mounts this shell on a live duel (plan section 1). Each one is optional and a preview leaves
   * them out.
   * `fxActive`: false while the connection is down or recovering, so no FX replays old events (room: `!error && !recovering`).
   * `busy`: the room is working or catching up; it blocks answers like the controller's own `busy` does.
   * `headerTools`: extra header controls, such as the Surrender button.
   * `modals`: dialogs the room owns, such as the surrender confirm.
   */
  fxActive?: boolean;
  busy?: boolean;
  headerTools?: ReactNode;
  modals?: ReactNode;
  notices?: ReactNode;
  settingsTools?: ReactNode;
  connection?: TableConnection;
  /** Live rooms own continuation timing alongside their reveal gate. Previews track it locally. */
  pickContinuation?: PickContinuation;
  /** A room modal owns keyboard input while open. */
  inputSuspended?: boolean;
  /** The room's prompt reveal gate must wait on this shell's board effects. */
  boardRef?: RefObject<HTMLDivElement | null>;
  /**
   * The room's one preferences instance. The room already feeds its Motion setting to the controller and the FX speed
   * clock, so the shell's Settings tab must change that same state. A preview leaves it out and gets its own.
   */
  preferences?: DuelPreferences;
  /** The viewer's chain response switch, owned by the room (it sends the change and holds the R key). Null or absent: no switch. */
  chainMode?: ChainModeControl | null;
  /** The 4-way grid: where the phase hub sits, in the shared Extra Monster band (default) or in the middle of the table. */
  hubPlace?: "band" | "center";
  /**
   * Replay mode: the shell is a read-only viewer of one frame (see `ReplayShellMode` in types.ts). It cannot answer, and it
   * draws no live result, series, clock, connection, Surrender or next-game control. `actions`, `headerTools`,
   * `settingsTools`, `connection`, `chainMode`, `pickContinuation` and `modals` are ignored. A new `replay.resetKey`
   * restarts the table clean; the chosen camera and the open panel stay. Do not switch this prop on a mounted shell.
   */
  replay?: ReplayShellMode;
}

/** No legal zones: a hidden panel prompt lights nothing on the field. */
const NO_KEYS = new Set<string>();

/** True from the first render where `on` is true, for the life of the component. */
function useLatch(on: boolean): boolean {
  const [latched, setLatched] = useState(on);
  if (on && !latched) setLatched(true);
  return latched || on;
}

/**
 * The whole table of a 3 or 4 seat duel: header, history and card tabs, the stage, the Deck Master column, the station
 * track, menus, the result screen and the FX. It uses the exported duel components of the 1v1 room and keeps the room's
 * look (room.module.css). The room itself stays the owner of the live engine: it passes a controller.
 */
export function TableShell(props: TableShellProps) {
  return props.replay ? <ReplayTableShell {...props} replay={props.replay} /> : <TableShellRoot {...props} />;
}

/**
 * The shell in replay mode. The controller is made read-only here, whatever the caller passes. A new reset key remounts
 * the table, which drops everything of the old frame (loss order, running effects, camera locks, menus); the carry ref
 * hands the next mount the camera the viewer chose and the panel they had open.
 */
function ReplayTableShell(props: TableShellProps & { replay: ReplayShellMode }) {
  const carry = useReplayCarry();
  const controller = useReadOnlyReplayController(props.controller);
  // Created here, not in the keyed root, so a seek does not reload the viewer's preferences.
  const own = useDuelPreferences();
  return <TableShellRoot key={props.replay.resetKey} {...props} controller={controller} preferences={props.preferences ?? own} replayCarry={carry} />;
}

type TableShellRootProps = TableShellProps & { replayCarry?: ReplayCarryRef };

function TableShellRoot(props: TableShellRootProps) {
  return props.preferences ? <TableShellBody {...props} preferences={props.preferences} /> : <TableShellOwnPreferences {...props} />;
}

/** A shell with no room above it (a preview): it keeps its own preferences, created once. */
function TableShellOwnPreferences(props: TableShellRootProps) {
  const preferences = useDuelPreferences();
  return <TableShellBody {...props} preferences={preferences} />;
}

function TableShellBody({
  controller: supplied,
  fillViewport = false,
  initialCamera,
  initialLock = null,
  actions,
  initialOutOrder,
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
  preferences,
  chainMode = null,
  hubPlace = "band",
  replay,
  replayCarry,
}: TableShellRootProps & { preferences: DuelPreferences }) {
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
  // A 4-way free-for-all draws the 2 by 2 grid (grid-layout.ts decides); every other table keeps the plaza stage.
  // A core that shares the Extra Monster Zones another way than the grid draws them keeps the plaza stage for the whole
  // duel, also once its last two seats share nothing (see useLatch).
  const trackedFormat = engineFormat(tracked.engine) as TableFormat;
  const gridFits = usesGridLayout(trackedFormat, tracked.engine.seats);
  const gridRefused = useLatch(trackedFormat === "ffa4" && !gridFits);
  const grid = gridFits && !gridRefused;
  // The 3-way plaza on a wide screen keeps its stage and gets the same floating HUD (Log, Settings and Camera).
  const plazaHud = !narrow && !grid && trackedFormat === "ffa3";
  // The 4-way grid on a wide screen swaps the bars and side columns for the floating HUD (grid-hud.tsx).
  const hud = !narrow && (grid || plazaHud);
  // The Card pane is a flyout in the HUD: a hover must not fill it, only a click or Inspect does.
  const hudState = useHudPane({ camera: plazaHud, initialPane: replayCarry?.current.hudPane });
  const ui = useTableUi(tracked, { initialPane: replayCarry?.current.sidePane ?? (grid && hud ? "log" : undefined), hud, onOpenCard: hudState.openCard, onPinCard: hudState.pinCard });
  useHudEscape(hudState, hud, ui.suspended);
  usePinSync(hudState, tracked.engine.seats);
  const hudOpen = hud && (hudState.pane != null || hudState.pinned != null);
  // A modal (Surrender) opened from the Settings flyout: the flyout closes so the modal owns Esc.
  const closeHud = hudState.close;
  useEffect(() => { if (inputSuspended) closeHud(); }, [inputSuspended, closeHud]);
  const rowPreview = useRowPreview(tracked.prompt?.id ?? null);
  const base = ui.controller;
  const { engine, room, viewerSeat, nameOf, prompt } = base;
  const namedChain = useMemo(() => projectChainNames(engine.chain, engine.seats), [engine.chain, engine.seats]);
  const format = engineFormat(engine);
  // A table of 3 or 4 draws its phases on the board, beside the turn ring. Tag keeps them in the bar.
  const hubOn = format === "ffa3" || format === "ffa4";
  const layout = useMemo(
    () => tableLayout(format as TableFormat, engine, viewerSeat),
    // The layout depends on who sits where, never on a card: the seat list is enough.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [format, engine.seats.length, viewerSeat],
  );
  const Stage = grid ? GridStage : TableStage;
  const rootRef = useRef<HTMLDivElement>(null);
  const textSize = useCardTextSize();
  useMultiTableTextFloor();
  const ownBoardRef = useRef<HTMLDivElement>(null);
  const boardRef = roomBoardRef ?? ownBoardRef;
  const [sheetOpen, setSheetOpen] = useState(false);
  const suspended = inputSuspended || ui.suspended || (narrow && sheetOpen);
  const flow = useAimFlow(base, layout, rootRef, { suspended });
  const controller = flow.controller;
  const camera = useCamera({ controller, layout, initial: replayCarry?.current.camera ?? initialCamera, initialLock: replay ? null : initialLock, seatKeys: flow.seatKeys, suspended, uprightOnly: grid });
  // A replay seek remounts the table: remember what the viewer chose, so the next mount starts from it.
  useEffect(() => {
    if (replayCarry) replayCarry.current.camera = carriedCamera(camera.state);
  }, [replayCarry, camera.state]);
  useEffect(() => {
    if (replayCarry) replayCarry.current.hudPane = hudState.pane;
  }, [replayCarry, hudState.pane]);
  useEffect(() => {
    if (replayCarry) replayCarry.current.sidePane = ui.pane;
  }, [replayCarry, ui.pane]);
  // The 4-way grid starts on the full table (all four fields). The turn strip and the keys (1 to 4, O, Esc) move the focus.
  const gridSeats = useMemo(() => gridCells(layout), [layout]);
  const gridShown = useMemo(() => engine.seats.filter((view) => !view.eliminated).map((view) => view.seat), [engine.seats]);
  const gates = gridKeyGates({ prompt: controller.prompt, viewerSeat, aiming: flow.aiming, seatKeys: flow.seatKeys, flyoutOpen: hudOpen });
  const gridFocus = useGridFocus({
    enabled: grid,
    shown: gridShown,
    suspended,
    digitsFree: gates.digitsFree,
    escapeFree: gates.escapeFree,
  });
  // The last two seats of a 4-way glide into one full board in the middle (the 1v1 composition) and say FINAL DUEL. The 3-way
  // plaza uses the same caption and timing: its seats regroup face to face (geometry.ts duoFinaleSlots).
  const finale = useGridFinale({ seats: engine.seats, cells: gridSeats, reducedMotion: controller.reducedMotion });
  const [hideResult, setHideResult] = useState(false);
  const [logUnread, setLogUnread] = useState(0);
  // Phone and small tablet: the left column is a sheet opened from a bar under the station track.
  const session = room.session;
  const domain = session.mode === "domain";
  // The wide table keeps the History, Card, Log, Master and Settings panes behind a 72px rail; the phone layout keeps its sheet.
  const drawer = useTableDrawer(ui, { domain, reducedMotion: controller.reducedMotion, enabled: !narrow && !hud });
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

  // Who left, in order (groups: seats that left in one update share a place): the placings of a table of 3 or 4 read it.
  const [outOrder, setOutOrder] = useState<number[][]>(() => eliminationOrder(engine, initialOutOrder));
  const nextOut = trackOutOrder(outOrder, engine);
  if (nextOut.length !== outOrder.length || nextOut.some((group, at) => group.length !== outOrder[at].length || group.some((seat, index) => seat !== outOrder[at][index]))) setOutOrder(nextOut);
  const standings = useMemo(() => placings(engine, outOrder), [engine, outOrder]);

  const tones = useMemo(() => toneBySeat(layout), [layout]);
  const toneOf = (seat: number) => SEAT_TONE_HEX[tones.get(seat) ?? "ice"];
  const seatTones = useMemo(() => new Map([...tones].map(([seat, tone]) => [seat, SEAT_TONE_HEX[tone]])), [tones]);

  const battle = isBattlePhase(engine.phase);
  const engineStep = engine.battleStep ?? null;
  const battleStep: BattleStep | null = battle ? resolveBattleStep(engine.phase, engineStep) : null;
  const stepName = battleStepLabel(battleStep);
  const headerPhase = battle ? `Battle Phase${stepName ? ` · ${stepName}` : ""}` : phaseTitle(engine.phase);
  const turnSeat = engine.turnSeat;
  const myTurn = !spectator && turnSeat === viewerSeat;
  // A replay has no player: the camera seat is not "you".
  const turnText = myTurn && !replay ? "Your turn" : `${nameOf(turnSeat)}'s turn`;
  const soundLabel = preferences.soundEnabled ? "On" : "Off";
  const connectionLabel = labelForConnection(terminal, connection);

  const promptMine = prompt != null && !spectator && !viewerOut && prompt.seat === viewerSeat && !terminal;
  const centered = promptMine && centerKind(prompt) != null;
  const actionPrompt = prompt?.kind === "choice" && prompt.context?.type === "action";
  const actionOptions = prompt?.context?.type === "action" ? prompt.options : [];
  const dockMode = !promptMine || prompt == null || centered ? "idle" : actionPrompt ? (prompt.cancelable || prompt.finishable ? "float" : "idle") : "flow";
  const trackCaption = terminal ? "Duel finished" : prompt == null ? null : promptMine ? (actionPrompt ? null : prompt.title) : `${nameOf(prompt.seat)} is choosing…`;
  // Esc closes the drawer from anywhere on the table: a card inspect opens it and leaves focus on the card, outside it. A prompt
  // that owns the Escape (its hide, pass or back), a menu, the pile viewer, a live aim and a modal get it first; inside the rail
  // or the drawer their own keys close it and hand focus back to the button.
  const escRef = useRef({ open: false, owned: false, close: () => {} });
  const escOwned = suspended || flow.aiming || flow.seatKeys || centered || camera.state.mode === "fly" || (promptMine && (prompt?.cancelable === true || prompt?.finishable === true));
  camera.escapeOwned.current = suspended || flow.aiming || flow.seatKeys || centered || (promptMine && (prompt?.cancelable === true || prompt?.finishable === true));
  escRef.current = { open: drawer.open, owned: escOwned, close: () => drawer.close(false) };
  useEffect(() => {
    if (narrow) return;
    const onKey = (event: KeyboardEvent) => {
      const state = escRef.current;
      if (event.key !== "Escape" || !state.open || state.owned || event.defaultPrevented) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest?.("[data-table-chrome], input, textarea, select, [contenteditable='true'], [aria-modal='true']") || document.querySelector("[aria-modal='true']")) return;
      event.preventDefault();
      state.close();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [narrow]);
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
    chainMode: replay ? null : chainMode,
  });
  // Who may answer the open chain, in order (the panel of the chain and the response prompt list it).
  const chainOpen = engine.chain.length > 0 && !terminal;
  const priority = useMemo(
    () => (chainOpen ? priorityOrder(engine.seats, engine.turnSeat, engine.chain, prompt?.context?.type === "chain" ? prompt.seat : null) : undefined),
    [chainOpen, engine.seats, engine.turnSeat, engine.chain, prompt],
  );

  // The locked target of an attack: the confirm sits on the card. A locked seat keeps the opponent bar.
  const lockKey = flow.pointed?.zoneKey ?? null;
  const lockAnchor = lockKey && flow.bar?.kind === "confirm" ? tableZoneAnchor(lockKey, rootRef.current ?? document) : null;
  const barShown = flow.bar != null && !(flow.bar.kind === "confirm" && lockAnchor);
  const lockedOption = flow.pointed && prompt ? prompt.options.find((option) => option.id === flow.pointed?.optionId) : undefined;

  const onInspectorActivate = (card: DuelCard, anchor: HTMLElement) =>
    controller.onActivate([zoneKey(card.controller, card.location, card.sequence)], card, anchor, true);

  const masterRail = domain ? (
    <DeckMasterRail
      engine={engine}
      mySeat={viewerSeat}
      legalKeys={controller.legalKeys}
      selectedKeys={controller.selectedKeys}
      canAct={canAct}
      legalActionsFor={(card, keys) => (canAct && prompt?.kind === "choice" && prompt.context?.type === "action" ? optionsForCard(prompt, card, keys) : [])}
      onChooseAction={(option) => controller.onAnswer({ choice: option.id })}
      onActivate={controller.onActivate}
      onHoverCard={controller.onHoverCard}
      onInspect={controller.onInspect}
      rivals={[]}
      selfTitle={spectator ? `${nameOf(layout.anchorSeat)}'s Master` : undefined}
    />
  ) : null;

  const cameraProps = {
    layout,
    camera: camera.state,
    locked: camera.locked,
    hint: camera.hint,
    nameOf,
    dispatch: camera.dispatch,
    out: camera.out,
  };
  const playersText = session.seats.map((seat) => seat.displayName).join(" v ");
  const logVisible = hud ? hudState.pane === "log" : ui.pane === "log" && (narrow ? sheetOpen : drawer.open);
  const inspectCard = (target: InspectTarget) => { ui.inspectCard(target); if (narrow) setSheetOpen(true); };
  // Before anything is hovered the Card tab shows the viewer's first face-up monster (else a hand card), as the tag table does.
  const startCard = ui.inspect ? null : firstInspectCard(engine, viewerSeat);
  const inspectorTarget: InspectTarget | null = ui.inspect ?? (startCard ? { type: "card", card: startCard } : null);
  const cardPanel = inspectorTarget ? (
    <CardInspector
      target={inspectorTarget}
      onInspectCard={(card) => ui.setInspect({ type: "card", card })}
      onActivateCard={onInspectorActivate}
      equipLinks={resolveEquipLinks(engine.seats)}
      ownerOf={(card) => ({ name: nameOf(card.controller), tone: toneOf(card.controller) })}
    />
  ) : (
    <CardTabEmpty />
  );
  const logPanel = (
    <div className={roomStyles.logPane}>
      <DuelHistoryRail
        key={session.slug}
        events={engine.events}
        engine={engine}
        mySeat={viewerSeat}
        playerName={nameOf}
        onInspectCard={(card) => inspectCard("location" in card ? { type: "card", card } : { type: "info", card })}
        reducedMotion={controller.reducedMotion}
        active={logVisible}
        onUnread={setLogUnread}
        seatTones={seatTones}
      />
      <details className={roomStyles.textLog}>
        <summary>Text log</summary>
        <MatchSheetLog entries={engine.log} playerName={nameOf} players={playersText} seatTones={seatTones} />
      </details>
    </div>
  );

  // Your Deck Master hangs under your LP plate on the wide table; a click opens the drawer on its Master tab.
  const myView = viewerSeat != null ? engine.seats.find((seat) => seat.seat === viewerSeat) : undefined;
  const masterChip = domain && !narrow && !hud && myView?.deckMaster ? (
    <MasterChip view={myView} label="Your Master" onOpen={() => { ui.setPane("masters"); ui.setDrawerOpen(true); }} />
  ) : null;

  const pileSeat = ui.pile?.seat;
  const out = useMemo(() => standings.filter((entry) => engine.seats.find((view) => view.seat === entry.seat)?.eliminated === true), [standings, engine.seats]);
  const placeLabels = useMemo(() => new Map(out.map((entry) => [entry.seat, placeLabel(entry.place)])), [out]);
  // Seats that were already out when the table opened (a reload, a late join) show their notes at once; a seat that
  // leaves while you watch gets notes that wait for its board to crumble. A new duel (or the next game of a series)
  // starts the count again.
  const gameKey = `${session.slug}:${room.series?.gameNumber ?? 0}`;
  const [opened, setOpened] = useState(() => ({ key: gameKey, seats: new Set(out.map((entry) => entry.seat)) }));
  if (opened.key !== gameKey) setOpened({ key: gameKey, seats: new Set(out.map((entry) => entry.seat)) });
  const outAtOpen = opened.seats;
  const viewerEliminated = engine.seats.some((view) => view.seat === viewerSeat && view.eliminated === true);
  // The live region says your own elimination. On the 4-way grid it also says who left last while you watch and what
  // the last two are: there the out notes are hidden from the eye and not live, and the caption is only drawn.
  const freshOut = grid ? out.filter((entry) => entry.seat !== viewerSeat && !outAtOpen.has(entry.seat)) : [];
  const newestOut = freshOut.reduce<(typeof out)[number] | null>((best, entry) => (best == null || entry.place < best.place ? entry : best), null);
  const finaleNote = (grid || plazaHud) && finale.caption ? `Final duel: ${finale.caption.seats.map((seat) => nameOf(seat)).join(" vs ")}.` : "";
  const liveText = [
    viewerEliminated ? "You are eliminated. You keep watching." : "",
    newestOut ? `${nameOf(newestOut.seat)} is out, ${placeLabel(newestOut.place)}.` : "",
    finaleNote,
  ].filter(Boolean).join(" ");

  const identityNode = (
    <div className={roomStyles.identity}>
      <Link href="/duels">Dueling Domain</Link>
      {spectator ? (
        <strong className={roomStyles.viewerRole} title="You are watching. Hidden cards stay private.">
          <Eye size={15} strokeWidth={1.5} aria-hidden /> You are spectating
        </strong>
      ) : null}
      <span className={roomStyles.format}>
        {domain ? (isCustomDomain(session.masterRule, session.settings) ? "Custom Domain" : "Domain") : `MR${session.masterRule}`} · {formatLabel(format)}
      </span>
    </div>
  );
  const turnNode = (
    <div className={roomStyles.turn}>
      <strong>Turn {engine.turn}</strong>
      <span className={roomStyles.phaseName} data-step={battleStep ?? undefined}>{headerPhase}</span>
      <span
        className={`${roomStyles.whoPill} ${styles.whoTone}`}
        data-turn={spectator ? "watch" : myTurn ? "you" : "opp"}
        data-testid="who-pill"
        style={{ "--seat-main": toneOf(turnSeat).main, "--seat-ink": toneOf(turnSeat).ink } as CSSProperties}
      >
        {spectator ? <Eye size={13} strokeWidth={1.75} aria-hidden /> : myTurn
          ? <Diamond size={13} strokeWidth={1.75} fill="currentColor" aria-hidden />
          : <Circle size={13} strokeWidth={1.75} aria-hidden />}
        {turnText}
      </span>
    </div>
  );
  const statusNode = (
    <div className={roomStyles.status}>
      {replay ? replay.tools : headerTools}
      {replay ? (
        <span className={roomStyles.connectionStatus} data-replay-label>
          <Film size={15} strokeWidth={1.75} aria-hidden />
          <span className={roomStyles.connectionText}>Replay</span>
        </span>
      ) : (
        <span className={roomStyles.connectionStatus} role="status" aria-live="polite" data-live={connectionLabel === "Live"}>
          {connectionLabel === "Live" ? <i className={roomStyles.liveDot} aria-hidden /> : <Radio size={15} strokeWidth={1.75} aria-hidden />}
          <span className={roomStyles.connectionText}>
            {connectionLabel === "Live" ? spectator ? "Live duel · watching" : "Live duel" : connectionLabel}
          </span>
        </span>
      )}
      {!replay && hasResult && hideResult ? (
        <button type="button" className={roomStyles.tool} onClick={() => setHideResult(false)}><span>Show result</span></button>
      ) : null}
      {!replay && hasResult && resultReady ? (
        <button type="button" className={roomStyles.tool} onClick={actions?.onExit}><span>Exit duel</span></button>
      ) : null}
      <button
        type="button"
        className={`${roomStyles.tool} ${roomStyles.pref}`}
        aria-label={`Sound effects ${soundLabel.toLowerCase()}`}
        onClick={() => preferences.setSoundEnabled(!preferences.soundEnabled)}
      >
        {preferences.soundEnabled ? <Volume2 size={16} strokeWidth={1.75} aria-hidden /> : <VolumeX size={16} strokeWidth={1.75} aria-hidden />}
        <span>Sound <b>{soundLabel}</b></span>
      </button>
    </div>
  );

  const seatStripNode = (
    <SeatStrip engine={engine} mySeat={viewerSeat} nameOf={nameOf} promptSeat={controller.promptSeat}
      focusSeat={grid ? gridFocus.focus.seat : camera.state.focusSeat} focusAny={grid}
      onFocusSeat={grid ? gridFocus.focusSeat : isFaceOff(layout, camera.out) ? undefined : (seat) => camera.dispatch({ type: "focus", seat })}
      pick={canAct && controller.revealed ? controller.seatPick : null} compact={!narrow} />
  );

  const promptDockNode = (
  <div
    className={`${roomStyles.promptDock} ${hud ? styles.hudPrompt : ""}`}
    data-mode={dockMode}
    data-tone={prompt?.context?.type === "chain" ? "chain" : "action"}
    data-idle={dockMode === "idle" ? "true" : "false"}
    data-prompt-surface={dockMode === "idle" ? undefined : ""}
  >
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
      suspended={suspended || flow.seatKeys || (centered && !controller.revealed)}
      waitingName={prompt ? nameOf(prompt.seat) : null}
      disabledIds={outSeatOptionIds(prompt, outOrLeavingSeats(engine.seats))}
    />
  </div>
  );

  return (
    <div
      ref={rootRef}
      className={`${roomStyles.shell} ${styles.shell} ${duelFontClasses}`}
      data-table-shell
      data-duel-fx-speed-root
      data-can-act={canAct ? "true" : "false"}
      data-aim-seats={flow.aimSeats.length > 0 ? flow.aimSeats.join(" ") : undefined}
      data-viewport={fillViewport ? "true" : undefined}
      data-domain={domain}
      data-fit="true"
      data-grid={grid ? "true" : undefined}
      data-hud={hud ? "true" : undefined}
      data-plaza-hud={plazaHud ? "true" : undefined}
      data-phase={battle ? "battle" : undefined}
      data-turn={spectator ? "watch" : myTurn ? "you" : "opp"}
      data-reduced={controller.reducedMotion ? "true" : "false"}
      data-text-big={tableTextBig(textSize)}
      style={multiTableTextStyle(textSize)}
    >
      {/* One live region that stays mounted: a region that appears with its text is not always read out. */}
      <p className={styles.liveNote} role="status" aria-live="polite" data-testid="table-live">
        {liveText}
      </p>
      {hud ? (
        <header className={hudStyles.top} data-testid="hud-top">
          <div className={hudStyles.topLeft}>{identityNode}</div>
          {replay ? null : hudClockBank(room.clock, session, controller.reducedMotion)}
          <div className={hudStyles.topMid} data-caption={finale.caption ? "true" : undefined}>
            {seatStripNode}
            {finale.caption ? (
              <div key={finale.caption.id} className={hudStyles.caption} aria-hidden="true" data-testid="grid-caption" data-kind={finale.caption.kind}>
                <span className={hudStyles.captionKey}>{CAPTION_TEXT}</span>
                <span className={hudStyles.captionNames}>
                  {finale.caption.seats.map((seat, index) => (
                    <span key={seat} className={hudStyles.captionName}>
                      {index > 0 ? <em>vs</em> : null}
                      <i style={{ background: toneOf(seat).main, boxShadow: `0 0 8px ${toneOf(seat).main}` }} />
                      {nameOf(seat)}
                    </span>
                  ))}
                </span>
              </div>
            ) : null}
          </div>
          <div className={hudStyles.topRight}>{turnNode}{statusNode}</div>
        </header>
      ) : (
        <header className={roomStyles.header}>
          {identityNode}
          {turnNode}
          {statusNode}
        </header>
      )}
      {hud || replay ? null : clockStrip(room.clock, session, controller.reducedMotion)}
      {room.series && !showResult && !replay ? (
        <SeriesBanner
          room={room}
          slug={session.slug}
          onChanged={() => actions?.onSeriesChanged?.()}
          onNavigate={(next) => actions?.onNavigate?.(next)}
        />
      ) : null}
      <div
        className={`${roomStyles.layout} ${hud ? styles.hudLayout : ""}`}
        data-wide={narrow || hud ? undefined : "true"}
        data-drawer={narrow || hud ? undefined : drawer.open ? "open" : "closed"}
        data-glide={narrow || hud ? undefined : drawer.settled ? drawer.glide ?? undefined : "none"}
      >
        <div className={`${roomStyles.notices} ${hud ? styles.hudNotices : ""}`} data-prompt-surface="">
          <div className="pointer-events-auto">{notices}</div>
        </div>
        {narrow || hud ? null : (
          <>
            <TableRail
              panes={drawer.panes}
              pane={drawer.pane}
              open={drawer.open}
              unread={logUnread}
              viewOpen={drawer.viewOpen}
              onPane={drawer.togglePane}
              onView={drawer.toggleView}
              register={drawer.register}
              onKeyDown={drawer.onKeyDown}
              history={
                <HistoryStrip
                  variant="rail"
                  engine={engine}
                  mySeat={viewerSeat}
                  playerName={nameOf}
                  seatTones={seatTones}
                  onInspectCard={(card) => inspectCard("location" in card ? { type: "card", card } : { type: "info", card })}
                />
              }
            />
            <TableDrawer
              panes={drawer.panes}
              pane={drawer.pane}
              open={drawer.open}
              unread={logUnread}
              settled={drawer.settled}
              card={cardPanel}
              log={logPanel}
              masters={masterRail}
              settings={<TableSettings controller={controller} preferences={preferences} connection={replay ? undefined : connection} tools={replay ? undefined : settingsTools} replay={replay != null} />}
              onSelect={ui.setPane}
              onClose={() => drawer.close(true)}
              onKeyDown={drawer.onKeyDown}
            />
          </>
        )}
        {hud ? null : promptDockNode}
        <section className={`${roomStyles.boardColumn} ${hud ? styles.hudBoard : ""}`} aria-label="Duel field">
          <div className={roomStyles.board} ref={boardRef} data-duel-board>
            <MoveSourceBoundary events={engine.events} duelKey={session.slug} root={boardRef}>
              <Stage
                controller={controller}
                layout={layout}
                camera={camera.shown}
                wantMode={camera.state.mode}
                locked={camera.locked}
                out={camera.out}
                targetSeat={camera.targetSeat}
                aimSeats={flow.aimSeats}
                placeLabels={placeLabels}
                dispatchCamera={camera.dispatch}
                grid={grid ? gridFocus : undefined}
                gridFinale={grid ? finale.board : undefined}
                hubPlace={hubPlace}
                gridHub={grid && hubOn ? (place) => (
                  <PhaseHub
                    variant={place === "band" ? "band" : "table"}
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
                ) : undefined}
                masterChip={masterChip}
                centerPrompts={plazaHud}
                renderSeatField={(props) => <SeatField {...props} />}
                hub={hubOn && !grid ? (
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
                ) : null}
                fx={
                  <FxBoundary>
                    {/* A replay plays the coin too, passive: it takes no lock and no pointer, so the transport stays usable. */}
                    {fxActive ? <CoinTossFx events={engine.events} duelKey={session.slug} reducedMotion={controller.reducedMotion} passive={replay != null} /> : null}
                    {fxActive ? <DuelFeedback events={engine.events} duelKey={session.slug} soundEnabled={preferences.soundEnabled} soundVolume={preferences.soundVolume} reducedMotion={controller.reducedMotion} /> : null}
                    {fxActive ? <SummonFx events={withDestroyCards(engine.events)} duelKey={session.slug} reducedMotion={controller.reducedMotion} shake={preferences.shake} /> : null}
                    {fxActive ? <MoveFx events={withDestroyCards(engine.events)} duelKey={session.slug} reducedMotion={controller.reducedMotion} /> : null}
                    {fxActive ? <PositionFx events={engine.events} duelKey={session.slug} reducedMotion={controller.reducedMotion} /> : null}
                    {fxActive ? <ChainFx events={withDestroyCards(engine.events)} chain={namedChain} duelKey={session.slug} reducedMotion={controller.reducedMotion} mySeat={viewerSeat} playerName={nameOf} seatTones={seatTones} priority={priority} ended={hasResult} table={format} seats={engine.seats} promptOpen={promptMine && ownPromptOpen(prompt, viewerSeat)} /> : null}
                    {fxActive ? <MasterReturnFx events={engine.events} seats={engine.seats} duelKey={session.slug} reducedMotion={controller.reducedMotion} mySeat={viewerSeat} /> : null}
                    <BattleFx events={withDestroyCards(engine.events)} seats={engine.seats} reducedMotion={controller.reducedMotion} active={fxActive} aim={null} nameOf={nameOf} />
                    <DestroyFx events={withDestroyCards(engine.events)} reducedMotion={controller.reducedMotion} active={fxActive} mySeat={viewerSeat ?? 0} />
                  </FxBoundary>
                }
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
                    chain={namedChain}
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
                    {out.length > 0 ? (
                      <ul className={styles.outNote} aria-label="Duelists who left">
                        {out.map((entry) => (
                          <li key={entry.seat} data-testid="seat-out" data-you={entry.seat === viewerSeat} data-fresh={outAtOpen.has(entry.seat) ? undefined : "true"} style={{ "--seat-main": toneOf(entry.seat).main, "--seat-ink": toneOf(entry.seat).ink } as CSSProperties}>
                            <i aria-hidden="true" />
                            {entry.seat === viewerSeat ? "You are out" : `${nameOf(entry.seat)} is out`}
                            <b>{placeLabel(entry.place)}</b>
                            {entry.seat === viewerSeat ? <em data-testid="self-eliminated" aria-hidden="true">You are eliminated.</em> : null}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                    {viewerEliminated ? (
                      <span className={styles.spectating} data-testid="spectating-chip" data-fresh={viewerSeat != null && outAtOpen.has(viewerSeat) ? undefined : "true"} aria-hidden="true">
                        <Eye size={14} strokeWidth={1.75} aria-hidden /> Spectating
                      </span>
                    ) : null}
                    {grid ? null : plazaHud ? <CameraControls {...cameraProps} variant="stage" /> : <CameraControls {...cameraProps} variant={narrow && masterRail ? "stage" : "float"} view={narrow ? undefined : { open: drawer.viewOpen }} />}
                    {ui.pile ? (
                      <PileViewer
                        title={ui.pile.title}
                        owner={ui.pile.owner}
                        ownerTag={pileSeat != null ? { name: nameOf(pileSeat), tone: toneOf(pileSeat) } : null}
                        open={ui.pile.open}
                        cards={livePileCards(ui.pile, engine, viewerSeat)}
                        onClose={ui.closePile}
                        onInspectCard={(card) => inspectCard({ type: "card", card })}
                        onHoverCard={(card) => { if (ui.pane === "card") ui.setInspect({ type: "card", card }); }}
                        onActivateCard={onInspectorActivate}
                        legalKeys={controller.legalKeys}
                        selectedKeys={controller.selectedKeys}
                        reducedMotion={controller.reducedMotion}
                      />
                    ) : null}
                  </>
                }
              />
            </MoveSourceBoundary>
          </div>
        </section>
      </div>
      {hud ? (
        <div className={hudStyles.corner} data-testid="hud-corner" style={replay ? ({ "--hud-corner-w": "min(380px, 34vw)" } as CSSProperties) : undefined}>
          {replay ? <div className={styles.replayCorner} data-testid="replay-transport">{replay.transport}</div> : promptDockNode}
          <StationTrack
            {...trackProps}
            phases="hub"
            compact
            clock={null}
            attackLock={attackLockAt(format, engine.seats.length, engine.turn, engine.prompt)}
          />
        </div>
      ) : (
        <>
        {replay ? <div className={styles.replayBar} data-testid="replay-transport">{replay.transport}</div> : null}
        <div className={roomStyles.track}>
          {narrow ? seatStripNode : null}
          <StationTrack
            {...trackProps}
            seatSlot={narrow ? undefined : seatStripNode}
            seatSlotCount={engine.seats.length}
            phases={hubOn ? "hub" : "bar"}
            clock={null}
            attackLock={attackLockAt(format, engine.seats.length, engine.turn, engine.prompt)}
          />
        </div>
        </>
      )}
      {hud ? (
        <HudLayer
          hud={hudState}
          panels={{
            card: cardPanel,
            log: logPanel,
            settings: <TableSettings controller={controller} preferences={preferences} connection={replay ? undefined : connection} tools={replay ? undefined : settingsTools} replay={replay != null} />,
            camera: plazaHud ? <CameraControls {...cameraProps} variant="panel" view={{ open: true }} /> : undefined,
          }}
          chain={engine.chain}
          chainOpen={chainOpen}
          nameOf={nameOf}
          seatTones={seatTones}
          logUnread={logUnread}
          master={domain ? {
            ...hudMasterProps(
              { legalKeys: controller.legalKeys, selectedKeys: controller.selectedKeys, canAct, prompt, onAnswer: controller.onAnswer, onActivate: controller.onActivate, onHoverCard: controller.onHoverCard },
              engine.seats.find((seat) => seat.seat === (viewerSeat ?? layout.anchorSeat)),
              !spectator,
              spectator ? `${nameOf(layout.anchorSeat)}'s Master` : "Your Master",
            ),
            wide: plazaHud,
          } : null}
          onInspect={ui.setInspect}
          preview={hudPreview(ui.hover?.card ?? null, ui.menu?.card, rowPreview.card, (card) => ({ name: nameOf(card.controller), ...toneOf(card.controller) }), hudState.pinned)}
          equipLinks={resolveEquipLinks(engine.seats)}
          previewHidden={ui.pile?.open === true}
          reducedMotion={controller.reducedMotion}
        />
      ) : null}
      {narrow ? <TablePhonePanes domain={domain} pane={ui.pane} open={sheetOpen} unread={logUnread}
        onClose={() => setSheetOpen(false)} onSelect={(pane) => { ui.setPane(pane); setSheetOpen(true); }}
        card={cardPanel} log={logPanel}
        settings={<TableSettings controller={controller} preferences={preferences} connection={replay ? undefined : connection} tools={replay ? undefined : settingsTools} replay={replay != null} />}
        masters={masterRail} /> : null}
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
      {showResult ? (
        <DuelResultScreen
          room={room}
          slug={session.slug}
          reducedMotion={controller.reducedMotion}
          soundEnabled={preferences.soundEnabled}
          onClose={() => setHideResult(true)}
          onExit={() => actions?.onExit?.()}
          onSeriesChanged={() => actions?.onSeriesChanged?.()}
          onNavigate={(next) => actions?.onNavigate?.(next)}
          placings={standings.map((entry) => ({ seat: entry.seat, place: entry.place, label: placeLabel(entry.place) }))}
        />
      ) : null}
      {replay ? null : modals}
    </div>
  );
}
