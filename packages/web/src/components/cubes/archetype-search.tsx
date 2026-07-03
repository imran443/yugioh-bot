"use client";

import * as React from "react";
import { Plus, Search } from "lucide-react";
import { Button } from "@/components/ui/button";

interface ArchetypeSearchProps {
  /** Called with the chosen archetype name (from a suggestion or the Add button). */
  onSelect: (archetype: string) => void;
  disabled?: boolean;
  label?: string;
  /** id for the text input (label association). */
  inputId?: string;
}

/**
 * Reusable archetype type-ahead: debounced suggestions from `/api/archetypes`,
 * graceful when the API can't be reached. Shared by the cube editor seed flow and
 * the shared cube-draft pool builder ("Add a whole archetype"). It only emits the
 * selected name; the caller decides how to resolve/union the archetype's cards.
 */
export function ArchetypeSearch({
  onSelect,
  disabled = false,
  label = "Search archetype",
  inputId = "archetype-search",
}: ArchetypeSearchProps) {
  const [query, setQuery] = React.useState("");
  const [suggestions, setSuggestions] = React.useState<string[]>([]);
  const reqId = React.useRef(0);

  React.useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setSuggestions([]);
      return;
    }
    const myReq = ++reqId.current;
    const t = setTimeout(() => {
      fetch(`/api/archetypes?query=${encodeURIComponent(q)}`)
        .then((res) => (res.ok ? res.json() : { archetypes: [] }))
        .then((data: { archetypes: string[] }) => {
          if (myReq === reqId.current) setSuggestions((data.archetypes ?? []).slice(0, 8));
        })
        .catch(() => {
          if (myReq === reqId.current) setSuggestions([]);
        });
    }, 250);
    return () => clearTimeout(t);
  }, [query]);

  const choose = (name: string) => {
    const archetype = name.trim();
    if (!archetype) return;
    onSelect(archetype);
    setQuery("");
    setSuggestions([]);
  };

  return (
    <div className="relative">
      <label htmlFor={inputId} className="mb-1 flex items-center gap-1 text-sm font-medium text-text-primary">
        <Search className="h-3.5 w-3.5" /> {label}
      </label>
      <div className="flex gap-2">
        <input
          id={inputId}
          aria-label={label}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="blue-eyes, dark magician, ..."
          autoComplete="off"
          className="w-full rounded-lg border border-border bg-bg-elevated px-3 py-2 text-sm text-text-primary placeholder:text-text-secondary focus:border-accent-primary focus:outline-none"
        />
        <Button
          type="button"
          variant="primary"
          size="sm"
          className="shrink-0 whitespace-nowrap"
          disabled={disabled || query.trim().length === 0}
          onClick={() => choose(query)}
        >
          <Plus className="h-4 w-4" /> Add
        </Button>
      </div>
      {suggestions.length > 0 && (
        <div className="absolute z-10 mt-1 max-h-56 w-full overflow-auto rounded-lg border border-border bg-bg-surface shadow-card">
          {suggestions.map((name) => (
            <button
              key={name}
              type="button"
              onClick={() => choose(name)}
              className="block w-full px-3 py-2 text-left text-sm text-text-primary hover:bg-bg-elevated"
            >
              {name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
