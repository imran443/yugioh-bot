"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Trash2 } from "lucide-react";
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
  const [name, setName] = React.useState("");
  const [archetype, setArchetype] = React.useState("");
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

  return (
    <div className="space-y-6">
      {error && <p className="rounded-lg border border-accent-cta/50 bg-accent-cta/10 px-4 py-3 text-sm text-accent-cta">{error}</p>}

      <section className="rounded-xl border border-border bg-surface p-4">
        <h2 className="mb-3 font-display text-lg text-text-primary">Create a theme</h2>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <div className="flex-1">
            <label htmlFor="theme-blank-name" className="mb-1 block text-sm font-medium text-text-primary">Blank theme name</label>
            <input
              id="theme-blank-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Stun"
              className="w-full rounded-lg border border-border bg-bg-elevated px-3 py-2 text-sm text-text-primary focus:border-accent-primary focus:outline-none"
            />
          </div>
          <Button type="button" variant="secondary" disabled={busy || name.trim().length === 0} onClick={() => void create({ kind: "blank", name: name.trim() })}>
            Create blank
          </Button>
        </div>
        <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-end">
          <div className="flex-1">
            <label htmlFor="theme-archetype" className="mb-1 block text-sm font-medium text-text-primary">Seed from archetype</label>
            <input
              id="theme-archetype"
              value={archetype}
              onChange={(e) => setArchetype(e.target.value)}
              placeholder="Blue-Eyes"
              className="w-full rounded-lg border border-border bg-bg-elevated px-3 py-2 text-sm text-text-primary focus:border-accent-primary focus:outline-none"
            />
          </div>
          <Button type="button" variant="primary" disabled={busy || archetype.trim().length === 0} onClick={() => void create({ kind: "archetype", archetype: archetype.trim() })}>
            Seed archetype
          </Button>
        </div>
      </section>

      {loading ? (
        <p className="text-sm text-text-secondary">Loading themes...</p>
      ) : themes.length === 0 ? (
        <div className="rounded-lg border border-border bg-surface p-8 text-center">
          <p className="text-lg text-text-secondary">No themes yet</p>
          <p className="mt-2 text-sm text-text-muted">Create a blank theme or seed one from an archetype above.</p>
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
