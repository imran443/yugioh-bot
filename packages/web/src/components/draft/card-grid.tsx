"use client";

import * as React from "react";
import Image from "next/image";
import { useDraftStore, DraftCardDetail } from "@/lib/stores/draft-store";
import { cn } from "@/lib/utils";
import { CardPreview } from "./card-preview";
import { Sheet } from "@/components/ui/sheet";

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
  const selectedCardId = useDraftStore((s) => s.selectedCardId);
  const highlightedIndex = useDraftStore((s) => s.highlightedIndex);
  const setSelectedCard = useDraftStore((s) => s.setSelectedCard);
  const setHighlightedIndex = useDraftStore((s) => s.setHighlightedIndex);
  const pickCard = useDraftStore((s) => s.pickCard);
  const isMyTurn = useDraftStore((s) => s.isMyTurn);

  const [hoveredCard, setHoveredCard] = React.useState<DraftCardDetail | null>(null);
  const [hoveredIndex, setHoveredIndex] = React.useState<number | null>(null);
  const [imageErrors, setImageErrors] = React.useState<Set<number>>(new Set());

  const handleImageError = (cardId: number) => {
    setImageErrors((prev) => new Set(prev).add(cardId));
  };

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
            setHoveredCard(card);
            setHoveredIndex(index);
          }
        }
      }

      if (e.key === "Enter") {
        const idx = state.highlightedIndex;
        if (idx >= 0 && idx < state.currentPack.length) {
          const card = state.currentPack[idx];
          if (card) {
            state.pickCard(card.id);
            setHoveredCard(null);
            setHoveredIndex(null);
          }
        }
      }

      if (e.key === "Escape") {
        setHoveredCard(null);
        setHoveredIndex(null);
        state.setHighlightedIndex(-1);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  const handleCardClick = (card: DraftCardDetail, index: number) => {
    setSelectedCard(card.id);
    setHighlightedIndex(index);
  };

  const selectedCard = currentPack.find((c) => c.id === selectedCardId) || null;

  return (
    <div className={cn("relative", className)}>
      <div
        className={cn(
          "grid gap-3",
          "grid-cols-2",
          "sm:grid-cols-3",
          "lg:grid-cols-4"
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
                "group relative flex flex-col items-center rounded-lg border bg-surface p-2 motion-safe:transition-all",
                "hover:shadow-card hover:border-accent-primary/50",
                "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-primary",
                isHighlighted
                  ? "border-accent-primary ring-2 ring-accent-primary/30"
                  : "border-border"
              )}
              onMouseEnter={() => {
                setHoveredCard(card);
                setHoveredIndex(index);
              }}
              onMouseLeave={() => {
                setHoveredCard(null);
                setHoveredIndex(null);
              }}
              onClick={() => handleCardClick(card, index)}
              onFocus={() => {
                setHoveredCard(card);
                setHoveredIndex(index);
              }}
            >
              {/* Position number */}
              <span className="absolute left-2 top-2 flex h-6 w-6 items-center justify-center rounded-full bg-bg-elevated text-xs font-semibold text-text-secondary">
                {index + 1}
              </span>

              {/* Card image or placeholder */}
              <div className="relative mb-2 aspect-[3/4] w-full overflow-hidden rounded-md bg-bg-elevated">
                {hasImageError ? (
                  <div className="flex h-full w-full flex-col items-center justify-center gap-2 text-text-secondary">
                    <span className="text-xs">No image</span>
                  </div>
                ) : (
                  <Image
                    src={card.imageUrlSmall || card.imageUrl}
                    alt={card.name}
                    fill
                    className="object-cover motion-safe:transition-transform motion-safe:duration-300 group-hover:scale-105"
                    sizes="(max-width: 640px) 50vw, (max-width: 1024px) 33vw, 25vw"
                    onError={() => handleImageError(card.id)}
                  />
                )}
              </div>

              {/* Card name */}
              <span className="w-full truncate text-center text-sm font-semibold text-text-primary">
                {card.name}
              </span>
            </button>
          );
        })}
      </div>

      {/* Desktop hover preview */}
      {hoveredCard && hoveredIndex !== null && (
        <div
          className="pointer-events-none absolute z-30 hidden lg:block"
          style={{
            left: `${(hoveredIndex % 4) * 25 + 12.5}%`,
            top: hoveredIndex < 4 ? "auto" : "0",
            bottom: hoveredIndex < 4 ? "100%" : "auto",
            transform: "translateX(-50%)",
            marginBottom: hoveredIndex < 4 ? "12px" : "0",
            marginTop: hoveredIndex >= 4 ? "12px" : "0",
          }}
        >
          <div className="w-72 rounded-xl border border-border bg-surface shadow-card">
            <div className="relative aspect-[3/4] w-full overflow-hidden rounded-t-xl bg-bg-elevated">
              {imageErrors.has(hoveredCard.id) ? (
                <div className="flex h-full items-center justify-center text-text-secondary">
                  No image
                </div>
              ) : (
                <Image
                  src={hoveredCard.imageUrl}
                  alt={hoveredCard.name}
                  fill
                  className="object-cover"
                  sizes="288px"
                  onError={() => handleImageError(hoveredCard.id)}
                />
              )}
            </div>
            <div className="p-4">
              <h3 className="mb-1 font-display text-lg text-text-primary">
                {hoveredCard.name}
              </h3>
              <p className="line-clamp-4 text-sm text-text-secondary">
                {hoveredCard.effectText}
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Mobile tap sheet */}
      <Sheet
        open={!!selectedCard}
        onClose={() => setSelectedCard(null)}
        title={selectedCard?.name}
      >
        {selectedCard && (
          <CardPreview
            card={selectedCard}
            onPick={() => {
              pickCard(selectedCard.id);
              setSelectedCard(null);
            }}
            onBack={() => setSelectedCard(null)}
          />
        )}
      </Sheet>
    </div>
  );
}
