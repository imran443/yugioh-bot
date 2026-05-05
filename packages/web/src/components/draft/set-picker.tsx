"use client";

import * as React from "react";
import { Search, X, Grid3X3 } from "lucide-react";
import { SetBrowserModal } from "./set-browser-modal";
import { cn } from "@/lib/utils";

type SetResult = {
  setName: string;
  setCode: string;
  cardCount: number;
};

type SetPickerProps = {
  selectedSets: string[];
  onSetsChange: (sets: string[]) => void;
};

export function SetPicker({ selectedSets, onSetsChange }: SetPickerProps) {
  const [query, setQuery] = React.useState("");
  const [results, setResults] = React.useState<SetResult[]>([]);
  const [showResults, setShowResults] = React.useState(false);
  const [loading, setLoading] = React.useState(false);
  const [browserOpen, setBrowserOpen] = React.useState(false);
  const debounceRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  React.useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);

    if (!query.trim()) {
      setResults([]);
      setShowResults(false);
      return;
    }

    debounceRef.current = setTimeout(async () => {
      setLoading(true);
      try {
        const res = await fetch(`/api/sets?q=${encodeURIComponent(query.trim())}`);
        if (res.ok) {
          const data = await res.json();
          setResults(data.sets ?? []);
          setShowResults(true);
        }
      } catch {
        setResults([]);
      } finally {
        setLoading(false);
      }
    }, 300);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query]);

  const handleSelect = (setName: string) => {
    if (!selectedSets.includes(setName)) {
      onSetsChange([...selectedSets, setName]);
    }
    setQuery("");
    setShowResults(false);
  };

  const handleRemove = (setName: string) => {
    onSetsChange(selectedSets.filter((s) => s !== setName));
  };

  const handleToggleSet = (setName: string) => {
    if (selectedSets.includes(setName)) {
      onSetsChange(selectedSets.filter((s) => s !== setName));
    } else {
      onSetsChange([...selectedSets, setName]);
    }
  };

  return (
    <div>
      <div className="flex gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-secondary" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search sets..."
            className="w-full rounded-lg border border-border bg-surface py-2 pl-10 pr-3 text-sm text-text-primary placeholder:text-text-secondary focus:border-accent-primary focus:outline-none"
          />
          {loading && (
            <div className="absolute right-3 top-1/2 -translate-y-1/2">
              <div className="h-4 w-4 motion-safe:animate-spin rounded-full border-2 border-accent-primary border-t-transparent" />
            </div>
          )}
          {showResults && results.length > 0 && (
            <div className="absolute z-20 mt-1 max-h-60 w-full overflow-y-auto rounded-lg border border-border bg-surface shadow-card">
              {results.map((set) => (
                <button
                  key={set.setName}
                  type="button"
                  onClick={() => handleSelect(set.setName)}
                  className={cn(
                    "flex w-full items-center gap-3 px-3 py-2 text-left text-sm hover:bg-bg-elevated",
                    selectedSets.includes(set.setName) && "text-accent-primary"
                  )}
                >
                  <div className="flex-1">
                    <div className="font-medium">{set.setName}</div>
                    <div className="text-xs text-text-secondary">
                      {set.setCode} &middot; {set.cardCount} cards
                    </div>
                  </div>
                  {selectedSets.includes(set.setName) && (
                    <span className="text-xs text-accent-primary">Added</span>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={() => setBrowserOpen(true)}
          className="flex items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text-secondary hover:bg-bg-elevated hover:text-text-primary"
        >
          <Grid3X3 className="h-4 w-4" />
          Browse
        </button>
      </div>

      {selectedSets.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2">
          {selectedSets.map((setName) => (
            <span
              key={setName}
              className="inline-flex items-center gap-1 rounded-full bg-accent-primary/20 px-3 py-1 text-sm text-accent-primary"
            >
              {setName}
              <button
                type="button"
                onClick={() => handleRemove(setName)}
                className="ml-1 hover:text-white"
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
      )}

      <SetBrowserModal
        open={browserOpen}
        onClose={() => setBrowserOpen(false)}
        selectedSets={selectedSets}
        onToggleSet={handleToggleSet}
      />
    </div>
  );
}