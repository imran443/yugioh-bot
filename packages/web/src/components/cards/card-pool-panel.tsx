"use client";

import { memo, useMemo } from "react";
import { cn } from "@/lib/utils";
import { CardPoolGrid } from "@/components/cards/card-pool-grid";
import type { CardSummary } from "@/lib/card-types";

interface CardPoolPanelProps {
  cards: CardSummary[];
  title: string;
  loading?: boolean;
  unknownIds?: number[];
  emptyMessage?: string;
  error?: string | null;
  heightClassName?: string;
  showSummary?: boolean;
  /** "distinct" (default) shows just N cards; "copies" also shows total copies when any qty > 1. */
  countMode?: "distinct" | "copies";
  className?: string;
  // Forwarded to the grid so callers can turn the preview into a card picker
  // (e.g. click a card to remove one copy while editing a pool).
  onCardClick?: (card: CardSummary) => void;
  cardActionLabel?: (card: CardSummary) => string;
  cubeEditMode?: boolean;
}

function CardPoolPanelBase({
  cards,
  title,
  loading = false,
  unknownIds = [],
  emptyMessage = "No cards.",
  error = null,
  heightClassName,
  showSummary = false,
  countMode = "distinct",
  className,
  onCardClick,
  cardActionLabel,
  cubeEditMode,
}: CardPoolPanelProps) {
  const distinct = cards.length;
  const totalCopies = useMemo(
    () => cards.reduce((sum, c) => sum + (c.qty ?? 1), 0),
    [cards],
  );
  const showCopies = countMode === "copies" && totalCopies > distinct;

  return (
    <div className={cn("@container rounded-xl border border-border bg-surface p-3", className)}>
      <div className="mb-3 flex items-center justify-between gap-2">
        <h3 className="font-display text-lg text-text-primary">{title}</h3>
        <span aria-live="polite" className="text-sm tabular-nums text-text-secondary">
          {distinct} card{distinct === 1 ? "" : "s"}
          {showCopies ? ` · ${totalCopies} copies` : ""}
          {loading ? " · resolving…" : ""}
        </span>
      </div>

      {error && (
        <p className="mb-3 rounded-lg border border-accent-cta/20 bg-accent-cta/10 px-3 py-2 text-sm text-accent-cta">
          {error}
        </p>
      )}

      <CardPoolGrid
        cards={cards}
        loading={loading}
        unknownIds={unknownIds}
        emptyMessage={emptyMessage}
        heightClassName={heightClassName}
        showSummary={showSummary}
        onCardClick={onCardClick}
        cardActionLabel={cardActionLabel}
        cubeEditMode={cubeEditMode}
      />
    </div>
  );
}

// Memoized alongside CardPoolGrid so a stable pool doesn't re-render through
// this wrapper when an unrelated parent (the create-draft form) updates.
export const CardPoolPanel = memo(CardPoolPanelBase);
