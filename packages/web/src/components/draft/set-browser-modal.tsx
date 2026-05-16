"use client";

import * as React from "react";
import { Modal } from "@/components/ui/modal";
import { Search, Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

type SetInfo = {
  setName: string;
  setCode: string;
  cardCount: number;
};

type CardPreview = {
  ygoprodeckId: number;
  name: string;
  imageUrlSmall: string;
};

type SetBrowserModalProps = {
  open: boolean;
  onClose: () => void;
  selectedSets: string[];
  onToggleSet: (setName: string) => void;
};

export function SetBrowserModal({ open, onClose, selectedSets, onToggleSet }: SetBrowserModalProps) {
  const [query, setQuery] = React.useState("");
  const [allSets, setAllSets] = React.useState<SetInfo[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [previewSet, setPreviewSet] = React.useState<string | null>(null);
  const [previewData, setPreviewData] = React.useState<{
    cardCount: number;
    sampleCards: CardPreview[];
  } | null>(null);
  const [previewLoading, setPreviewLoading] = React.useState(false);

  React.useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    fetch("/api/sets")
      .then((res) => res.json())
      .then((data) => {
        if (!cancelled) setAllSets(data.sets ?? []);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const filtered = React.useMemo(() => {
    if (!query.trim()) return allSets;
    const q = query.toLowerCase();
    return allSets.filter(
      (s) => s.setName.toLowerCase().includes(q) || s.setCode.toLowerCase().includes(q)
    );
  }, [query, allSets]);

  React.useEffect(() => {
    if (!previewSet) {
      setPreviewData(null);
      return;
    }
    let cancelled = false;
    setPreviewLoading(true);
    fetch(`/api/sets/${encodeURIComponent(previewSet)}`)
      .then((res) => res.json())
      .then((data) => {
        if (!cancelled) {
          setPreviewData({
            cardCount: data.cardCount ?? 0,
            sampleCards: (data.sampleCards ?? []) as CardPreview[],
          });
        }
      })
      .catch(() => {
        if (!cancelled) setPreviewData(null);
      })
      .finally(() => {
        if (!cancelled) setPreviewLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [previewSet]);

  return (
    <Modal open={open} onClose={onClose} title="Browse Sets">
      <div className="flex flex-col gap-4" style={{ minHeight: "400px", maxHeight: "70vh" }}>
        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-secondary" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter sets..."
            className="w-full rounded-lg border border-border bg-bg-deep py-2 pl-10 pr-3 text-sm text-text-primary placeholder:text-text-secondary focus:border-accent-primary focus:outline-none"
          />
        </div>

        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="flex items-center justify-center py-12 text-text-secondary">
              Loading sets...
            </div>
          ) : filtered.length === 0 ? (
            <div className="flex items-center justify-center py-12 text-text-secondary">
              No sets found
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-2">
              {filtered.map((set) => (
                <div key={set.setName} className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setPreviewSet(set.setName === previewSet ? null : set.setName)}
                    className={cn(
                      "flex-1 rounded-lg border px-3 py-2 text-left text-sm transition-colors",
                      set.setName === previewSet
                        ? "border-accent-primary bg-accent-primary/10 text-text-primary"
                        : "border-border bg-surface text-text-primary hover:bg-bg-elevated"
                    )}
                  >
                    <div className="font-medium">{set.setName}</div>
                    <div className="text-xs text-text-secondary">
                      {set.setCode} &middot; {set.cardCount} cards
                    </div>
                  </button>
                  <Button
                    variant={selectedSets.includes(set.setName) ? "primary" : "secondary"}
                    size="sm"
                    onClick={() => onToggleSet(set.setName)}
                  >
                    {selectedSets.includes(set.setName) ? (
                      <><Check className="h-3 w-3" /> Added</>
                    ) : (
                      "Add"
                    )}
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>

        {previewSet && (
          <div className="rounded-lg border border-border bg-bg-deep p-3">
            <div className="mb-2 text-sm font-medium text-text-primary">{previewSet}</div>
            {previewLoading ? (
              <div className="text-sm text-text-secondary">Loading preview...</div>
            ) : previewData ? (
              <>
                <div className="mb-2 text-xs text-text-secondary">
                  {previewData.cardCount} cards in set
                </div>
                {previewData.sampleCards.length > 0 && (
                  <div className="grid grid-cols-3 gap-2">
                    {previewData.sampleCards.slice(0, 6).map((card) => (
                      <div key={card.ygoprodeckId} className="text-center">
                        {card.imageUrlSmall && (
                          <img
                            src={card.imageUrlSmall}
                            alt={card.name}
                            className="mx-auto h-24 rounded-lg object-cover"
                            loading="lazy"
                          />
                        )}
                        <div className="mt-1 truncate text-xs text-text-secondary">{card.name}</div>
                      </div>
                    ))}
                  </div>
                )}
              </>
            ) : (
              <div className="text-sm text-text-secondary">No preview available</div>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}
