"use client";

import { useDeferredValue, useMemo, useState } from "react";
import { useDraftStore } from "@/lib/stores/draft-store";
import { downloadYdk } from "@/lib/ydk";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/sheet";
import { Layers, Swords, Scroll, ShieldAlert, ChevronUp, Download } from "lucide-react";

type PoolFilter = "all" | "monster" | "spell" | "trap";

interface PoolPanelProps {
  className?: string;
}

export function PoolPanel({ className }: PoolPanelProps) {
  const myPool = useDraftStore((s) => s.myPool);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const [activeFilter, setActiveFilter] = useState<PoolFilter>("all");
  const deferredSearchTerm = useDeferredValue(searchTerm);

  const normalizeCardType = (type: string) => type.trim().toLowerCase();
  const isMonster = (type: string) => normalizeCardType(type).includes("monster");
  const isSpell = (type: string) => normalizeCardType(type).includes("spell card");
  const isTrap = (type: string) => normalizeCardType(type).includes("trap card");
  const getTypeBadge = (type: string) =>
    isMonster(type) ? "M" : isSpell(type) ? "S" : isTrap(type) ? "T" : "?";
  const getCompactTypeLabel = (type: string) =>
    isMonster(type) ? "Monster" : isSpell(type) ? "Spell" : isTrap(type) ? "Trap" : "Other";

  const monsterCount = myPool.filter((c) => isMonster(c.type)).length;
  const spellCount = myPool.filter((c) => isSpell(c.type)).length;
  const trapCount = myPool.filter((c) => isTrap(c.type)).length;

  const filteredPool = useMemo(() => {
    const normalizedSearchTerm = deferredSearchTerm.trim().toLowerCase();

    return myPool.filter((card) => {
      const matchesSearch =
        normalizedSearchTerm.length === 0 ||
        card.name.toLowerCase().includes(normalizedSearchTerm);

      const matchesFilter =
        activeFilter === "all" ||
        (activeFilter === "monster" && isMonster(card.type)) ||
        (activeFilter === "spell" && isSpell(card.type)) ||
        (activeFilter === "trap" && isTrap(card.type));

      return matchesSearch && matchesFilter;
    });
  }, [activeFilter, deferredSearchTerm, myPool]);

  const handleExportYDK = () => {
    downloadYdk(myPool, "draft-pool.ydk");
  };

  const filterButtons: Array<{ ariaLabel: string; label: string; value: PoolFilter }> = [
    { ariaLabel: "All", label: "All", value: "all" },
    { ariaLabel: "Monsters", label: "Monsters", value: "monster" },
    { ariaLabel: "Spells", label: "Spells", value: "spell" },
    { ariaLabel: "Traps", label: "Traps", value: "trap" },
  ];

  const panelContent = (
    <div className="flex flex-col gap-4">
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
          <ShieldAlert
            className="mb-1 h-4 w-4 text-accent-cta"
            aria-hidden="true"
          />
          <span className="font-display text-lg text-text-primary">{trapCount}</span>
          <span className="text-xs text-text-secondary">Traps</span>
        </div>
      </div>

      {/* Actions */}
      <div className="flex flex-col gap-2">
        <Button
          variant="secondary"
          size="sm"
          onClick={handleExportYDK}
          disabled={myPool.length === 0}
          className="w-full"
        >
          <Download className="mr-1.5 h-4 w-4" aria-hidden="true" />
          Export YDK
        </Button>
      </div>

      <div className="rounded-xl border border-border bg-bg-elevated/40 p-3">
        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1.5 text-sm text-text-secondary">
            <span className="sr-only">Filter cards</span>
            <input
              type="text"
              aria-label="Filter cards"
              value={searchTerm}
              onChange={(event) => setSearchTerm(event.target.value)}
              placeholder="Filter cards..."
              className="h-9 w-full rounded-lg border border-border bg-surface px-3 text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-accent-primary/60"
            />
          </label>

          <div className="flex flex-wrap gap-2">
            {filterButtons.map((filterButton) => (
              <Button
                key={filterButton.value}
                type="button"
                size="sm"
                variant={activeFilter === filterButton.value ? "secondary" : "ghost"}
                onClick={() => setActiveFilter(filterButton.value)}
                aria-pressed={activeFilter === filterButton.value}
                aria-label={filterButton.ariaLabel}
                className="rounded-full px-3"
              >
                {filterButton.label}
              </Button>
            ))}
          </div>

          <div className="h-72 overflow-y-auto rounded-lg border border-border bg-surface/70">
            {myPool.length === 0 ? (
              <p className="px-3 py-4 text-sm text-text-secondary">No cards drafted yet.</p>
            ) : filteredPool.length === 0 ? (
              <p className="px-3 py-4 text-sm text-text-secondary">
                No cards match this filter.
              </p>
            ) : (
              <div className="flex flex-col p-2">
                {filteredPool.map((card) => (
                  <div
                    key={card.id}
                    className="flex items-center gap-3 rounded-lg px-2 py-2 text-sm text-text-primary"
                  >
                    <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded bg-bg-elevated text-xs font-semibold text-text-secondary">
                      {getTypeBadge(card.type)}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm text-text-primary">{card.name}</p>
                      <p className="truncate text-xs text-text-secondary">
                        {getCompactTypeLabel(card.type)}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );

  return (
    <>
      {/* Desktop/Tablet panel */}
        <div
          className={cn(
            "hidden rounded-xl border border-border bg-surface p-3 sm:block",
            className
          )}
        >
        <h3 className="mb-3 font-display text-lg text-text-primary">Your Pool</h3>
        {panelContent}
      </div>

      {/* Mobile bottom sheet trigger */}
      <div className="sm:hidden">
        <button
          onClick={() => setMobileOpen(true)}
          className={cn(
            "flex w-full items-center justify-between rounded-xl border border-border bg-surface p-4 shadow-card",
            className
          )}
        >
          <div className="flex items-center gap-2">
            <Layers className="h-5 w-5 text-text-secondary" aria-hidden="true" />
            <span className="font-semibold text-text-primary">
              Your Pool ({myPool.length})
            </span>
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
