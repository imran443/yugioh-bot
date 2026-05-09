"use client";

import { useDeferredValue, useMemo, useState, useCallback } from "react";
import Image from "next/image";
import { useDraftStore, type DraftCardDetail } from "@/lib/stores/draft-store";
import { downloadYdk } from "@/lib/ydk";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/sheet";
import { CardHoverPopup } from "@/components/draft/card-hover-popup";
import { Layers, Swords, Scroll, ShieldAlert, ChevronUp, Download, ArrowUpDown } from "lucide-react";

type PoolFilter = "all" | "monster" | "spell" | "trap";
type PoolSort = "newest" | "oldest" | "name" | "type";

interface PoolPanelProps {
  className?: string;
}

const POPUP_WIDTH = 288;
const POPUP_HEIGHT = 560;
const POPUP_MARGIN = 16;

function getPopupPosition(rect: DOMRect): { left: number; top: number } {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  // Panel is on the right side — prefer showing popup to the left
  const leftOfItem = rect.left - POPUP_WIDTH - POPUP_MARGIN;
  const left = Math.min(
    vw - POPUP_WIDTH - POPUP_MARGIN,
    Math.max(POPUP_MARGIN, leftOfItem),
  );
  const top = Math.min(
    vh - POPUP_HEIGHT - POPUP_MARGIN,
    Math.max(POPUP_MARGIN, rect.top + rect.height / 2 - POPUP_HEIGHT / 2),
  );
  return { left, top };
}

function isMonster(type: string) { return type.trim().toLowerCase().includes("monster"); }
function isSpell(type: string) { return type.trim().toLowerCase().includes("spell card"); }
function isTrap(type: string) { return type.trim().toLowerCase().includes("trap card"); }

function getTypeBadgeClass(type: string) {
  return isMonster(type)
    ? "bg-accent-primary/10 text-accent-primary"
    : isSpell(type)
      ? "bg-accent-gold/10 text-accent-gold"
      : "bg-accent-cta/10 text-accent-cta";
}

function getTypeLabel(type: string) {
  return isMonster(type) ? "Monster" : isSpell(type) ? "Spell" : isTrap(type) ? "Trap" : "Other";
}

export function PoolPanel({ className }: PoolPanelProps) {
  const myPool = useDraftStore((s) => s.myPool);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const [activeFilter, setActiveFilter] = useState<PoolFilter>("all");
  const [activeSort, setActiveSort] = useState<PoolSort>("newest");
  const [hoveredCard, setHoveredCard] = useState<DraftCardDetail | null>(null);
  const [popupPosition, setPopupPosition] = useState<{ left: number; top: number } | null>(null);
  const [imageErrors, setImageErrors] = useState<Set<number>>(new Set());
  const deferredSearchTerm = useDeferredValue(searchTerm);

  const { monsterCount, spellCount, trapCount } = useMemo(
    () => ({
      monsterCount: myPool.filter((c) => isMonster(c.type)).length,
      spellCount: myPool.filter((c) => isSpell(c.type)).length,
      trapCount: myPool.filter((c) => isTrap(c.type)).length,
    }),
    [myPool],
  );

  const handleImageError = useCallback(
    (id: number) => setImageErrors((prev) => new Set(prev).add(id)),
    [],
  );

  const handleMouseEnter = useCallback((card: DraftCardDetail, rect: DOMRect) => {
    setHoveredCard(card);
    setPopupPosition(getPopupPosition(rect));
  }, []);

  const handleMouseLeave = useCallback(() => {
    setHoveredCard(null);
    setPopupPosition(null);
  }, []);

  const filteredAndSorted = useMemo(() => {
    const needle = deferredSearchTerm.trim().toLowerCase();
    let cards = myPool.filter((card) => {
      const matchesSearch = needle.length === 0 || card.name.toLowerCase().includes(needle);
      const matchesFilter =
        activeFilter === "all" ||
        (activeFilter === "monster" && isMonster(card.type)) ||
        (activeFilter === "spell" && isSpell(card.type)) ||
        (activeFilter === "trap" && isTrap(card.type));
      return matchesSearch && matchesFilter;
    });

    if (activeSort === "newest") {
      cards = [...cards].reverse(); // myPool is oldest-first; reverse = newest first
    } else if (activeSort === "name") {
      cards = [...cards].sort((a, b) => a.name.localeCompare(b.name));
    } else if (activeSort === "type") {
      const order = (c: DraftCardDetail) =>
        isMonster(c.type) ? 0 : isSpell(c.type) ? 1 : isTrap(c.type) ? 2 : 3;
      cards = [...cards].sort((a, b) => order(a) - order(b));
    }
    // "oldest" = natural array order (no-op)
    return cards;
  }, [activeFilter, activeSort, deferredSearchTerm, myPool]);

  const filterButtons: Array<{ label: string; value: PoolFilter }> = [
    { label: "All", value: "all" },
    { label: "Monsters", value: "monster" },
    { label: "Spells", value: "spell" },
    { label: "Traps", value: "trap" },
  ];

  const sortButtons: Array<{ label: string; value: PoolSort }> = [
    { label: "Newest", value: "newest" },
    { label: "Oldest", value: "oldest" },
    { label: "Name", value: "name" },
    { label: "Type", value: "type" },
  ];

  const panelContent = (
    <div className="flex flex-col gap-4">
      {/* Drafted count */}
      <div className="flex items-center justify-between rounded-xl border border-border bg-bg-elevated/40 px-3 py-2">
        <span className="text-[0.7rem] font-semibold uppercase tracking-[0.22em] text-text-muted">
          Drafted so far
        </span>
        <span className="font-display text-xl text-text-primary">{myPool.length}</span>
      </div>

      {/* Summary stats */}
      <div className="grid grid-cols-3 gap-1.5">
        <div className="flex flex-col items-center rounded-lg bg-bg-elevated p-1.5">
          <Swords className="mb-1 h-4 w-4 text-accent-primary" aria-hidden="true" />
          <span className="font-display text-lg text-text-primary">{monsterCount}</span>
          <span className="text-xs text-text-secondary">Monsters</span>
        </div>
        <div className="flex flex-col items-center rounded-lg bg-bg-elevated p-1.5">
          <Scroll className="mb-1 h-4 w-4 text-accent-gold" aria-hidden="true" />
          <span className="font-display text-lg text-text-primary">{spellCount}</span>
          <span className="text-xs text-text-secondary">Spells</span>
        </div>
        <div className="flex flex-col items-center rounded-lg bg-bg-elevated p-1.5">
          <ShieldAlert className="mb-1 h-4 w-4 text-accent-cta" aria-hidden="true" />
          <span className="font-display text-lg text-text-primary">{trapCount}</span>
          <span className="text-xs text-text-secondary">Traps</span>
        </div>
      </div>

      {/* Export */}
      <Button
        variant="secondary"
        size="sm"
        onClick={() => downloadYdk(myPool, "draft-pool.ydk")}
        disabled={myPool.length === 0}
        className="w-full"
      >
        <Download className="mr-1.5 h-4 w-4" aria-hidden="true" />
        Export YDK
      </Button>

      {/* Search + filter + sort */}
      <div className="rounded-xl border border-border bg-bg-elevated/40 p-3">
        <div className="flex flex-col gap-3">
          <input
            type="text"
            aria-label="Search cards"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            placeholder="Search cards..."
            className="h-9 w-full rounded-lg border border-border bg-surface px-3 text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-accent-primary/60"
          />

          {/* Type filter pills */}
          <div className="flex flex-wrap gap-1.5">
            {filterButtons.map((fb) => (
              <Button
                key={fb.value}
                type="button"
                size="sm"
                variant={activeFilter === fb.value ? "secondary" : "ghost"}
                onClick={() => setActiveFilter(fb.value)}
                aria-pressed={activeFilter === fb.value}
                className="rounded-full px-3 text-xs"
              >
                {fb.label}
              </Button>
            ))}
          </div>

          {/* Sort pills */}
          <div className="flex flex-wrap items-center gap-1.5">
            <ArrowUpDown className="h-3.5 w-3.5 shrink-0 text-text-muted" aria-hidden="true" />
            {sortButtons.map((sb) => (
              <Button
                key={sb.value}
                type="button"
                size="sm"
                variant={activeSort === sb.value ? "secondary" : "ghost"}
                onClick={() => setActiveSort(sb.value)}
                aria-pressed={activeSort === sb.value}
                className="rounded-full px-3 text-xs"
              >
                {sb.label}
              </Button>
            ))}
          </div>

          {/* Card list */}
          <div className="h-72 overflow-y-auto rounded-lg border border-border bg-surface/70">
            {myPool.length === 0 ? (
              <p className="px-3 py-4 text-sm text-text-secondary">No cards drafted yet.</p>
            ) : filteredAndSorted.length === 0 ? (
              <p className="px-3 py-4 text-sm text-text-secondary">No cards match.</p>
            ) : (
              <div className="flex flex-col p-2">
                {filteredAndSorted.map((card) => (
                  <button
                    key={card.id}
                    type="button"
                    className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors duration-150 hover:bg-bg-elevated focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent-primary"
                    onMouseEnter={(e) =>
                      handleMouseEnter(card, e.currentTarget.getBoundingClientRect())
                    }
                    onMouseLeave={handleMouseLeave}
                    onFocus={(e) =>
                      handleMouseEnter(card, e.currentTarget.getBoundingClientRect())
                    }
                    onBlur={handleMouseLeave}
                  >
                    {/* 28×40 thumbnail */}
                    <div className="relative h-10 w-7 shrink-0 overflow-hidden rounded bg-bg-elevated">
                      {imageErrors.has(card.id) ? (
                        <div className="flex h-full w-full items-center justify-center text-[0.5rem] text-text-muted">
                          ?
                        </div>
                      ) : (
                        <Image
                          src={card.imageUrlSmall || card.imageUrl}
                          alt=""
                          fill
                          className="object-cover"
                          sizes="28px"
                          onError={() => handleImageError(card.id)}
                        />
                      )}
                    </div>

                    {/* Name + type badge + attribute + level */}
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-text-primary">{card.name}</p>
                      <div className="flex items-center gap-1.5">
                        <span
                          className={cn(
                            "rounded px-1 py-0.5 text-[0.6rem] font-semibold uppercase",
                            getTypeBadgeClass(card.type),
                          )}
                        >
                          {getTypeLabel(card.type)}
                        </span>
                        {card.attribute && !["SPELL", "TRAP"].includes(card.attribute) && (
                          <span className="text-[0.65rem] text-text-muted">{card.attribute}</span>
                        )}
                        {card.level !== undefined && (
                          <span className="text-[0.65rem] text-text-muted">Lv{card.level}</span>
                        )}
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Hover preview */}
      {hoveredCard && popupPosition && (
        <CardHoverPopup
          card={hoveredCard}
          position={popupPosition}
          imageError={imageErrors.has(hoveredCard.id)}
          onImageError={() => handleImageError(hoveredCard.id)}
        />
      )}
    </div>
  );

  return (
    <>
      {/* Desktop/Tablet */}
      <div
        className={cn("hidden rounded-xl border border-border bg-surface p-3 sm:block", className)}
      >
        <h3 className="mb-3 font-display text-lg text-text-primary">Your Pool</h3>
        {panelContent}
      </div>

      {/* Mobile trigger */}
      <div className="sm:hidden">
        <button
          onClick={() => setMobileOpen(true)}
          className={cn(
            "flex w-full items-center justify-between rounded-xl border border-border bg-surface p-4 shadow-card",
            className,
          )}
        >
          <div className="flex items-center gap-2">
            <Layers className="h-5 w-5 text-text-secondary" aria-hidden="true" />
            <span className="font-semibold text-text-primary">Your Pool ({myPool.length})</span>
          </div>
          <ChevronUp className="h-5 w-5 text-text-secondary" aria-hidden="true" />
        </button>
      </div>

      {/* Mobile sheet */}
      <Sheet open={mobileOpen} onClose={() => setMobileOpen(false)} title="Your Pool">
        {panelContent}
      </Sheet>
    </>
  );
}
