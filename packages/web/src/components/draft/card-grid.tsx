"use client";

import * as React from "react";
import { useDraftStore, DraftCardDetail } from "@/lib/stores/draft-store";
import { cn } from "@/lib/utils";

interface CardGridProps {
  className?: string;
}

function isInputTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName.toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select") return true;
  return target.isContentEditable;
}

function parseNumberKey(key: string): number | null {
  if (key >= "1" && key <= "9") return parseInt(key, 10);
  if (key.startsWith("Numpad") && key.length === 7) {
    const digit = key.slice(6);
    if (digit >= "1" && digit <= "9") return parseInt(digit, 10);
  }
  return null;
}

export function CardGrid({ className }: CardGridProps) {
  const currentPack = useDraftStore((s) => s.currentPack);
  const highlightedIndex = useDraftStore((s) => s.highlightedIndex);
  const setPreviewCard = useDraftStore((s) => s.setPreviewCard);
  const setHighlightedIndex = useDraftStore((s) => s.setHighlightedIndex);
  const pickCard = useDraftStore((s) => s.pickCard);
  const setFromServer = useDraftStore((s) => s.setFromServer);
  const isMyTurn = useDraftStore((s) => s.isMyTurn);
  const slug = useDraftStore((s) => s.slug);

  const [hoveredCard, setHoveredCard] = React.useState<DraftCardDetail | null>(null);
  const [imageErrors, setImageErrors] = React.useState<Set<number>>(new Set());
  const [picking, setPicking] = React.useState(false);

  const handleImageError = (cardId: number) => {
    setImageErrors((prev) => new Set(prev).add(cardId));
  };

  const updateHoveredCard = React.useCallback((card: DraftCardDetail) => {
    setHoveredCard(card);
    setPreviewCard(card.id);
  }, [setPreviewCard]);

  const clearHoveredCard = React.useCallback(() => {
    setHoveredCard(null);
    setPreviewCard(null);
  }, [setPreviewCard]);

  React.useEffect(() => {
    if (!hoveredCard) {
      return;
    }

    if (!isMyTurn || !currentPack.some((card) => card.id === hoveredCard.id)) {
      clearHoveredCard();
    }
  }, [clearHoveredCard, currentPack, hoveredCard, isMyTurn]);

  const fetchPick = React.useCallback(
    async (cardId: number) => {
      if (!slug) return;
      try {
        const res = await fetch(`/api/drafts/${slug}/pick`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ cardId }),
        });

        if (!res.ok) {
          throw new Error(`Pick failed: ${res.status}`);
        }

        const data = await res.json();
        setFromServer(data);
      } catch (err) {
        console.error("Pick error:", err);
        // Refetch full draft state to restore consistency
        try {
          const refresh = await fetch(`/api/drafts/${slug}`);
          if (refresh.ok) {
            const fresh = await refresh.json();
            setFromServer(fresh);
          }
        } catch (refreshErr) {
          console.error("Failed to refresh draft state:", refreshErr);
        }
      } finally {
        setPicking(false);
      }
    },
    [slug, setFromServer]
  );

  const handleConfirmPick = React.useCallback(
    (cardId: number) => {
      const state = useDraftStore.getState();
      const canPick = state.isMyTurn && state.currentPack.some((card) => card.id === cardId);

      if (picking || !canPick) {
        clearHoveredCard();
        state.setSelectedCard(null);
        state.setHighlightedIndex(-1);
        return;
      }

      setPicking(true);
      pickCard(cardId); // optimistic local update
      fetchPick(cardId); // persist to server
    },
    [clearHoveredCard, picking, pickCard, fetchPick]
  );

  // Keyboard shortcuts: 1-8 / Numpad1-8 to highlight, Enter to confirm, Escape to dismiss
  React.useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (isInputTarget(e.target)) return;

      const state = useDraftStore.getState();
      if (!state.isMyTurn || state.currentPack.length === 0) return;

      const num = parseNumberKey(e.key);
      if (num !== null) {
        const index = num - 1;
        if (index < state.currentPack.length) {
          state.setHighlightedIndex(index);
          const card = state.currentPack[index];
          if (card) {
            updateHoveredCard(card);
          }
        }
      }

      if (e.key === "Enter") {
        const idx = state.highlightedIndex;
        if (idx >= 0 && idx < state.currentPack.length) {
          const card = state.currentPack[idx];
          if (card) {
            handleConfirmPick(card.id);
            clearHoveredCard();
          }
        }
      }

      if (e.key === "Escape") {
        clearHoveredCard();
        state.setHighlightedIndex(-1);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [clearHoveredCard, handleConfirmPick, updateHoveredCard]);

  const handleCardClick = (card: DraftCardDetail, index: number) => {
    setHighlightedIndex(index);
    handleConfirmPick(card.id);
  };

  if (currentPack.length === 0) {
    return (
      <div className={cn("relative flex min-h-[24rem] flex-col items-center justify-center", className)}>
        <div className="text-center">
          <p className="text-xs font-semibold uppercase tracking-[0.24em] text-accent-primary">
            Draft feed syncing
          </p>
          <h2 className="mt-2 font-display text-xl text-text-primary sm:text-2xl">
            Waiting for pack...
          </h2>
          <p className="mt-2 text-sm text-text-secondary">
            The current pack will appear here once the draft state arrives.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className={cn("relative", className)}>
      <div
        className={cn(
          "grid gap-3 sm:gap-4",
          "grid-cols-[repeat(2,minmax(140px,1fr))]",
          "sm:grid-cols-[repeat(3,minmax(140px,1fr))]",
          "lg:grid-cols-[repeat(4,minmax(130px,1fr))]",
          "2xl:grid-cols-[repeat(6,minmax(120px,1fr))]"
        )}
        role="listbox"
        aria-label="Current pack cards"
      >
        {currentPack.map((card, index) => {
          const isHighlighted = highlightedIndex === index;
          const hasImageError = imageErrors.has(card.id);

          return (
            <button
              key={card.id}
              role="option"
              aria-selected={isHighlighted}
              tabIndex={0}
              className={cn(
                "group relative flex flex-col items-center rounded-xl border bg-bg-surface p-2 motion-safe:transition-all sm:p-2.5",
                "hover:shadow-card hover:border-accent-primary/50",
                "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-primary",
                isHighlighted
                  ? "border-accent-primary ring-2 ring-accent-primary/30"
                  : "border-border"
              )}
              data-card-id={card.id}
              onMouseEnter={() => {
                updateHoveredCard(card);
              }}
              onMouseLeave={clearHoveredCard}
              onClick={() => handleCardClick(card, index)}
              onFocus={() => {
                updateHoveredCard(card);
              }}
            >
              {/* Position number */}
              <span className="absolute left-2 top-2 flex h-6 w-6 items-center justify-center rounded-full bg-bg-elevated text-xs font-semibold text-text-secondary">
                {index + 1}
              </span>

              {/* Card image or placeholder */}
              <div className="relative mb-3 aspect-[421/614] w-full overflow-hidden rounded-lg bg-bg-elevated">
                {hasImageError ? (
                  <div className="flex h-full w-full flex-col items-center justify-center gap-2 text-text-secondary">
                    <span className="text-xs">No image</span>
                  </div>
                ) : (
                  <img
                    src={card.imageUrlSmall || card.imageUrl}
                    alt={card.name}
                    loading="eager"
                    decoding="async"
                    className="absolute inset-0 h-full w-full object-contain motion-safe:transition-opacity motion-safe:duration-300 group-hover:opacity-95"
                    onError={() => handleImageError(card.id)}
                  />
                )}
              </div>

              {/* Card name */}
              <span className="w-full truncate text-left text-sm font-semibold text-text-primary sm:text-[0.95rem]">
                {card.name}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
