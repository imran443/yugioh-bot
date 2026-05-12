"use client";

import { useState } from "react";
import { useDraftStore } from "@/lib/stores/draft-store";
import { downloadYdk } from "@/lib/ydk";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/sheet";
import { CardPoolGrid } from "@/components/cards/card-pool-grid";
import { Layers, ChevronUp, Download } from "lucide-react";

interface PoolPanelProps {
  className?: string;
}

export function PoolPanel({ className }: PoolPanelProps) {
  const myPool = useDraftStore((s) => s.myPool);
  const [mobileOpen, setMobileOpen] = useState(false);

  const panelContent = (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between rounded-xl border border-border/70 bg-bg-elevated/25 px-3 py-2">
        <span className="text-[0.65rem] font-semibold uppercase tracking-[0.2em] text-text-muted">Drafted so far</span>
        <span className="font-display text-lg text-text-secondary tabular-nums">{myPool.length}</span>
      </div>
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
      <div className="rounded-xl border border-border bg-bg-elevated/40 p-3">
        <CardPoolGrid cards={myPool} heightClassName="h-[26rem] xl:h-[34rem]" emptyMessage="No cards drafted yet." />
      </div>
    </div>
  );

  return (
    <>
      <div className={cn("hidden rounded-xl border border-border bg-surface p-3 sm:block", className)}>
        <h3 className="mb-3 font-display text-lg text-text-primary">Your Pool</h3>
        {panelContent}
      </div>
      <div className="sm:hidden">
        <button
          onClick={() => setMobileOpen(true)}
          className={cn("flex w-full items-center justify-between rounded-xl border border-border bg-surface p-4 shadow-card", className)}
        >
          <div className="flex items-center gap-2">
            <Layers className="h-5 w-5 text-text-secondary" aria-hidden="true" />
            <span className="font-semibold text-text-primary">Your Pool ({myPool.length})</span>
          </div>
          <ChevronUp className="h-5 w-5 text-text-secondary" aria-hidden="true" />
        </button>
      </div>
      <Sheet open={mobileOpen} onClose={() => setMobileOpen(false)} title="Your Pool">
        {panelContent}
      </Sheet>
    </>
  );
}
