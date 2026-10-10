"use client";

import type { ReactNode } from "react";
import { Crown, Minus, Plus, Search } from "lucide-react";
import type { CardArchetype, DeckCardInfo, DuelDeck, DuelMode } from "@yugidraft/shared/duels";
import { canBeDeckMaster } from "@/components/duel/deck-card-types";
import { cn } from "@/lib/utils";
import { DeckButton } from "./controls";
import { cardArchetypes } from "./filter-model";
import { limitName } from "./limit-badge";
import { defaultAddSection, type DeckSection } from "./model";
import styles from "./editor.module.css";

const SECTION_LABELS: Record<DeckSection, string> = { main: "Main", extra: "Extra", side: "Side" };

export function CardCopyCount({ copies, limit, poolCopies, forced = 0 }: { copies: number; limit: number; poolCopies?: number; forced?: number }) {
  return (
    <p className={styles["de-copies"]}>
      <b className="num">{copies}</b>{" "}of <b className="num">{poolCopies ?? limit}</b>{" "}{poolCopies !== undefined ? "pool copies " : ""}in deck
      {forced > 0 ? <span title="A pack left you no other pick, so the extra copy can go in your deck."> (incl. forced pick)</span> : null}
    </p>
  );
}

/** Add, remove and Deck Master controls for the inspected card, under the card text. */
export function CardActions({
  card,
  deck,
  mode,
  copies,
  limit,
  poolCopies,
  forced = 0,
  banlistName,
  archetypes,
  onAdd,
  onRemove,
  onMaster,
  onArchetype,
  artwork,
  hideSummary = false,
}: {
  card: DeckCardInfo;
  deck: DuelDeck;
  mode: DuelMode;
  /** All copies in the deck with this card's name (alternate artworks included). */
  copies: number;
  limit: 0 | 1 | 2 | 3;
  /** Draft deck mode: copies of this card the deck can hold (3 plus forced picks, at most the pool). They replace the banlist limit. */
  poolCopies?: number;
  /** Draft deck mode: forced picks of this card; each adds one copy to the 3-copy limit. */
  forced?: number;
  banlistName: string | null;
  archetypes: readonly CardArchetype[];
  onAdd: (section: DeckSection) => void;
  onRemove: (section: DeckSection) => void;
  onMaster: () => void;
  onArchetype: (archetype: CardArchetype) => void;
  /** The art picker for this card; it renders nothing for a card with one art. */
  artwork?: ReactNode;
  hideSummary?: boolean;
}) {
  const home = defaultAddSection(card);
  const sections: DeckSection[] = [home, "side"];
  if (home === "main" && deck.extra.includes(card.code)) sections.splice(1, 0, "extra");
  if (home === "extra" && deck.main.includes(card.code)) sections.splice(1, 0, "main");
  const inPool = poolCopies !== undefined;
  const full = !!card.unavailableReason || (inPool ? copies >= poolCopies : copies >= limit);
  const status = inPool ? null : limitName(limit);
  const own = cardArchetypes(card.setcodes, archetypes);
  const isMaster = deck.deckMaster === card.code;
  const canMaster = mode === "domain" && canBeDeckMaster(card.type);

  return (
    <div className={styles["de-acts-c"]}>
      {card.unavailableReason ? <p className={styles.chipBad}>Unavailable: {card.unavailableReason}</p> : null}
      {hideSummary ? null : <div className={styles.actionsHead}>
        <CardCopyCount copies={copies} limit={limit} poolCopies={poolCopies} forced={forced} />
        {status ? (
          <span className={cn("chip", limit === 0 ? styles.chipBad : "chip-gold")} title={banlistName ? `${status} on ${banlistName}` : status}>
            {status}
          </span>
        ) : null}
      </div>}

      <ul className={styles.steppers}>
        {sections.map((section) => {
          const count = deck[section].filter((code) => code === card.code).length;
          const label = SECTION_LABELS[section];
          return (
            <li key={section} className={styles["de-step"]}>
              <span>{label}</span>
              <button
                type="button"
                className={styles["de-ib"]}
                aria-label={`Remove one ${card.name} from ${label}`}
                disabled={count === 0}
                onClick={() => onRemove(section)}
              >
                <Minus size={15} strokeWidth={1.8} aria-hidden />
              </button>
              <output className="num" aria-label={`${count} in ${label}`}>{count}</output>
              <button
                type="button"
                className={styles["de-ib"]}
                aria-label={`Add one ${card.name} to ${label}`}
                disabled={full || (section !== home && section !== "side")}
                onClick={() => onAdd(section)}
              >
                <Plus size={15} strokeWidth={1.8} aria-hidden />
              </button>
            </li>
          );
        })}
      </ul>

      {canMaster ? (
        <DeckButton size="sm" kind={isMaster ? "quiet" : "secondary"} block disabled={isMaster || !!card.unavailableReason} onClick={onMaster}>
          <Crown size={15} strokeWidth={1.6} aria-hidden />
          {isMaster ? "This is your Deck Master" : "Use as Deck Master"}
        </DeckButton>
      ) : null}

      {artwork}

      {own.length > 0 ? (
        <div className={styles.archetypes}>
          <p className={styles.actionsLabel}>Archetype</p>
          <ul>
            {own.map((archetype) => (
              <li key={archetype.name}>
                <button
                  type="button"
                  className={cn("chip chip-pen", styles.archetypeChip)}
                  title={`Show all ${archetype.name} cards`}
                  onClick={() => onArchetype(archetype)}
                >
                  <Search size={12} aria-hidden />
                  {archetype.name}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
