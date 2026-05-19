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
      />
    </div>
  );
}

// Memoized alongside CardPoolGrid so a stable pool doesn't re-render through
// this wrapper when an unrelated parent (the create-draft form) updates.
export const CardPoolPanel = memo(CardPoolPanelBase);
