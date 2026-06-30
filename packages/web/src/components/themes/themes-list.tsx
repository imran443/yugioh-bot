"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";

interface ThemeSummary {
  id: number;
  name: string;
  archetype: string | null;
  mainCount: number;
  extraCount: number;
}

export function ThemesList() {
  const router = useRouter();
  const [themes, setThemes] = React.useState<ThemeSummary[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const load = React.useCallback(() => {
    fetch("/api/themes")
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error("load failed"))))
      .then((data: { themes: ThemeSummary[] }) => {
        setThemes(data.themes ?? []);
        setLoading(false);
      })
      .catch(() => {
        setError("Failed to load themes.");
        setLoading(false);
      });
  }, []);

  React.useEffect(() => load(), [load]);

  const deleteTheme = async (id: number, name: string) => {
    if (typeof window !== "undefined" && !window.confirm(`Delete "${name}"? This can't be undone.`)) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/themes/${id}`, { method: "DELETE" });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setError(data.error ?? "Failed to delete theme.");
        return;
      }
      setThemes((cur) => cur.filter((t) => t.id !== id));
    } finally {
      setBusy(false);
    }
  };

  const create = async (body: Record<string, unknown>) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/themes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await res.json().catch(() => ({}))) as { theme?: { id: number }; error?: string };
      if (!res.ok || !data.theme) {
        setError(data.error ?? "Failed to create theme.");
        return;
      }
      router.push(`/themes/${data.theme.id}`);
    } finally {
      setBusy(false);
    }
  };

  // Create a fresh blank theme (auto-named to avoid collisions) and jump straight
  // into its editor, where the user names it and builds the pool.
  const addTheme = () => {
    const existing = new Set(themes.map((t) => t.name));
    let name = "New theme";
    let n = 2;
    while (existing.has(name)) name = `New theme ${n++}`;
    void create({ kind: "blank", name });
  };

  return (
    <div className="space-y-6">
      {error && <p className="rounded-lg border border-accent-cta/50 bg-accent-cta/10 px-4 py-3 text-sm text-accent-cta">{error}</p>}

      <div className="flex items-center justify-end">
        <Button type="button" variant="primary" disabled={busy} onClick={() => addTheme()}>
          <Plus className="h-4 w-4" /> Add theme
        </Button>
      </div>

      {loading ? (
        <p className="text-sm text-text-secondary">Loading themes...</p>
      ) : themes.length === 0 ? (
        <div className="rounded-lg border border-border bg-surface p-8 text-center">
          <p className="text-lg text-text-secondary">No themes yet</p>
          <p className="mt-2 text-sm text-text-muted">Click &ldquo;Add theme&rdquo; to build your first one.</p>
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {themes.map((theme) => (
            <div key={theme.id} className="relative">
            <Link
              href={`/themes/${theme.id}`}
              className="block rounded-lg border border-border bg-surface p-4 pr-10 hover:border-accent-primary"
            >
              <p className="font-display text-text-primary">{theme.name}</p>
              {theme.archetype && <p className="mt-1 text-xs text-accent-primary">{theme.archetype}</p>}
              <p className="mt-2 text-sm text-text-secondary">{theme.mainCount} main · {theme.extraCount} extra</p>
            </Link>
            <button
              type="button"
              disabled={busy}
              onClick={() => void deleteTheme(theme.id, theme.name)}
              title={`Delete ${theme.name}`}
              className="absolute right-2 top-2 rounded-lg border border-accent-cta/40 p-1.5 text-accent-cta hover:bg-accent-cta/10 disabled:opacity-50"
            >
              <Trash2 className="h-4 w-4" />
            </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
