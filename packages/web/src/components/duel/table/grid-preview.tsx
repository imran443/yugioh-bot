"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { X } from "lucide-react";
import type { DuelCard, DuelCardInfo } from "@yugidraft/shared/duels";
import { cardTextStyle, useCardTextSize } from "../card-text-size";
import { NEGATED_LINE } from "../inspector";
import { cardArtUrl, cardDetailsText, cardStatsText, isDefenseAt, isHiddenCard } from "../constants";
import styles from "./grid-hud.module.css";
import { coveredArea, measureObstacles, obstaclesKey, peekPlaces, type Box, type Place } from "./peek-layout";

/** The preview lingers this long after the pointer leaves, so a move between two cards does not flicker. */
export const PREVIEW_HIDE_MS = 220;
/** The art is dropped when a long text squeezes it under this height. */
const MIN_ART_PX = 90;
/** How often a pinned panel looks at the clicked card, the board and the parts it stays clear of: a camera move or a prompt can change them with no event. */
const WATCH_MS = 150;
/** A hover panel with no chain panel or chain tower on screen checks this many times less often (the pin keeps the fast check). */
const IDLE_WATCH_EVERY = 4;
const FIRST_PLACE: Place = { side: "left", width: 284, top: 0, maxH: 0 };
/** Is rank `a` better than rank `b`: the first number that differs decides, the smaller wins. */
const before = (a: readonly number[], b: readonly number[]) => {
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return a[i] < b[i];
  return false;
};
const place = (aside: HTMLElement, spot: Place, layer: Box | null) => {
  // `layer` is null when it cannot be measured (no layout): the CSS places the panel then.
  if (layer != null && spot.maxH > 0) {
    aside.style.setProperty("--pv-bottom", `${Math.round(layer.bottom - (spot.top + spot.maxH))}px`);
    aside.style.setProperty("--pv-max-h", `${Math.round(spot.maxH)}px`);
    aside.style.setProperty("--pv-w", `${spot.width}px`);
    aside.setAttribute("data-anchor", "bottom");
  } else {
    for (const name of ["--pv-bottom", "--pv-max-h", "--pv-w"]) aside.style.removeProperty(name);
    aside.removeAttribute("data-anchor");
  }
  aside.setAttribute("data-side", spot.side);
};

/**
 * The hover preview of the table shells (Tag, 3-way, 4-way): a 220-320 px wide panel that slides out from the left edge while a card is hovered or
 * focused (card, name, type, ATK/DEF, owner, effect text). It takes no pointer events, so it never blocks the board.
 * The text size follows the "Text size" setting. The panel grows taller with it (not wider): the art shrinks first (down
 * to nothing), so the whole effect text shows at normal card lengths. A text that is still longer scrolls inside the panel:
 * only then the text takes the pointer (a wheel scroll), and the pointer on it keeps the panel open.
 * Face-down cards of a rival show nothing.
 * A click on a board card pins the panel (`pinned`): the same window in the same place, with the same size and layout. It only freezes: it stays when
 * the pointer leaves, until `onClose` (the X button, Esc, a press outside, or a click on another card, which pins that one), and it adds the
 * X button, the extra lines of the card and the pointer (a click on the panel never reaches a card under it).
 * The window always stands in the same column at the left edge, right of the icon dock (the shells keep the board clear of it, `--pv-col-w` in
 * grid-hud.module.css), on the bottom of a free band of that column: below the chain tower, above the Deck Master plate, clear of the dock, the chain
 * panel and the controls. It never goes to the other side. When the column is cut into short bands, the best one wins (the clicked card, the parts
 * kept clear and the board first).
 */
export function GridHoverPreview({ card, owner, reducedMotion, pinned = false, extras = [], avoid = null, onClose }: {
  /** A board card, or the card of a prompt row (`DuelCardInfo`: no position, no owner). */
  card: DuelCard | DuelCardInfo | null;
  owner: { name: string; main: string; ink: string } | null;
  reducedMotion: boolean;
  /** `card` is the pinned card: the same window, frozen, with a close button. */
  pinned?: boolean;
  /** The extra lines of a pinned board card (equip link, counters, materials): the same ones as the Card flyout. */
  extras?: readonly string[];
  /** The element that was clicked to pin the card: the pinned panel moves aside when it would cover it. */
  avoid?: HTMLElement | null;
  /** The X button was pressed. `byKeyboard`: Enter or Space, so focus should go back to the card (a mouse click would show the card's hover peek again). */
  onClose?: (byKeyboard: boolean) => void;
}) {
  const textSize = useCardTextSize();
  const showable = card != null && !isHiddenCard(card) && card.code != null ? card : null;
  // The last card stays on screen during the hide delay, so the panel slides out with its content.
  const [shown, setShown] = useState<DuelCard | DuelCardInfo | null>(null);
  const [open, setOpen] = useState(false);
  // The layout of the shown card: the panel keeps it while it slides out, so it does not narrow on the way.
  const [shownPinned, setShownPinned] = useState(false);
  // The pointer is on the scrolling text: the panel stays while the viewer reads.
  const [held, setHeld] = useState(false);
  useEffect(() => {
    if (showable) {
      setShown(showable);
      setShownPinned(pinned);
      setOpen(true);
      return;
    }
    if (held) return;
    const timer = window.setTimeout(() => setOpen(false), PREVIEW_HIDE_MS);
    return () => window.clearTimeout(timer);
  }, [showable, held, pinned]);
  const current = showable ?? shown;
  // Does the effect text reach past its area? Then it scrolls and takes the pointer. Measured again when the panel resizes.
  const asideRef = useRef<HTMLElement>(null);
  const textRef = useRef<HTMLParagraphElement>(null);
  const [cut, setCut] = useState(false);
  // The art gives way to a long text. When it is squeezed to a sliver it goes away for this card (a new card or size shows it again).
  const artKey = current ? `${current.code}:${textSize}` : "";
  const [squeezed, setSqueezed] = useState("");
  useLayoutEffect(() => {
    const text = textRef.current;
    if (!text) { setCut(false); return; }
    const measure = () => {
      setCut(text.scrollHeight - text.clientHeight > 1);
      const art = asideRef.current?.querySelector("img");
      if (art && art.clientHeight > 0 && art.clientHeight < MIN_ART_PX) setSqueezed(artKey);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(text);
    if (asideRef.current) observer.observe(asideRef.current);
    return () => observer.disconnect();
  }, [current, textSize, artKey]);
  const frozen = showable ? pinned : shownPinned;
  // Where the panel stands: the same for hover and pin (a click adds the clicked card to the check, which the hover place passes already).
  // The first place of the left edge and the right edge that keeps clear of the clicked card, the chain tower, the Deck Master plates,
  // the dock, the controls and the board; with none, the one that covers least. It is placed again when the card or the window changes.
  const [spot, setSpot] = useState<Place>(FIRST_PLACE);
  // A squeeze seen in a transient place (the CSS default before the first placement, a band that a camera move closes) must not hide the art for
  // good: the art shows again in a new place, and it is measured again there.
  useEffect(() => { setSqueezed(""); }, [spot.top, spot.maxH, spot.width]);
  const [resizeTick, setResizeTick] = useState(0);
  // What the placement saw last: the clicked card, the board and the parts kept clear. A change (a camera move, a chain that opens, a prompt)
  // places a pinned panel again (a hover panel is placed again by its next card).
  const watched = useRef("");
  // The place of the last hover panel: a click keeps it (the extra lines of the pin make the panel taller, and that must not pick another band).
  const hoverSpot = useRef<{ key: string; place: Place } | null>(null);
  const watch = useCallback(() => {
    const card = avoid?.isConnected ? avoid.getBoundingClientRect() : null;
    return `${card ? [card.left, card.top, card.width, card.height].map(Math.round).join(",") : ""}|${obstaclesKey(measureObstacles(asideRef.current, frozen))}`;
  }, [avoid, frozen]);
  const placing = open && current != null;
  // A hover panel watches too: a chain panel that folds or opens (a prompt comes and goes) must not leave it on the old room or under that panel.
  // The check reads many boxes, so a hover panel runs it at full speed only while a chain panel or tower is shown (the observer below covers
  // its fold) and slowly otherwise; a pinned panel always runs it at full speed.
  useEffect(() => {
    if (!placing) return;
    const again = () => setResizeTick((tick) => tick + 1);
    let ticks = 0;
    const timer = window.setInterval(() => {
      ticks += 1;
      if (!frozen && ticks % IDLE_WATCH_EVERY !== 0 && !document.querySelector('[data-chain-panel], [data-testid="chain-tower"]')) return;
      if (watch() !== watched.current) again();
    }, WATCH_MS);
    window.addEventListener("resize", again);
    return () => { window.clearInterval(timer); window.removeEventListener("resize", again); };
  }, [placing, frozen, watch]);
  // The chain panel changes its height while it folds (a transition): the panel is placed again on each step, not only when the fold is over.
  useEffect(() => {
    if (!placing || typeof ResizeObserver === "undefined") return;
    // An observer reports each node once when it starts: only a size that differs from the last one places the panel again.
    const seen = new Map<Element, string>();
    const observer = new ResizeObserver((entries) => {
      let changed = false;
      for (const entry of entries) {
        const size = `${Math.round(entry.contentRect.width)}x${Math.round(entry.contentRect.height)}`;
        if (seen.has(entry.target) && seen.get(entry.target) !== size) changed = true;
        seen.set(entry.target, size);
      }
      if (changed) setResizeTick((tick) => tick + 1);
    });
    for (const node of Array.from(document.querySelectorAll("[data-chain-panel]"))) if (!asideRef.current?.contains(node)) observer.observe(node);
    return () => observer.disconnect();
  }, [placing, resizeTick]);
  useLayoutEffect(() => {
    const aside = asideRef.current;
    if (!aside || !placing) return;
    const target = frozen && avoid?.isConnected ? avoid.getBoundingClientRect() : null;
    const hasTarget = target != null && target.width > 0 && target.height > 0;
    const parent = (aside.offsetParent ?? document.body).getBoundingClientRect();
    // The part of the layer inside the window (jsdom has no window width: the whole layer then).
    const windowRight = document.documentElement.clientWidth;
    const layer: Box = { left: parent.left, top: parent.top, right: windowRight > 0 ? Math.min(parent.right, windowRight) : parent.right, bottom: parent.bottom };
    const measured = parent.height > 0 ? layer : null;
    const obstacles = measureObstacles(aside, frozen);
    const text = textRef.current;
    const candidates = peekPlaces(layer, obstacles);
    if (candidates.length === 0) {
      // Nothing to measure (no layout yet): the CSS places the panel.
      place(aside, FIRST_PLACE, null);
      watched.current = watch();
      setSpot((previous) => (previous === FIRST_PLACE ? previous : FIRST_PLACE));
      return;
    }
    let chosen = candidates[0];
    let best: number[] | null = null;
    // The first place of a pin is the place of the hover of that card: a click never moves the window. Later places (a chain that opens) rank again.
    const key = `${current?.code}-${current?.name}`;
    const rectNow = (): Box => ({
      left: parent.left + aside.offsetLeft,
      top: parent.top + aside.offsetTop,
      right: parent.left + aside.offsetLeft + aside.offsetWidth,
      bottom: parent.top + aside.offsetTop + aside.offsetHeight,
    });
    const clickedCover = (rect: Box) => (hasTarget ? coveredArea(rect, [{ left: target.left, top: target.top, right: target.right, bottom: target.bottom }]) : 0);
    const hovered = frozen && hoverSpot.current?.key === key
      ? candidates.find((c) => c.side === hoverSpot.current?.place.side && c.top === hoverSpot.current.place.top && c.maxH === hoverSpot.current.place.maxH && c.width === hoverSpot.current.place.width)
      : undefined;
    if (frozen) hoverSpot.current = null;
    // It stays only when it covers neither the clicked card (on a narrow screen the hover place may) nor a part that a pin keeps clear
    // (a life-point plate): then the places are ranked as before.
    if (hovered) place(aside, hovered, measured);
    const kept = hovered && clickedCover(rectNow()) === 0 && coveredArea(rectNow(), obstacles.keep) === 0 ? hovered : undefined;
    if (kept) chosen = kept;
    for (const candidate of kept ? [] : candidates) {
      place(aside, candidate, measured);
      const rect = rectNow();
      // Ranked in this order: 1. the panel itself cut off (the name, type, stats, owner line and 3 lines of text must fit: a short band that
      // clips them is used only when no band fits, and then the pin covers the clicked card), 2. the clicked card, 3. the parts kept clear,
      // 4. the effect text that is cut off, 5. the board (a rival field that reaches into the column loses its outer edge under the panel:
      // that is less bad than a panel that jumps down the column and cuts the text). The panel never goes to the other side.
      const clipped = Math.max(0, aside.scrollHeight - aside.clientHeight - 1);
      const clicked = clickedCover(rect);
      const keep = coveredArea(rect, obstacles.keep);
      const board = coveredArea(rect, obstacles.board);
      const hidden = text ? Math.max(0, text.scrollHeight - text.clientHeight - 1) : 0;
      const rank = [clipped, clicked, keep, hidden, board];
      if (best == null || before(rank, best)) {
        best = rank;
        chosen = candidate;
      }
      if (clipped === 0 && clicked === 0 && keep === 0 && board === 0 && hidden === 0) break;
    }
    place(aside, chosen, measured);
    if (!frozen) hoverSpot.current = { key, place: chosen };
    watched.current = watch();
    setSpot((previous) => (previous.side === chosen.side && previous.width === chosen.width && previous.top === chosen.top && previous.maxH === chosen.maxH ? previous : chosen));
  }, [placing, frozen, avoid, current, textSize, resizeTick, watch]);
  if (!current) return null;

  const stats = cardStatsText(current);
  const details = cardDetailsText(current);
  const position = stats && "location" in current && current.position != null ? (isDefenseAt(current.location, current.position) ? "Defense Position" : "Attack Position") : null;
  return (
    <aside
      ref={asideRef}
      className={styles.preview}
      data-testid="hover-preview"
      data-open={open ? "true" : "false"}
      data-motion={reducedMotion ? "none" : "slide"}
      aria-hidden={open ? undefined : "true"}
      data-pinned={frozen ? "true" : undefined}
      data-side={spot.side}
      data-hud-keep={frozen ? "" : undefined}
      aria-label={frozen ? "Pinned card" : undefined}
      data-card-text={textSize}
      data-squeezed={squeezed === artKey ? "true" : undefined}
      style={{ ...cardTextStyle(textSize), ...(owner ? { "--seat-main": owner.main, "--seat-ink": owner.ink } : null) } as CSSProperties}
    >
      {current.code != null ? <img className={styles.previewArt} src={cardArtUrl(current.code, "full")} alt="" draggable={false} /> : null}
      <div className={styles.previewBody}>
        <h3>{current.name ?? `Card ${current.code}`}</h3>
        {details ? <p className={styles.previewType}>{details}</p> : null}
        {stats ? <p className={styles.previewStats}>{stats}</p> : null}
        {current.description ? (
          <p
            key={`${current.code}-${current.name}`}
            ref={textRef}
            className={styles.previewText}
            data-overflow={cut ? "true" : undefined}
            onPointerEnter={() => setHeld(true)}
            onPointerLeave={() => setHeld(false)}
          >
            {current.description}
          </p>
        ) : null}
        {owner ? (
          <p className={styles.previewOwner}>
            <i aria-hidden="true" />Owner <b>{owner.name}</b>{position ? ` · ${position}` : ""}
          </p>
        ) : position ? <p className={styles.previewOwner}>{position}</p> : null}
        {extras.length > 0 ? (
          <ul className={styles.previewExtras} data-testid="hover-preview-extras">
            {extras.map((line) =>
              line === NEGATED_LINE ? (
                <li key={line} className={styles.previewNegated} data-negated="true" data-testid="inspector-negated">
                  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="8.6" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
                  {line}
                </li>
              ) : <li key={line}>{line}</li>,
            )}
          </ul>
        ) : null}
      </div>
      {frozen ? (
        <button type="button" className={styles.previewClose} aria-label={`Close ${current.name ?? `Card ${current.code}`} preview`} data-testid="hover-preview-close" onClick={(event) => onClose?.(event.detail === 0)}>
          <X size={16} strokeWidth={1.75} aria-hidden />
        </button>
      ) : null}
    </aside>
  );
}
