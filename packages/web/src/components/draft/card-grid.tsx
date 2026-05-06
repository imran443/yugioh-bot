"use client";

import * as React from "react";
import Image from "next/image";
import { useDraftStore, DraftCardDetail } from "@/lib/stores/draft-store";
import { cn } from "@/lib/utils";
import { CardPreview } from "./card-preview";
import { Modal } from "@/components/ui/modal";

interface CardGridProps {
  className?: string;
}

const desktopPreviewWidth = 288;
const desktopPreviewHeight = 560;
const previewMargin = 16;
const previewOverlap = 36;

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

function getDesktopPreviewPosition(rect: DOMRect) {
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const rightAlignedLeft = rect.right - previewOverlap;
  const leftAlignedLeft = rect.left - desktopPreviewWidth + previewOverlap;
  const centeredLeft = rect.left + rect.width / 2 - desktopPreviewWidth / 2;
  const left =
    rightAlignedLeft + desktopPreviewWidth + previewMargin <= viewportWidth
      ? rightAlignedLeft
      : leftAlignedLeft >= previewMargin
        ? leftAlignedLeft
        : Math.min(
            viewportWidth - desktopPreviewWidth - previewMargin,
            Math.max(previewMargin, centeredLeft)
          );
  const top = Math.min(
    viewportHeight - desktopPreviewHeight - previewMargin,
    Math.max(previewMargin, rect.top + rect.height / 2 - desktopPreviewHeight / 2)
  );

  return { left, top };
}

export function CardGrid({ className }: CardGridProps) {
  const currentPack = useDraftStore((s) => s.currentPack);
  const selectedCardId = useDraftStore((s) => s.selectedCardId);
  const highlightedIndex = useDraftStore((s) => s.highlightedIndex);
  const setSelectedCard = useDraftStore((s) => s.setSelectedCard);
  const setHighlightedIndex = useDraftStore((s) => s.setHighlightedIndex);
  const pickCard = useDraftStore((s) => s.pickCard);
  const setFromServer = useDraftStore((s) => s.setFromServer);
  const isMyTurn = useDraftStore((s) => s.isMyTurn);
  const slug = useDraftStore((s) => s.slug);

  const [hoveredCard, setHoveredCard] = React.useState<DraftCardDetail | null>(null);
  const [hoveredRect, setHoveredRect] = React.useState<DOMRect | null>(null);
  const [imageErrors, setImageErrors] = React.useState<Set<number>>(new Set());
  const [picking, setPicking] = React.useState(false);

  const handleImageError = (cardId: number) => {
    setImageErrors((prev) => new Set(prev).add(cardId));
  };

  const updateHoveredCard = React.useCallback((card: DraftCardDetail, element: HTMLElement | null) => {
    setHoveredCard(card);
    setHoveredRect(element?.getBoundingClientRect() ?? null);
  }, []);

  const clearHoveredCard = React.useCallback(() => {
    setHoveredCard(null);
    setHoveredRect(null);
  }, []);

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
            const element = document.querySelector<HTMLElement>(`[data-card-id="${card.id}"]`);
            updateHoveredCard(card, element);
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
    setSelectedCard(card.id);
    setHighlightedIndex(index);
  };

  const selectedCard = currentPack.find((c) => c.id === selectedCardId) || null;
  const previewPosition = hoveredRect ? getDesktopPreviewPosition(hoveredRect) : null;

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
          "grid gap-4",
          "grid-cols-[repeat(2,minmax(180px,1fr))]",
          "sm:grid-cols-[repeat(3,minmax(180px,1fr))]",
          "xl:grid-cols-[repeat(4,minmax(180px,1fr))]"
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
                "group relative flex flex-col items-center rounded-xl border bg-surface p-2.5 motion-safe:transition-all",
                "hover:shadow-card hover:border-accent-primary/50",
                "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-primary",
                isHighlighted
                  ? "border-accent-primary ring-2 ring-accent-primary/30"
                  : "border-border"
              )}
              data-card-id={card.id}
              onMouseEnter={(event) => {
                updateHoveredCard(card, event.currentTarget);
              }}
              onMouseLeave={clearHoveredCard}
              onClick={() => handleCardClick(card, index)}
              onFocus={(event) => {
                updateHoveredCard(card, event.currentTarget);
              }}
            >
              {/* Position number */}
              <span className="absolute left-2 top-2 flex h-6 w-6 items-center justify-center rounded-full bg-bg-elevated text-xs font-semibold text-text-secondary">
                {index + 1}
              </span>

              {/* Card image or placeholder */}
              <div className="relative mb-3 aspect-[3/4] w-full overflow-hidden rounded-lg bg-bg-elevated">
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
              <span className="w-full truncate text-left text-sm font-semibold text-text-primary sm:text-[0.95rem]">
                {card.name}
              </span>
            </button>
          );
        })}
      </div>

      {/* Desktop hover preview */}
      {hoveredCard && previewPosition && (
        <div
          className="pointer-events-none fixed z-30 hidden lg:block"
          style={{
            left: `${previewPosition.left}px`,
            top: `${previewPosition.top}px`,
          }}
        >
          <div className="max-h-[calc(100vh-2rem)] w-72 overflow-auto rounded-xl border border-border bg-surface shadow-card">
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

      <Modal
        open={!!selectedCard}
        onClose={() => setSelectedCard(null)}
        title={selectedCard?.name}
        className="max-w-3xl"
      >
        {selectedCard && (
          <CardPreview
            card={selectedCard}
            onPick={() => {
              handleConfirmPick(selectedCard.id);
              setSelectedCard(null);
            }}
            onBack={() => setSelectedCard(null)}
          />
        )}
      </Modal>
    </div>
  );
}
