"use client";

import { useCallback, useDeferredValue, useMemo, useState } from "react";
import Image from "next/image";
import { ArrowUpDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { CardHoverPopup } from "@/components/draft/card-hover-popup";
import {
  isMonster, isSpell, isTrap, isEffectMonster, isNormalMonster, getTypeBadgeClass, getTypeLabel,
  type CardSummary,
} from "@/lib/card-types";

type PoolFilter = "all" | "effect" | "normal" | "spell" | "trap";
type PoolSort = "newest" | "oldest" | "name" | "type";

const POPUP_WIDTH = 288;
const POPUP_HEIGHT = 560;
const POPUP_MARGIN = 16;

function getPopupPosition(rect: DOMRect): { left: number; top: number } {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const leftOfItem = rect.left - POPUP_WIDTH - POPUP_MARGIN;
  const left = Math.min(vw - POPUP_WIDTH - POPUP_MARGIN, Math.max(POPUP_MARGIN, leftOfItem));
  const top = Math.min(vh - POPUP_HEIGHT - POPUP_MARGIN, Math.max(POPUP_MARGIN, rect.top + rect.height / 2 - POPUP_HEIGHT / 2));
  return { left, top };
}

interface CardPoolGridProps {
  cards: CardSummary[];
  loading?: boolean;
  unknownIds?: number[];
  emptyMessage?: string;
  className?: string;
  heightClassName?: string;
  gridClassName?: string;
  showSummary?: boolean;
  onCardClick?: (card: CardSummary) => void;
  cardActionLabel?: (card: CardSummary) => string;
  cubeEditMode?: boolean;
}

const FILTER_BUTTONS: Array<{ label: string; value: PoolFilter }> = [
  { label: "All", value: "all" },
  { label: "Effect Monsters", value: "effect" },
  { label: "Normal Monsters", value: "normal" },
  { label: "Spells", value: "spell" },
  { label: "Traps", value: "trap" },
];
const SORT_BUTTONS: Array<{ label: string; value: PoolSort }> = [
  { label: "Newest", value: "newest" },
  { label: "Oldest", value: "oldest" },
  { label: "Name", value: "name" },
  { label: "Type", value: "type" },
];

export function CardPoolGrid({
  cards,
  loading = false,
  unknownIds = [],
  emptyMessage = "No cards.",
  className,
  heightClassName = "h-[26rem]",
  gridClassName = "grid grid-cols-2 gap-3 p-3 2xl:grid-cols-3",
  showSummary = true,
  onCardClick,
  cardActionLabel,
  cubeEditMode = false,
}: CardPoolGridProps) {
  const [searchTerm, setSearchTerm] = useState("");
  const [activeFilter, setActiveFilter] = useState<PoolFilter>("all");
  const [activeSort, setActiveSort] = useState<PoolSort>("newest");
  const [hoveredCard, setHoveredCard] = useState<CardSummary | null>(null);
  const [tapped, setTapped] = useState<CardSummary | null>(null);
  const [popupPosition, setPopupPosition] = useState<{ left: number; top: number } | null>(null);
  const [imageErrors, setImageErrors] = useState<Set<number>>(new Set());
  const deferredSearch = useDeferredValue(searchTerm);

  const handleImageError = useCallback((id: number) => setImageErrors((p) => new Set(p).add(id)), []);
  const handleEnter = useCallback((card: CardSummary, rect: DOMRect) => {
    setHoveredCard(card);
    setPopupPosition(getPopupPosition(rect));
  }, []);
  const handleLeave = useCallback(() => { setHoveredCard(null); setPopupPosition(null); }, []);

  const { monsterCount, spellCount, trapCount } = useMemo(() => ({
    monsterCount: cards.filter((c) => isMonster(c.type)).length,
    spellCount: cards.filter((c) => isSpell(c.type)).length,
    trapCount: cards.filter((c) => isTrap(c.type)).length,
  }), [cards]);

  const visible = useMemo(() => {
    const needle = deferredSearch.trim().toLowerCase();
    let list = cards.filter((card) => {
      const matchSearch = needle.length === 0 || card.name.toLowerCase().includes(needle);
      const matchFilter =
        activeFilter === "all" ||
        (activeFilter === "effect" && isEffectMonster(card)) ||
        (activeFilter === "normal" && isNormalMonster(card)) ||
        (activeFilter === "spell" && isSpell(card.type)) ||
        (activeFilter === "trap" && isTrap(card.type));
      return matchSearch && matchFilter;
    });
    if (activeSort === "newest") list = [...list].reverse();
    else if (activeSort === "name") list = [...list].sort((a, b) => a.name.localeCompare(b.name));
    else if (activeSort === "type") {
      const order = (c: CardSummary) => (isMonster(c.type) ? 0 : isSpell(c.type) ? 1 : isTrap(c.type) ? 2 : 3);
      list = [...list].sort((a, b) => order(a) - order(b));
    }
    return list;
  }, [cards, deferredSearch, activeFilter, activeSort]);

  const showSkeleton = loading && cards.length === 0;
  const previewEnabled = !cubeEditMode && !onCardClick;
  const hoverEnabled = !cubeEditMode;

  return (
    <div className={cn("flex flex-col gap-3", className)}>
      {showSummary && (
        <div className="grid grid-cols-3 gap-1.5">
          <div className="flex flex-col items-center rounded-lg bg-bg-elevated p-1.5">
            <span className="font-display text-lg text-text-primary tabular-nums">{monsterCount}</span>
            <span className="text-xs text-text-secondary">Monsters</span>
          </div>
          <div className="flex flex-col items-center rounded-lg bg-bg-elevated p-1.5">
            <span className="font-display text-lg text-text-primary tabular-nums">{spellCount}</span>
            <span className="text-xs text-text-secondary">Spells</span>
          </div>
          <div className="flex flex-col items-center rounded-lg bg-bg-elevated p-1.5">
            <span className="font-display text-lg text-text-primary tabular-nums">{trapCount}</span>
            <span className="text-xs text-text-secondary">Traps</span>
          </div>
        </div>
      )}

      <input
        type="text"
        aria-label="Search cards"
        value={searchTerm}
        onChange={(e) => setSearchTerm(e.target.value)}
        placeholder="Search cards..."
        className="h-9 w-full rounded-lg border border-border bg-surface px-3 text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-accent-primary/60"
      />

      <div className="flex flex-wrap gap-1.5">
        {FILTER_BUTTONS.map((fb) => (
          <Button key={fb.value} type="button" size="sm" variant={activeFilter === fb.value ? "secondary" : "ghost"}
            onClick={() => setActiveFilter(fb.value)} aria-pressed={activeFilter === fb.value} className="rounded-full px-3 text-xs">
            {fb.label}
          </Button>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <ArrowUpDown className="h-3.5 w-3.5 shrink-0 text-text-muted" aria-hidden="true" />
        {SORT_BUTTONS.map((sb) => (
          <Button key={sb.value} type="button" size="sm" variant={activeSort === sb.value ? "secondary" : "ghost"}
            onClick={() => setActiveSort(sb.value)} aria-pressed={activeSort === sb.value} className="rounded-full px-3 text-xs">
            {sb.label}
          </Button>
        ))}
      </div>

      <div className={cn("relative overflow-y-auto rounded-lg border border-border bg-surface/70", heightClassName)}>
        {loading && cards.length > 0 && (
          <span className="pointer-events-none absolute right-2 top-2 z-10 rounded-full bg-bg-elevated px-2 py-0.5 text-[0.65rem] font-semibold uppercase tracking-wide text-text-secondary">
            Updating…
          </span>
        )}
        {showSkeleton ? (
          <div data-testid="card-pool-grid-skeleton" className="grid grid-cols-2 gap-3 p-3 2xl:grid-cols-3">
            {Array.from({ length: 10 }).map((_, i) => (
              <div key={i} className="aspect-[421/614] w-full animate-pulse rounded-md bg-bg-elevated" />
            ))}
          </div>
        ) : cards.length === 0 && unknownIds.length === 0 ? (
          <p className="px-3 py-4 text-sm text-text-secondary">{emptyMessage}</p>
        ) : visible.length === 0 && unknownIds.length === 0 ? (
          <p className="px-3 py-4 text-sm text-text-secondary">No cards match.</p>
        ) : (
          <div data-testid="card-pool-grid" className={gridClassName}>
            {visible.map((card) => (
              <button
                key={card.id}
                type="button"
                aria-label={onCardClick ? cardActionLabel?.(card) ?? `Select ${card.name}` : `Preview ${card.name}`}
                className={cn(
                  "group flex w-full flex-col gap-2 rounded-lg border border-border/70 bg-bg-elevated/40 p-2 text-left focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent-primary",
                  cubeEditMode ? "cursor-pointer" : "transition-colors duration-150 hover:bg-bg-elevated",
                )}
                onClick={(e) => {
                  if (onCardClick) {
                    onCardClick(card);
                    return;
                  }
                  if (!previewEnabled) {
                    return;
                  }
                  setTapped(card);
                  setPopupPosition(getPopupPosition(e.currentTarget.getBoundingClientRect()));
                }}
                onMouseEnter={hoverEnabled ? (e) => handleEnter(card, e.currentTarget.getBoundingClientRect()) : undefined}
                onMouseLeave={hoverEnabled ? handleLeave : undefined}
                onFocus={hoverEnabled ? (e) => handleEnter(card, e.currentTarget.getBoundingClientRect()) : undefined}
                onBlur={hoverEnabled ? handleLeave : undefined}
              >
                <div className="relative aspect-[421/614] w-full overflow-hidden rounded-md bg-bg-elevated">
                  {imageErrors.has(card.id) ? (
                    <div className="flex h-full w-full items-center justify-center text-xs text-text-muted">?</div>
                  ) : (
                    <Image
                      src={cubeEditMode ? card.imageUrl || card.imageUrlSmall : card.imageUrlSmall || card.imageUrl}
                      alt={card.name}
                      fill
                      className="object-cover"
                      sizes={cubeEditMode ? "(min-width: 1280px) 220px, (min-width: 1024px) 180px, 45vw" : "(min-width: 1536px) 120px, 160px"}
                      onError={() => handleImageError(card.id)}
                    />
                  )}
                  {(card.qty ?? 1) > 1 && (
                    <span className="absolute bottom-1 right-1 rounded bg-black/75 px-1 py-0.5 text-[0.65rem] font-bold tabular-nums text-white">
                      ×{card.qty}
                    </span>
                  )}
                </div>
                <div className="min-w-0">
                  <p className="line-clamp-2 text-sm font-medium leading-snug text-text-primary">{card.name}</p>
                  <span className={cn("mt-1 inline-flex rounded px-1.5 py-0.5 text-[0.65rem] font-semibold uppercase", getTypeBadgeClass(card.type))}>
                    {getTypeLabel(card.type)}
                  </span>
                </div>
              </button>
            ))}
            {unknownIds.map((id) => (
              <div key={`unknown-${id}`} data-testid="card-pool-grid-unknown"
                title={`Passcode ${id} is not in the catalog yet`}
                aria-label={`Passcode ${id} not in catalog yet`}
                className="flex w-full flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-border/70 bg-bg-elevated/20 p-2 text-center">
                <div className="flex aspect-[421/614] w-full items-center justify-center rounded-md bg-bg-elevated/40 font-mono text-xs text-text-muted">{id}</div>
                <p className="text-[0.65rem] text-text-muted">not in catalog yet</p>
              </div>
            ))}
          </div>
        )}
      </div>

      {previewEnabled && hoveredCard && popupPosition && !tapped && (
        <CardHoverPopup
          card={hoveredCard}
          position={popupPosition}
          imageError={imageErrors.has(hoveredCard.id)}
          onImageError={() => handleImageError(hoveredCard.id)}
        />
      )}
      {previewEnabled && tapped && popupPosition && (
        <CardHoverPopup
          card={tapped}
          position={popupPosition}
          imageError={imageErrors.has(tapped.id)}
          onImageError={() => handleImageError(tapped.id)}
          dismissible
          onDismiss={() => setTapped(null)}
        />
      )}
    </div>
  );
}
