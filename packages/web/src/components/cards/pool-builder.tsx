"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { parseCustomCardIds } from "@/lib/custom-card-pool";
import { getCached, putCards } from "@/lib/cards-cache";
import type { CardSummary } from "@/lib/card-types";
import { SetPicker } from "@/components/draft/set-picker";
import { CardPoolGrid } from "@/components/cards/card-pool-grid";

export interface PoolBuilderValue {
  setNames: string[];
  customCardText: string;
}

interface PoolBuilderProps {
  value: PoolBuilderValue;
  onChange: (value: PoolBuilderValue) => void;
  previewHeightClassName?: string;
}

const DEBOUNCE_MS = 300;

export function PoolBuilder({ value, onChange, previewHeightClassName = "h-[22rem]" }: PoolBuilderProps) {
  const parsed = useMemo(() => parseCustomCardIds(value.customCardText), [value.customCardText]);
  const [cards, setCards] = useState<CardSummary[]>([]);
  const [unknownIds, setUnknownIds] = useState<number[]>([]);
  const [loading, setLoading] = useState(false);
  const [apiError, setApiError] = useState<string | null>(null);
  const reqId = useRef(0);

  const signature = useMemo(
    () => JSON.stringify({ s: [...value.setNames].sort(), c: [...parsed.cardIds].sort((a, b) => a - b) }),
    [value.setNames, parsed.cardIds],
  );

  useEffect(() => {
    const setNames = value.setNames;
    const customCardIds = parsed.cardIds;
    if (setNames.length === 0 && customCardIds.length === 0) {
      setCards([]);
      setUnknownIds([]);
      setLoading(false);
      return;
    }
    const handle = setTimeout(async () => {
      const myReq = ++reqId.current;
      setLoading(true);
      setApiError(null);
      const { hits } = getCached(customCardIds);
      try {
        const res = await fetch("/api/cards/resolve", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ setNames, customCardIds }),
        });
        if (myReq !== reqId.current) return;
        if (!res.ok) { setApiError("Failed to resolve cards. Please try again."); setLoading(false); return; }
        const data = (await res.json()) as { cards: CardSummary[]; unknownIds: number[] };
        if (myReq !== reqId.current) return;
        putCards(data.cards);
        const byId = new Map<number, CardSummary>();
        for (const c of [...hits, ...data.cards]) byId.set(c.id, c);
        setCards([...byId.values()]);
        setUnknownIds(data.unknownIds);
      } catch {
        if (myReq === reqId.current) { /* keep prior cards */ }
      } finally {
        if (myReq === reqId.current) setLoading(false);
      }
    }, DEBOUNCE_MS);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);

  const count = cards.length;

  return (
    <div className="space-y-4">
      <div>
        <label className="mb-1 block text-sm font-medium text-text-primary">Sets</label>
        <SetPicker selectedSets={value.setNames} onSetsChange={(setNames) => onChange({ ...value, setNames })} />
      </div>

      <div>
        <label htmlFor="custom-card-ids" className="mb-1 block text-sm font-medium text-text-primary">Custom Card IDs</label>
        <textarea
          id="custom-card-ids"
          value={value.customCardText}
          onChange={(e) => onChange({ ...value, customCardText: e.target.value })}
          placeholder={"46986414\n83764718, 12345678"}
          rows={4}
          className="w-full resize-y rounded-lg border border-border bg-bg-elevated px-3 py-2 font-mono text-sm text-text-primary placeholder:text-text-secondary focus:border-accent-primary focus:outline-none"
        />
        <div className="mt-2 flex flex-col gap-1 text-xs sm:flex-row sm:items-center sm:justify-between">
          <p className="text-text-secondary">Paste YGOPRODeck passcodes separated by new lines, commas, or spaces.</p>
          {parsed.errors.length > 0 && <p className="text-accent-cta">Invalid: {parsed.errors.slice(0, 3).join(", ")}</p>}
        </div>
      </div>

      {apiError && <p className="text-sm text-destructive">{apiError}</p>}

      <div>
        <div className="mb-1 flex items-center gap-2 text-sm font-medium text-text-primary">
          <span>Pool preview</span>
          <span aria-live="polite" className="text-text-secondary tabular-nums">— {count} card{count === 1 ? "" : "s"}</span>
          {loading && <span className="text-xs text-text-muted">resolving…</span>}
        </div>
        <CardPoolGrid
          cards={cards}
          unknownIds={unknownIds}
          loading={loading}
          heightClassName={previewHeightClassName}
          emptyMessage="Add sets or card IDs above to preview the pool."
          showSummary={false}
        />
      </div>
    </div>
  );
}
