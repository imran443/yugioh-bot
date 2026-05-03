"use client";

import { useState } from "react";
import { useDraftStore } from "@/lib/stores/draft-store";
import { downloadYdk } from "@/lib/ydk";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/sheet";
import {
  Layers,
  Swords,
  Scroll,
  ShieldAlert,
  ChevronUp,
  Download,
  Eye,
} from "lucide-react";

interface PoolPanelProps {
  className?: string;
}

export function PoolPanel({ className }: PoolPanelProps) {
  const myPool = useDraftStore((s) => s.myPool);
  const [showFullPool, setShowFullPool] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);

  const monsterCount = myPool.filter((c) =>
    c.type.toLowerCase().includes("monster")
  ).length;
  const spellCount = myPool.filter((c) =>
    c.type.toLowerCase().includes("spell")
  ).length;
  const trapCount = myPool.filter((c) =>
    c.type.toLowerCase().includes("trap")
  ).length;

  const handleExportYDK = () => {
    downloadYdk(myPool, "draft-pool.ydk");
  };

  const panelContent = (
    <div className="flex flex-col gap-4">
      {/* Summary stats */}
      <div className="grid grid-cols-3 gap-2">
        <div className="flex flex-col items-center rounded-lg bg-bg-elevated p-2">
          <Swords className="mb-1 h-4 w-4 text-accent-primary" aria-hidden="true" />
          <span className="font-display text-lg text-text-primary">{monsterCount}</span>
          <span className="text-xs text-text-secondary">Monsters</span>
        </div>
        <div className="flex flex-col items-center rounded-lg bg-bg-elevated p-2">
          <Scroll className="mb-1 h-4 w-4 text-accent-gold" aria-hidden="true" />
          <span className="font-display text-lg text-text-primary">{spellCount}</span>
          <span className="text-xs text-text-secondary">Spells</span>
        </div>
        <div className="flex flex-col items-center rounded-lg bg-bg-elevated p-2">
          <ShieldAlert
            className="mb-1 h-4 w-4 text-accent-cta"
            aria-hidden="true"
          />
          <span className="font-display text-lg text-text-primary">{trapCount}</span>
          <span className="text-xs text-text-secondary">Traps</span>
        </div>
      </div>

      {/* Total */}
      <div className="flex items-center justify-between rounded-lg border border-border bg-bg-elevated/50 px-3 py-2">
        <div className="flex items-center gap-2">
          <Layers className="h-4 w-4 text-text-secondary" aria-hidden="true" />
          <span className="text-sm text-text-secondary">Total cards</span>
        </div>
        <span className="font-display text-lg text-text-primary">{myPool.length}</span>
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
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setShowFullPool(true)}
          disabled={myPool.length === 0}
          className="w-full"
        >
          <Eye className="mr-1.5 h-4 w-4" aria-hidden="true" />
          View Full Pool
        </Button>
      </div>
    </div>
  );

  return (
    <>
      {/* Desktop/Tablet panel */}
      <div
        className={cn(
          "hidden rounded-xl border border-border bg-surface p-4 shadow-card sm:block",
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

      {/* Full pool view */}
      <Sheet
        open={showFullPool}
        onClose={() => setShowFullPool(false)}
        title="Full Pool"
      >
        <div className="flex flex-col gap-2">
          {myPool.length === 0 && (
            <p className="text-sm text-text-secondary">No cards drafted yet.</p>
          )}
          {myPool.map((card) => (
            <div
              key={card.id}
              className="flex items-center gap-3 rounded-lg border border-border bg-bg-elevated/50 p-2"
            >
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded bg-bg-elevated text-xs font-semibold text-text-secondary">
                {card.type.toLowerCase().includes("monster")
                  ? "M"
                  : card.type.toLowerCase().includes("spell")
                    ? "S"
                    : card.type.toLowerCase().includes("trap")
                      ? "T"
                      : "?"}
              </div>
              <span className="min-w-0 flex-1 truncate text-sm text-text-primary">
                {card.name}
              </span>
            </div>
          ))}
        </div>
      </Sheet>
    </>
  );
}
