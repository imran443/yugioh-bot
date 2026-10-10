"use client";

import { useLayoutEffect, useRef, type CSSProperties, type RefObject } from "react";
import type { DuelCard, DuelCardInfo } from "@yugidraft/shared/duels";
import { CardBack } from "./card-face";
import { hasCardName, useDuelCardInfo } from "./card-info";
import { cardTextStyle, useCardTextSize } from "./card-text-size";
import {
  cardArtUrl,
  cardCombatText,
  cardDetailsText,
  cardKindText,
  isHiddenCard,
} from "./constants";
import { equipSentence, roleOfCard, type EquipLinks } from "./equip-links";
import baseStyles from "./inspector.module.css";
import { useSkinStyles } from "./skin";

export type InspectTarget =
  | { type: "card"; card: DuelCard }
  | { type: "info"; card: DuelCardInfo }
  | { type: "pile"; title: string; cards: DuelCard[] };

/**
 * Mark the scroller that holds the Card tab when it shows the card pane. Its bottom rows then fade while the text has more to read
 * (see globals.css). A scroller without the mark (the phone Sheet, which paints its own background and edge) gets no fade. Pass
 * `active` as "the card pane is the one shown". The card text itself makes the scroller focusable (see useScrollCue), so an empty
 * Card tab is not a tab stop.
 */
export function cardScrollerProps(active: boolean): { "data-card-scroller"?: "" } {
  return active ? { "data-card-scroller": "" } : {};
}

/**
 * Keep `data-card-more` on the marked scroller up to date: "true" while the text runs past its bottom edge, "false" at the end or when
 * it all fits. The fade itself is CSS. The layout effect runs before the first paint, so there is no frame without the fade. While a
 * card shows, the scroller is a tab stop, so Safari can scroll it with the arrow keys.
 */
function useScrollCue(root: RefObject<HTMLElement | null>, shown: boolean, key: string | undefined) {
  // The tab stop depends only on "a face-up card shows", so a card change does not drop it (and the focus with it).
  useLayoutEffect(() => {
    const scroller = root.current?.closest<HTMLElement>("[data-card-scroller]") ?? null;
    if (!scroller || scroller.hasAttribute("tabindex")) return;
    scroller.tabIndex = 0;
    return () => scroller.removeAttribute("tabindex");
  }, [root, shown]);
  useLayoutEffect(() => {
    const node = root.current;
    const scroller = node?.closest<HTMLElement>("[data-card-scroller]") ?? null;
    if (!node || !scroller) return;
    let more: boolean | null = null;
    const update = () => {
      const next = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight > 2;
      if (next === more) return;
      more = next;
      scroller.dataset.cardMore = next ? "true" : "false";
    };
    update();
    scroller.addEventListener("scroll", update, { passive: true });
    const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    resize?.observe(scroller);
    resize?.observe(node);
    // A line that arrives late (the owner, the meta list, a card lookup) grows the text inside a box of fixed size, which no resize reports.
    // Log rows in the same scroller mutate it often, so many mutations share one check per frame.
    let frame = 0;
    const later = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => { frame = 0; update(); });
    };
    const mutations = typeof MutationObserver === "undefined" ? null : new MutationObserver(later);
    mutations?.observe(scroller, { childList: true, subtree: true, characterData: true });
    return () => {
      scroller.removeEventListener("scroll", update);
      resize?.disconnect();
      mutations?.disconnect();
      if (frame) cancelAnimationFrame(frame);
      delete scroller.dataset.cardMore;
    };
  }, [root, key]);
}

function InfoBody({ card: liveCard }: { card: DuelCard | DuelCardInfo }) {
  const styles = useSkinStyles(baseStyles, "inspector");
  const textSize = useCardTextSize();
  const textStyle = cardTextStyle(textSize);
  const rootRef = useRef<HTMLDivElement>(null);
  const code = liveCard.code;
  const hidden = isHiddenCard(liveCard) || code == null;
  const resolved = useDuelCardInfo(!hidden && (!hasCardName(liveCard) || !liveCard.description?.trim()) ? code : null);
  // Fill static text while retaining ATK/DEF, counters and other live fields.
  const card = resolved ? {
    ...resolved, ...liveCard,
    canonicalPasscode: liveCard.canonicalPasscode ?? resolved.canonicalPasscode,
    type: liveCard.type ?? resolved.type,
    attack: liveCard.attack ?? resolved.attack,
    defense: liveCard.defense ?? resolved.defense,
    level: liveCard.level ?? resolved.level,
    attribute: liveCard.attribute ?? resolved.attribute,
    race: liveCard.race ?? resolved.race,
    name: hasCardName(liveCard) ? liveCard.name : resolved.name,
    description: liveCard.description?.trim() ? liveCard.description : resolved.description,
  } : liveCard;
  useScrollCue(rootRef, !hidden, `${code}-${hidden}-${card.description?.length ?? 0}-${textSize}`);
  if (hidden) {
    return (
      <div className={styles.root} data-card-text={textSize} style={textStyle}>
        <div className={`${styles.art} card-frame`}>
          <CardBack className={styles.artBack} />
        </div>
        <p className={styles.details}>Face-down card.</p>
      </div>
    );
  }

  const details = cardDetailsText(card);
  const kind = cardKindText(card);
  const combat = cardCombatText(card);
  const description = card.description?.trim() ?? "";

  return (
    <div ref={rootRef} className={styles.root} data-header="side" data-card-text={textSize} style={textStyle}>
      <div className={`${styles.art} card-frame`}>
        <img src={cardArtUrl(code, "full")} alt="" />
      </div>
      <div className={styles.body}>
        <h2 className={styles.name}>{card.name ?? `Card ${card.code}`}</h2>
        {details || (kind && kind !== details) || combat ? (
          <div className={styles.facts}>
            {details ? <p className={styles.details}>{details}</p> : null}
            {kind && kind !== details ? <p className={styles.kind}>{kind}</p> : null}
            {combat ? <p className={styles.combat}>{combat}</p> : null}
          </div>
        ) : null}
        {description ? <p className={styles.text}>{description}</p> : null}
      </div>
    </div>
  );
}

/** The extra line of a face-up board card whose effects are negated (the server sets `negated`). */
export const NEGATED_LINE = "Effects negated";

/** The extra lines of a board card: negation, its equip link, counters and Xyz materials. The Card flyout and the pinned peek both show them. */
export function cardExtraLines(card: DuelCard, equipLinks?: EquipLinks): string[] {
  const extras: string[] = [];
  if (card.negated === true) extras.push(NEGATED_LINE);
  const equipText = equipLinks ? equipSentence(roleOfCard(equipLinks, card)) : null;
  if (equipText) extras.push(equipText);
  if (card.counters?.length) {
    for (const counter of card.counters) {
      extras.push(`Counter ${counter.type}: ${counter.count}`);
    }
  }
  if (card.materials?.length) {
    extras.push(
      `Materials: ${card.materials
        .map((material) => (material.code == null ? "face-down" : (material.name ?? `Card ${material.code}`)))
        .join(", ")}`,
    );
  }
  return extras;
}

/** The seat that owns a card, for tables of 3 or more seats: the inspector adds an "Owner" line in the seat colour. */
export type InspectorOwner = { name: string; tone: { main: string; ink: string } };

export function CardInspector({
  target,
  onInspectCard,
  onActivateCard,
  equipLinks,
  ownerOf,
}: {
  target: InspectTarget | null;
  onInspectCard?: (card: DuelCard) => void;
  onActivateCard?: (card: DuelCard, anchor: HTMLElement) => void;
  /** The equip links of the live board: adds "Equipped to ..." / "Equipped with ..." for a card on the field. */
  equipLinks?: EquipLinks;
  /** 3 and 4 seat tables: who owns the card shown. Absent: no owner line (1v1). */
  ownerOf?: (card: DuelCard) => InspectorOwner | null;
}) {
  const styles = useSkinStyles(baseStyles, "inspector");
  const textSize = useCardTextSize();
  const textStyle = cardTextStyle(textSize);
  if (!target) {
    return <div className={styles.empty} style={textStyle}>Select a card to inspect.</div>;
  }

  if (target.type === "pile") {
    return (
      <div className={styles.root} data-card-text={textSize} style={textStyle}>
        <h2 className={styles.pileTitle}>{target.title}</h2>
        {target.cards.length === 0 ? (
          <p className={styles.details}>Empty.</p>
        ) : (
          <ul className={styles.pileGrid}>
            {target.cards.map((card, index) => {
              const hidden = isHiddenCard(card);
              const label = hidden ? "Face-down card" : (card.name ?? `Card ${card.code}`);
              return (
                <li key={`${card.controller}-${card.location}-${card.sequence}-${index}`}>
                  <button
                    type="button"
                    className={styles.pileCard}
                    aria-label={label}
                    onClick={(event) => {
                      if (onActivateCard) onActivateCard(card, event.currentTarget);
                      else onInspectCard?.(card);
                    }}
                  >
                    {hidden || card.code == null ? (
                      <CardBack />
                    ) : (
                      <img src={cardArtUrl(card.code, "small")} alt="" draggable={false} />
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    );
  }

  if (target.type === "info") {
    return <InfoBody card={target.card} />;
  }

  const extras = cardExtraLines(target.card, equipLinks);

  const owner = ownerOf?.(target.card) ?? null;
  return (
    <>
      <InfoBody card={target.card} />
      {owner ? (
        <p
          className={styles.owner}
          data-testid="inspector-owner"
          style={{ ...textStyle, "--seat-main": owner.tone.main, "--seat-ink": owner.tone.ink } as CSSProperties}
        >
          <i aria-hidden="true" />
          Owner <b>{owner.name}</b>
        </p>
      ) : null}
      {extras.length > 0 ? (
        <ul className={styles.metaList} style={textStyle}>
          {extras.map((line) =>
            line === NEGATED_LINE ? (
              <li key={line} className={styles.negatedLine} data-negated="true" data-testid="inspector-negated">
                <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                  <circle cx="12" cy="12" r="8.6" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
                {line}
              </li>
            ) : (
              <li key={line}>{line}</li>
            ),
          )}
        </ul>
      ) : null}
    </>
  );
}
