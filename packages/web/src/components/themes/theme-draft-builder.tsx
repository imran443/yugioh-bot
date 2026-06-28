"use client";

import * as React from "react";
import Link from "next/link";
import { Plus, Trash2, Pencil, Search } from "lucide-react";
import { Button } from "@/components/ui/button";

interface AllowedTheme {
  id: number;
  name: string;
  archetype: string | null;
  mainCount: number;
  extraCount: number;
}

interface ThemeDraftBuilderProps {
  slug: string;
  allowedThemes: AllowedTheme[];
  uniqueThemes: boolean;
  onChanged: () => void;
}

export function ThemeDraftBuilder({ slug, allowedThemes, uniqueThemes, onChanged }: ThemeDraftBuilderProps) {
  const [query, setQuery] = React.useState("");
  const [suggestions, setSuggestions] = React.useState<string[]>([]);
  const [blankName, setBlankName] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [info, setInfo] = React.useState<string | null>(null);
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

  const post = async (body: Record<string, unknown>, successInfo: string) => {
    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      const res = await fetch(`/api/drafts/${slug}/themes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(
          res.status === 502
            ? `${data.error ?? "Couldn't reach the card database."} You can still add a blank cube and import passcodes in its editor.`
            : data.error ?? "Failed to add theme cube",
        );
        return;
      }
      setInfo(successInfo);
      setQuery("");
      setBlankName("");
      setSuggestions([]);
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  const addArchetype = (name: string) => {
    const archetype = name.trim();
    if (!archetype) return;
    void post({ kind: "archetype", archetype }, `Added "${archetype}" — seeding its cards…`);
  };

  const addBlank = () => {
    if (!blankName.trim()) return;
    void post({ kind: "blank", name: blankName.trim() }, `Added blank cube "${blankName.trim()}".`);
  };

  const remove = async (themeId: number) => {
    setBusy(true);
    setError(null);
    try {
      await fetch(`/api/drafts/${slug}/themes`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ themeId }),
      });
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="rounded-xl border border-border bg-surface p-4">
      <div className="mb-1 flex items-center justify-between">
        <h2 className="font-display text-lg text-text-primary">Theme cubes</h2>
        <span className="text-xs text-text-secondary">{allowedThemes.length} cube{allowedThemes.length === 1 ? "" : "s"}</span>
      </div>
      <p className="mb-3 text-sm text-text-secondary">
        Add archetypes one at a time — each becomes its own editable cube. {uniqueThemes ? "Max players = number of cubes." : ""}
      </p>

      {error && <div className="mb-3 rounded-lg border border-accent-cta/50 bg-accent-cta/10 px-3 py-2 text-sm text-accent-cta">{error}</div>}
      {info && <div className="mb-3 rounded-lg border border-accent-primary/40 bg-accent-primary/10 px-3 py-2 text-sm text-accent-primary">{info}</div>}

      {/* Archetype type-ahead */}
      <div className="relative mb-3">
        <label htmlFor="archetype-search" className="mb-1 flex items-center gap-1 text-sm font-medium text-text-primary">
          <Search className="h-3.5 w-3.5" /> Search archetype
        </label>
        <div className="flex gap-2">
          <input
            id="archetype-search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="blue-eyes, dark magician, ..."
            autoComplete="off"
            className="w-full rounded-lg border border-border bg-bg-elevated px-3 py-2 text-sm text-text-primary placeholder:text-text-secondary focus:border-accent-primary focus:outline-none"
          />
          <Button type="button" variant="primary" size="sm" disabled={busy || query.trim().length === 0} onClick={() => addArchetype(query)}>
            <Plus className="h-4 w-4" /> Add
          </Button>
        </div>
        {suggestions.length > 0 && (
          <div className="absolute z-10 mt-1 max-h-56 w-full overflow-auto rounded-lg border border-border bg-bg-surface shadow-card">
            {suggestions.map((name) => (
              <button
                key={name}
                type="button"
                onClick={() => addArchetype(name)}
                className="block w-full px-3 py-2 text-left text-sm text-text-primary hover:bg-bg-elevated"
              >
                {name}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Blank custom cube */}
      <div className="mb-4 flex gap-2">
        <input
          value={blankName}
          onChange={(e) => setBlankName(e.target.value)}
          placeholder="Custom cube name (e.g. Stun)"
          className="w-full rounded-lg border border-border bg-bg-elevated px-3 py-2 text-sm text-text-primary placeholder:text-text-secondary focus:border-accent-primary focus:outline-none"
        />
        <Button type="button" variant="secondary" size="sm" disabled={busy || blankName.trim().length === 0} onClick={addBlank}>
          <Plus className="h-4 w-4" /> Blank
        </Button>
      </div>

      {/* Cube list */}
      {allowedThemes.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border px-3 py-4 text-center text-sm text-text-secondary">
          No cubes yet. Search an archetype above or add a blank cube to start.
        </p>
      ) : (
        <ul className="space-y-2">
          {allowedThemes.map((theme) => (
            <li key={theme.id} className="flex items-center justify-between rounded-lg border border-border bg-bg-elevated/40 px-3 py-2">
              <div>
                <p className="font-display text-text-primary">{theme.name}</p>
                <p className="text-xs text-text-secondary">
                  {theme.archetype ? `${theme.archetype} · ` : ""}{theme.mainCount} main · {theme.extraCount} extra
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Link href={`/themes/${theme.id}`} className="inline-flex items-center gap-1 rounded-lg border border-border px-2 py-1 text-xs text-text-secondary hover:text-text-primary" title="Edit / view cube">
                  <Pencil className="h-3.5 w-3.5" /> Edit
                </Link>
                <button type="button" disabled={busy} onClick={() => void remove(theme.id)} className="inline-flex items-center gap-1 rounded-lg border border-accent-cta/40 px-2 py-1 text-xs text-accent-cta hover:bg-accent-cta/10" title="Remove cube">
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
