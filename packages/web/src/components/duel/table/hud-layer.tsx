"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type FocusEvent, type MouseEvent, type ReactNode } from "react";
import type { DuelCard, DuelCardInfo, DuelChainLink, DuelPromptOption, DuelSeatView } from "@yugidraft/shared/duels";
import type { DuelHoverHandler } from "../field-keys";
import { ChainTower, DOCK_PANES, DOCK_PANES_CAMERA, GridDock, GridFlyout, useHudDismiss, type DockPane, type HudPane } from "./grid-hud";
import { GridMasterToken } from "./grid-master";
import { LOCATION_HAND } from "../constants";
import type { EquipLinks } from "../equip-links";
import { cardExtraLines } from "../inspector";
import { GridHoverPreview } from "./grid-preview";
import type { DuelActivateHandler, InspectTarget } from "./types";

/**
 * The floating HUD that the 4-way grid, the 1v1 room and the Tag Rooftop share (concept B): which flyout is open, and
 * the layer of dock, chain tower, Deck Master token, flyout and hover preview. The shells keep their own bars, boards
 * and panes; they only feed this layer their real panels and duel data.
 */

/** The Log pane stays mounted while hidden, so its rows and its unread count survive a close. So does the Camera pane of the Tag Rooftop: its lock state and seat buttons stay live. */
export const HUD_KEEP: readonly HudPane[] = ["log", "camera"];

export interface HudPaneState {
  pane: HudPane | null;
  setPane: (pane: HudPane | null) => void;
  toggle: (pane: HudPane) => void;
  /** Closes the open flyout and the pinned peek. */
  close: () => void;
  /** Opens the Card flyout: Inspect on a plate or a log row. A click on a board card pins it instead (`pinCard`). */
  openCard: () => void;
  /** The board card pinned in the left peek, or `null`. It never shows together with a flyout. */
  pinned: DuelCard | null;
  /** The element that was clicked to pin it (the peek keeps clear of it, and focus returns to it). */
  pinAnchor: HTMLElement | null;
  /** A click on a board card pins it in the peek (another card moves the pin); `null` lets the pin go (a flyout stays). A face-down card has no peek: it opens the Card flyout. */
  pinCard: (card: DuelCard | null, anchor?: HTMLElement | null) => void;
  /** Takes the fresh copy of the pinned card from the board, or lets the pin go when the card is gone (see `usePinSync`). */
  syncPin: (seats: readonly DuelSeatView[]) => void;
  /** Counts every change of the pane or the pin: a press on a zone that changes nothing by its click lets the pin go (see `useHudEscape`). */
  epoch: () => number;
  /** The Card tab only shows while it is the open pane: it is not a dock icon. */
  tabs: readonly HudPane[];
  /** The dock icons, in order. */
  dock: readonly DockPane[];
}

const PIN_ZONES = (seat: DuelSeatView): Array<DuelCard | null> => [...seat.hand, ...seat.extra, ...seat.monsters, ...seat.spells, ...seat.graveyard, ...seat.banished];

/**
 * The open flyout of a HUD. Nothing opens it by itself: a dock icon, a Deck Master token or `openCard()` (a click or
 * Inspect on a card) does. A hover or a prompt row never opens the Card flyout, so it cannot cover the response prompt.
 * Call it before `useTableUi`, then pass `openCard` on and give `useHudEscape` the table's `suspended` flag.
 */
export function useHudPane({ camera = false, log = true, initialPane = null }: {
  /** The table has a camera panel (the Tag Rooftop, the 3-way plaza): the dock gets a camera icon. */
  camera?: boolean;
  /** The dock has the Log icon. Every table has it; only a HUD with no log panel turns it off. */
  log?: boolean;
  /** The flyout that is open at mount. A replay seek remounts the table and brings back the one the viewer had open. */
  initialPane?: HudPane | null;
} = {}): HudPaneState {
  const [pane, setPaneState] = useState<HudPane | null>(initialPane ?? null);
  // `handSize`: the hand of the pinned card as the last sync saw it, so a shifted sequence can be told from another copy.
  const [pin, setPin] = useState<{ card: DuelCard; anchor: HTMLElement | null; handSize?: number } | null>(null);
  const epochRef = useRef(0);
  const epoch = useCallback(() => epochRef.current, []);
  // A flyout and the pinned peek never show together: opening one lets the other go.
  const setPane = useCallback((next: HudPane | null) => {
    epochRef.current += 1;
    setPaneState(next);
    if (next != null) setPin(null);
  }, []);
  const toggle = useCallback((next: HudPane) => {
    epochRef.current += 1;
    setPaneState((current) => (current === next ? null : next));
    setPin(null);
  }, []);
  const close = useCallback(() => {
    epochRef.current += 1;
    setPaneState(null);
    setPin(null);
  }, []);
  const openCard = useCallback(() => setPane("card"), [setPane]);
  const pinCard = useCallback((card: DuelCard | null, anchor: HTMLElement | null = null) => {
    epochRef.current += 1;
    if (card == null) {
      setPin(null);
      return;
    }
    if (card.code == null) {
      setPane("card");
      return;
    }
    setPaneState(null);
    setPin({ card, anchor });
  }, [setPane]);
  // A functional update, so a pin that another effect of the same commit just removed (a new prompt) stays removed.
  const syncPin = useCallback((seats: readonly DuelSeatView[]) => {
    setPin((current) => {
      if (!current) return current;
      const was = current.card;
      const same = (card: DuelCard | null): card is DuelCard => card != null && card.code === was.code && card.controller === was.controller && card.location === was.location;
      let live: DuelCard | null = null;
      let handSize: number | undefined;
      if (was.location === LOCATION_HAND) {
        // The hand closes up when a card leaves it: the pinned card keeps its place in the line, but its sequence moves. It is the copy
        // of the same code whose sequence moved by no more than the hand grew or shrank (another copy farther away is not the pinned one).
        // When both cards have a handId, the id decides: a copy with another id is never the pinned card.
        const hand = seats.find((view) => view.seat === was.controller)?.hand ?? [];
        handSize = hand.length;
        const change = handSize - (current.handSize ?? handSize);
        const lo = Math.min(0, change);
        const hi = Math.max(0, change);
        let best = Infinity;
        for (const card of hand) {
          if (!same(card)) continue;
          if (was.handId && card.handId && card.handId !== was.handId) continue;
          const shift = card.sequence - was.sequence;
          if (shift < lo || shift > hi || Math.abs(shift) >= best) continue;
          best = Math.abs(shift);
          live = card;
        }
      } else {
        live = seats.flatMap(PIN_ZONES).find((card) => same(card) && card.sequence === was.sequence) ?? null;
      }
      if (live == null) return null;
      return live === was && handSize === current.handSize ? current : { card: live, anchor: current.anchor, handSize };
    });
  }, []);
  const pinned = pin?.card ?? null;
  const pinAnchor = pin?.anchor ?? null;
  const dock = useMemo<readonly DockPane[]>(() => (camera ? DOCK_PANES_CAMERA : DOCK_PANES).filter((id) => log || id !== "log"), [camera, log]);
  const tabs: readonly HudPane[] = pane === "card" ? ["card", ...dock] : dock;
  return { pane, setPane, toggle, close, openCard, pinned, pinAnchor, pinCard, syncPin, epoch, tabs, dock };
}

/**
 * Esc and a press outside close the open flyout and the pinned peek. A card menu or the pile viewer (`suspended`) keeps Esc, and so does a
 * modal dialog. Pass `hud.pane != null || hud.pinned != null` to the prompt panel's `escapeHeld` as well, or the same Esc also declines the
 * prompt. The other prompt keys keep answering while a flyout is open.
 */
export function useHudEscape(hud: HudPaneState, enabled: boolean, suspended: boolean): void {
  // A press on a board card never lets the pin go at once: the click that follows pins that card, or a prompt takes it and unpins.
  // A press on a zone whose click changes nothing (no handler, a camera drag that starts on a zone) lets it go after that click.
  const pinned = hud.pinned != null;
  const onBoard = useCallback((target: Element | null) => pinned && target?.closest?.("[data-zones]") != null, [pinned]);
  useHudDismiss(enabled && (hud.pane != null || pinned), suspended, hud.close, onBoard);
  const { close, epoch } = hud;
  useEffect(() => {
    if (!enabled || !pinned) return;
    let down: number | null = null;
    let timer: number | undefined;
    const onDown = (event: Event) => {
      const target = event.target as Element | null;
      down = target?.closest?.("[data-hud-keep]") == null && target?.closest?.("[data-zones]") != null ? epoch() : null;
    };
    // Capture phase, then a timer: it runs after the click handlers, even one that stops the event.
    const onClick = () => {
      if (down == null) return;
      const at = down;
      down = null;
      timer = window.setTimeout(() => { if (epoch() === at) close(); }, 0);
    };
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("click", onClick, true);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("click", onClick, true);
      window.clearTimeout(timer);
    };
  }, [enabled, pinned, close, epoch]);
  // The HUD is gone (a narrow window): no flyout or pin waits for the HUD to come back.
  useEffect(() => { if (!enabled) close(); }, [enabled, close]);
}

/**
 * Keeps the pinned card true to the board: at each new revision it finds the card again by its zone and code, and takes
 * the fresh copy (stats, position, counters). A card that left the zone, or turned face-down, lets the pin go.
 */
export function usePinSync(hud: HudPaneState, seats: readonly DuelSeatView[] | undefined): void {
  const { syncPin, pinned } = hud;
  // Runs for a new pin as well: it records the size of the hand that the pin was made in.
  useEffect(() => {
    if (seats) syncPin(seats);
  }, [seats, syncPin, pinned]);
}

/**
 * The card of a prompt row under the pointer or focus (a tile, a response row): the HUD shows it in the hover preview,
 * never in the Card flyout, which would cover the prompt. The prompt panel only reports "entered", so `bind` goes on a
 * wrapper around it (`display: contents`) and clears the card when the pointer or focus leaves the panel.
 * `resetKey` (the prompt id) clears it when the prompt changes.
 */
export function useRowPreview(resetKey: string | number | null) {
  const [card, setCard] = useState<DuelCardInfo | null>(null);
  useEffect(() => setCard(null), [resetKey]);
  const leave = (event: MouseEvent<HTMLElement> | FocusEvent<HTMLElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setCard(null);
  };
  return { card, show: setCard, bind: { onMouseOut: leave, onBlur: leave } };
}

/** Wraps the prompt panel for `useRowPreview`. Without the HUD it renders the children as they are. */
export function RowPreviewBoundary({ row, enabled, children }: { row: ReturnType<typeof useRowPreview>; enabled: boolean; children: ReactNode }) {
  return enabled ? <div style={{ display: "contents" }} {...row.bind}>{children}</div> : <>{children}</>;
}

type SeatTones = ReadonlyMap<number, { main: string; ink: string }>;

export interface HudMasterProps {
  view: DuelSeatView | undefined;
  /** The plate is yours: it offers actions. A spectator's plate only shows the card. */
  local: boolean;
  legalKeys: Set<string>;
  selectedKeys: Set<string>;
  canAct: boolean;
  legalActionsFor: (card: DuelCard | null, keys: string[]) => DuelPromptOption[];
  title: string;
  onChooseAction: (option: DuelPromptOption) => void;
  /** A click on the token picks the card while a prompt asks for it. */
  onActivate?: DuelActivateHandler;
  onHoverCard?: DuelHoverHandler;
  /** The wide plate of the 3-way plaza (grid-master.tsx): the ability text shows, and the plate is the Deck Master Zone anchor. */
  wide?: boolean;
}

export interface HudLayerProps {
  hud: HudPaneState;
  /** The Card panel, Log panel and Settings panel. The dock icons come from `hud.dock`. */
  panels: Pick<Record<HudPane, ReactNode>, "card" | "settings"> & { log?: ReactNode; camera?: ReactNode };
  chain: readonly DuelChainLink[];
  /** A chain is live: the tower shows under the dock. */
  chainOpen: boolean;
  nameOf: (seat: number) => string;
  seatTones: SeatTones;
  logUnread: number;
  /** The Deck Master token (Domain only). `null` hides it. */
  master: HudMasterProps | null;
  /** The second plate: the rival's master in a 1v1 duel, the partner's in a Tag duel. `null` hides it. */
  otherMaster?: HudMasterProps | null;
  /** Shows the Card flyout for the master (Inspect on the plate). */
  onInspect: (target: InspectTarget) => void;
  /** The card for the left peek and its owner, or `null` when there is none. A prompt row card has no owner. `pinned`: it stays until closed. */
  preview: { card: DuelCard | DuelCardInfo; owner: { name: string; main: string; ink: string } | null; pinned?: boolean } | null;
  /** The equip links of the live board: the pinned peek adds the same lines as the Card flyout (equip, counters, materials). */
  equipLinks?: EquipLinks;
  /** The pile viewer is open, or a pick hint is shown: the preview hides. An open card menu does not hide it. */
  previewHidden: boolean;
  reducedMotion: boolean;
}

export function HudLayer({ hud, panels, chain, chainOpen, nameOf, seatTones, logUnread, master, otherMaster = null, onInspect, preview, equipLinks, previewHidden, reducedMotion }: HudLayerProps) {
  const pinnedBoard = preview?.pinned === true && "location" in preview.card ? preview.card : null;
  const extras = useMemo(() => (pinnedBoard ? cardExtraLines(pinnedBoard, equipLinks) : []), [pinnedBoard, equipLinks]);
  // The X button: the pin goes. With the keyboard, focus returns to the card that was clicked (a mouse click would only bring the hover peek back).
  const { close, pinAnchor } = hud;
  const closePin = useCallback((byKeyboard: boolean) => {
    close();
    if (!byKeyboard) return;
    const target = pinAnchor?.isConnected ? (pinAnchor.matches("button, [tabindex]") ? pinAnchor : pinAnchor.querySelector<HTMLElement>("button, [tabindex]")) : null;
    target?.focus({ preventScroll: true });
  }, [close, pinAnchor]);
  return (
    <>
      <GridDock pane={hud.pane} onToggle={hud.toggle} unread={logUnread} panes={hud.dock} />
      {chainOpen ? <ChainTower chain={chain} nameOf={nameOf} tones={seatTones} /> : null}
      {master ? (
        <GridMasterToken
          {...master}
          open={hud.pane === "master"}
          onToggle={() => hud.toggle("master")}
          onClose={hud.close}
          onInspect={(target) => { onInspect(target); hud.setPane("card"); }}
        />
      ) : null}
      {otherMaster ? (
        <GridMasterToken
          {...otherMaster}
          slot="other"
          open={hud.pane === "other"}
          onToggle={() => hud.toggle("other")}
          onClose={hud.close}
          onInspect={(target) => { onInspect(target); hud.setPane("card"); }}
        />
      ) : null}
      <GridFlyout pane={hud.pane} tabs={hud.tabs} panels={panels} keepMounted={HUD_KEEP} onSelect={hud.setPane} onClose={hud.close} chainLive={chainOpen} />
      <GridHoverPreview
        card={hud.pane == null && !previewHidden && preview ? preview.card : null}
        owner={preview?.owner ?? null}
        reducedMotion={reducedMotion}
        pinned={preview?.pinned === true}
        extras={extras}
        avoid={preview?.pinned === true ? hud.pinAnchor : null}
        onClose={closePin}
      />
    </>
  );
}
