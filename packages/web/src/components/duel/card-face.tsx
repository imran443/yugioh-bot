"use client";

import type { DuelCard } from "@yugidraft/shared/duels";
import { cn } from "@/lib/utils";
import {
  cardArtUrl,
  cardStatsText,
  isDefenseAt,
  isFacedown,
  LOCATION_EXTRA,
  LOCATION_HAND,
} from "./constants";
import styles from "./field.module.css";

export function CardBack({
  className,
  kind = "deck",
}: {
  className?: string;
  kind?: "deck" | "extra";
}) {
  return (
    <div
      className={cn(styles.cardBack, kind === "extra" && styles.cardBackExtra, className)}
      data-card-art
      aria-hidden="true"
    />
  );
}

/**
 * The mark of a card whose effects are negated: a slashed circle on a dark disc over the art. It is drawn at a
 * share of the card width so it reads at the smallest compact board size (floor 12px) and stays calm on a big one.
 * The art underneath is dimmed by `[data-negated]` in field.module.css. The name "Effects negated" is the stable
 * hook for tests and screen readers.
 */
export function NegationMark({ className }: { className?: string }) {
  return (
    <svg
      className={cn(styles.negationMark, className)}
      viewBox="0 0 24 24"
      role="img"
      aria-label="Effects negated"
      data-negation-mark
      focusable="false"
    >
      <circle cx="12" cy="12" r="11" className={styles.negationDisc} />
      <circle cx="12" cy="12" r="7.6" className={styles.negationRing} />
      <line x1="6.6" y1="6.6" x2="17.4" y2="17.4" className={styles.negationSlash} />
    </svg>
  );
}

export function CardFace({
  card,
  location,
  sleeve,
  reveal,
  className,
}: {
  card: DuelCard | null;
  location?: number;
  sleeve?: "deck" | "extra";
  /** Show the art whenever the server sent an identity, even if the card is face-down (own Extra Deck, Graveyard). */
  reveal?: boolean;
  className?: string;
}) {
  const loc = location ?? card?.location;
  const known = card?.code != null;
  const setDown = isFacedown(card?.position);
  const inHand = loc === LOCATION_HAND;
  const showArt = known && (inHand || reveal || !setDown);
  const defensePos = isDefenseAt(loc, card?.position);
  const overlays = showArt ? card?.materials?.length ?? 0 : 0;
  // Only a face-up card on the field carries the flag (the server never sets it on a face-down card); the art check keeps it that way here too.
  const negated = showArt && card?.negated === true;

  return (
    <div className={cn(styles.artWrap, className)} data-defense={defensePos ? "true" : "false"} data-negated={negated ? "true" : undefined}>
      {showArt && card?.code != null ? (
        <div className={styles.cardFace} data-card-art data-defense={defensePos ? "true" : "false"}>
          <img src={cardArtUrl(card.code, "small")} alt="" className={styles.art} draggable={false} />
        </div>
      ) : (
        <CardBack kind={sleeve ?? (loc === LOCATION_EXTRA ? "extra" : "deck")} />
      )}
      {negated ? <NegationMark /> : null}
      {overlays > 0 ? <span className={styles.overlayBadge}>{overlays}</span> : null}
    </div>
  );
}

export function cardFieldStats(card: DuelCard | null, showStats: boolean | undefined): string | null {
  if (!card || !showStats) return null;
  if (isFacedown(card.position) && card.location !== LOCATION_HAND) return null;
  if (card.code == null) return null;
  return cardStatsText(card);
}
