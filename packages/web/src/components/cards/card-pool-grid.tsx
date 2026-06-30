"use client";

import { memo, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowUpDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { CardHoverPopup } from "@/components/draft/card-hover-popup";
import { CardArt } from "@/components/cards/card-art";
import {
  isMonster, isSpell, isTrap, isEffectMonster, isNormalMonster, getTypeBadgeClass, getTypeLabel,
  tributeTierForLevel,
  type CardSummary, type TributeTier,
} from "@/lib/card-types";

type PoolFilter = "all" | "effect" | "normal" | "spell" | "trap";
type PoolSort = "newest" | "oldest" | "name" | "type";
type PoolTribute = "any" | TributeTier;

type GridEntry =
  | { kind: "card"; card: CardSummary }
  | { kind: "unknown"; id: number };

const POPUP_WIDTH = 288;
const POPUP_HEIGHT = 560;
const POPUP_MARGIN = 16;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function getPopupPosition(rect: DOMRect): { left: number; top: number } {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  // Prefer the left of the card, but flip to its right when there isn't room
  // — otherwise the popup is clamped to the viewport edge and lands under the
  // app sidebar (e.g. the pool preview sitting in the left column).
  const fitsLeft = rect.left >= POPUP_WIDTH + POPUP_MARGIN * 2;
  const desiredLeft = fitsLeft
    ? rect.left - POPUP_WIDTH - POPUP_MARGIN
    : rect.right + POPUP_MARGIN;
  const verticalCenter = rect.top + rect.height / 2 - POPUP_HEIGHT / 2;

  const left = clamp(desiredLeft, POPUP_MARGIN, vw - POPUP_WIDTH - POPUP_MARGIN);
  const top = clamp(verticalCenter, POPUP_MARGIN, vh - POPUP_HEIGHT - POPUP_MARGIN);
  return { left, top };
}

interface CardPoolGridProps {
  cards: CardSummary[];
  loading?: boolean;
  unknownIds?: number[];
  emptyMessage?: string;
  className?: string;
  heightClassName?: string;
  showSummary?: boolean;
  // my-cubes feature: callers can turn the grid into a card picker.
  onCardClick?: (card: CardSummary) => void;
  cardActionLabel?: (card: CardSummary) => string;
  cubeEditMode?: boolean;
  // Minimum tile width in px; overrides the cubeEditMode/default sizing so callers
  // can pack more, smaller cards per row (e.g. side-by-side theme pools).
  tileMinPx?: number;
  // Accepted for API compatibility with my-cubes callers. The grid is
  // virtualized (columns derived from measured width), so a fixed grid class
  // is no longer applied — cubeEditMode widens the tiles instead.
  gridClassName?: string;
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
const TRIBUTE_BUTTONS: Array<{ label: string; value: PoolTribute }> = [
  { label: "Any", value: "any" },
  { label: "No Trib", value: "none" },
  { label: "1 Trib", value: "one" },
  { label: "2 Trib", value: "two" },
];

function CardPoolGridBase({
  cards,
  loading = false,
  unknownIds = [],
  emptyMessage = "No cards.",
  className,
  heightClassName = "h-[26rem]",
  showSummary = true,
  onCardClick,
  cardActionLabel,
  cubeEditMode = false,
  tileMinPx,
}: CardPoolGridProps) {
  const [searchTerm, setSearchTerm] = useState("");
  const [activeFilter, setActiveFilter] = useState<PoolFilter>("all");
  const [activeSort, setActiveSort] = useState<PoolSort>("newest");
  const [activeTribute, setActiveTribute] = useState<PoolTribute>("any");
  const [hoveredCard, setHoveredCard] = useState<CardSummary | null>(null);
  const [tapped, setTapped] = useState<CardSummary | null>(null);
  const [popupPosition, setPopupPosition] = useState<{ left: number; top: number } | null>(null);
  const [imageErrors, setImageErrors] = useState<Set<number>>(new Set());
  const deferredSearch = useDeferredValue(searchTerm);

  const filtersActive =
    searchTerm !== "" || activeFilter !== "all" || activeSort !== "newest" || activeTribute !== "any";
  const clearFilters = useCallback(() => {
    setSearchTerm("");
    setActiveFilter("all");
    setActiveSort("newest");
    setActiveTribute("any");
  }, []);

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

  const tributeCounts = useMemo(() => {
    const c: Record<PoolTribute, number> = { any: cards.length, none: 0, one: 0, two: 0 };
    for (const card of cards) {
      const tier = tributeTierForLevel(card.level);
      if (tier) c[tier] += 1;
    }
    return c;
  }, [cards]);

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
      const matchTribute =
        activeTribute === "any" || tributeTierForLevel(card.level) === activeTribute;
      return matchSearch && matchFilter && matchTribute;
    });
    if (activeSort === "newest") list = [...list].reverse();
    else if (activeSort === "name") list = [...list].sort((a, b) => a.name.localeCompare(b.name));
    else if (activeSort === "type") {
      const order = (c: CardSummary) => (isMonster(c.type) ? 0 : isSpell(c.type) ? 1 : isTrap(c.type) ? 2 : 3);
      list = [...list].sort((a, b) => order(a) - order(b));
    }
    return list;
  }, [cards, deferredSearch, activeFilter, activeSort, activeTribute]);

  const showSkeleton = loading && cards.length === 0;
  const previewEnabled = !cubeEditMode && !onCardClick;
  const scrollRef = useRef<HTMLDivElement>(null);
  const [layout, setLayout] = useState<{ columns: number; innerWidth: number }>({
    columns: 1,
    innerWidth: 0,
  });

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const GAP = 12; // gap-3
    // cube edit mode shows larger tiles (fewer, wider columns).
    const TILE_MIN = tileMinPx ?? (cubeEditMode ? 200 : 120);
    const PAD_X = 24; // px-3 on each row, both sides
    const measure = (): void => {
      const inner = Math.max(0, el.clientWidth - PAD_X);
      const columns = Math.max(1, Math.floor((inner + GAP) / (TILE_MIN + GAP)));
      setLayout({ columns, innerWidth: inner });
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [cubeEditMode, tileMinPx]);

  const entries = useMemo<GridEntry[]>(
    () => [
      ...visible.map((card): GridEntry => ({ kind: "card", card })),
      ...unknownIds.map((id): GridEntry => ({ kind: "unknown", id })),
    ],
    [visible, unknownIds],
  );

  const { columns, innerWidth } = layout;
  const estimatedRowHeight = useMemo(() => {
    const GAP = 12;
    const tileW = innerWidth > 0 ? (innerWidth - (columns - 1) * GAP) / columns : 120;
    const imageH = (tileW * 614) / 421;
    // image + img/label gap (8) + label block (~64) + button padding (16) + paddingBottom on row div (12)
    return Math.round(imageH + 8 + 64 + 16 + GAP);
  }, [columns, innerWidth]);

  const rowCount = Math.ceil(entries.length / columns);
  const rowVirtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => estimatedRowHeight,
    overscan: 4,
  });

  const virtualItems = rowVirtualizer.getVirtualItems();

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

      <div className="flex flex-wrap gap-1.5">
        {TRIBUTE_BUTTONS.map((tb) => (
          <Button key={tb.value} type="button" size="sm" variant={activeTribute === tb.value ? "secondary" : "ghost"}
            onClick={() => setActiveTribute(tb.value)} aria-pressed={activeTribute === tb.value} aria-label={tb.label}
            className="rounded-full px-3 text-xs">
            {tb.label}
            <span className="ml-1.5 tabular-nums text-text-muted">{tributeCounts[tb.value]}</span>
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
        {filtersActive && (
          <Button type="button" size="sm" variant="ghost" onClick={clearFilters}
            className="ml-auto rounded-full px-3 text-xs text-text-muted">
            Clear filters
          </Button>
        )}
      </div>

      <div ref={scrollRef} className={cn("relative overflow-y-auto rounded-lg border border-border bg-surface/70", heightClassName)}>
        {loading && cards.length > 0 && (
          <span className="pointer-events-none absolute right-2 top-2 z-10 rounded-full bg-bg-elevated px-2 py-0.5 text-[0.65rem] font-semibold uppercase tracking-wide text-text-secondary">
            Updating…
          </span>
        )}
        {showSkeleton ? (
          <div data-testid="card-pool-grid-skeleton" className="grid grid-cols-[repeat(auto-fill,minmax(9rem,1fr))] gap-3 p-3">
            {Array.from({ length: 10 }).map((_, i) => (
              <div key={i} className="aspect-[421/614] w-full animate-pulse rounded-md bg-bg-elevated" />
            ))}
          </div>
        ) : cards.length === 0 && unknownIds.length === 0 ? (
          <p className="px-3 py-4 text-sm text-text-secondary">{emptyMessage}</p>
        ) : visible.length === 0 && unknownIds.length === 0 ? (
          <p className="px-3 py-4 text-sm text-text-secondary">No cards match.</p>
        ) : (
          <div
            data-testid="card-pool-grid"
            style={{ height: rowVirtualizer.getTotalSize() + 24, position: "relative" }}
          >
            {virtualItems.map((vRow) => {
              const start = vRow.index * columns;
              const rowEntries = entries.slice(start, start + columns);
              return (
                <div
                  key={vRow.key}
                  data-index={vRow.index}
                  ref={rowVirtualizer.measureElement}
                  className="grid gap-3 px-3"
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    width: "100%",
                    transform: `translateY(${vRow.start + 12}px)`,
                    paddingBottom: 12,
                    gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
                  }}
                >
                  {rowEntries.map((entry) =>
                    entry.kind === "card" ? (
                      <button
                        key={entry.card.id}
                        type="button"
                        aria-label={
                          onCardClick
                            ? cardActionLabel?.(entry.card) ?? `Select ${entry.card.name}`
                            : `Preview ${entry.card.name}`
                        }
                        className={cn(
                          "group flex w-full flex-col gap-2 rounded-lg border border-border/70 bg-bg-elevated/40 p-2 text-left focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent-primary",
                          cubeEditMode ? "cursor-pointer" : "transition-colors duration-150 hover:bg-bg-elevated",
                          onCardClick && "cursor-pointer",
                        )}
                        onClick={(e) => {
                          if (onCardClick) {
                            onCardClick(entry.card);
                            return;
                          }
                          if (!previewEnabled) {
                            return;
                          }
                          setTapped(entry.card);
                          setPopupPosition(getPopupPosition(e.currentTarget.getBoundingClientRect()));
                        }}
                        onMouseEnter={(e) => handleEnter(entry.card, e.currentTarget.getBoundingClientRect())}
                        onMouseLeave={handleLeave}
                        onFocus={(e) => handleEnter(entry.card, e.currentTarget.getBoundingClientRect())}
                        onBlur={handleLeave}
                      >
                        <div className="relative aspect-[421/614] w-full overflow-hidden rounded-md bg-bg-elevated">
                          {imageErrors.has(entry.card.id) ? (
                            <div className="flex h-full w-full items-center justify-center text-xs text-text-muted">?</div>
                          ) : (
                            <CardArt
                              smallSrc={
                                cubeEditMode
                                  ? entry.card.imageUrl || entry.card.imageUrlSmall
                                  : entry.card.imageUrlSmall || entry.card.imageUrl
                              }
                              fullSrc={entry.card.imageUrl}
                              alt={entry.card.name}
                              sizes={
                                cubeEditMode
                                  ? "(min-width: 1280px) 220px, (min-width: 1024px) 180px, 45vw"
                                  : "(min-width: 1536px) 120px, 160px"
                              }
                              className="object-cover"
                              onError={() => handleImageError(entry.card.id)}
                            />
                          )}
                          {(entry.card.qty ?? 1) > 1 && (
                            <span className="absolute bottom-1 right-1 rounded bg-black/75 px-1 py-0.5 text-[0.65rem] font-bold tabular-nums text-white">
                              ×{entry.card.qty}
                            </span>
                          )}
                        </div>
                        <div className="min-w-0">
                          <p className="line-clamp-2 text-sm font-medium leading-snug text-text-primary">
                            {entry.card.name}
                          </p>
                          <span
                            className={cn(
                              "mt-1 inline-flex rounded px-1.5 py-0.5 text-[0.65rem] font-semibold uppercase",
                              getTypeBadgeClass(entry.card.type),
                            )}
                          >
                            {getTypeLabel(entry.card.type)}
                          </span>
                        </div>
                      </button>
                    ) : (
                      <div
                        key={`unknown-${entry.id}`}
                        data-testid="card-pool-grid-unknown"
                        title={`Passcode ${entry.id} is not in the catalog yet`}
                        aria-label={`Passcode ${entry.id} not in catalog yet`}
                        className="flex w-full flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-border/70 bg-bg-elevated/20 p-2 text-center"
                      >
                        <div className="flex aspect-[421/614] w-full items-center justify-center rounded-md bg-bg-elevated/40 font-mono text-xs text-text-muted">
                          {entry.id}
                        </div>
                        <p className="text-[0.65rem] text-text-muted">not in catalog yet</p>
                      </div>
                    ),
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {hoveredCard && popupPosition && !tapped && (
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

// Memoized: this grid renders one image per card (hundreds for a cube
// preview). Without memo, unrelated parent state — e.g. typing in the
// create-draft form's name field — re-renders every tile and the page lags.
export const CardPoolGrid = memo(CardPoolGridBase);
