"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";

interface CubeSummary {
  id: number;
  name: string;
  archetype: string | null;
  mainCount: number;
  extraCount: number;
}

export function CubesLibraryList() {
  const router = useRouter();
  const [cubes, setCubes] = React.useState<CubeSummary[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const load = React.useCallback(() => {
    fetch("/api/cubes")
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error("load failed"))))
      .then((data: { cubes: CubeSummary[] }) => {
        setCubes(data.cubes ?? []);
        setLoading(false);
      })
      .catch(() => {
        setError("Failed to load cubes.");
        setLoading(false);
      });
  }, []);

  React.useEffect(() => load(), [load]);

  const deleteCube = async (id: number, name: string) => {
    if (typeof window !== "undefined" && !window.confirm(`Delete "${name}"? This can't be undone.`)) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/cubes/${id}`, { method: "DELETE" });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setError(data.error ?? "Failed to delete cube.");
        return;
      }
      setCubes((cur) => cur.filter((c) => c.id !== id));
    } finally {
      setBusy(false);
    }
  };

  const create = async (body: Record<string, unknown>) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/cubes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await res.json().catch(() => ({}))) as { cube?: { id: number }; error?: string };
      if (!res.ok || !data.cube) {
        setError(data.error ?? "Failed to create cube.");
        return;
      }
      router.push(`/cubes/${data.cube.id}`);
    } finally {
      setBusy(false);
    }
  };

  // Create a fresh blank cube (auto-named to avoid collisions) and jump straight
  // into its editor, where the user names it and builds the pool.
  const addCube = () => {
    const existing = new Set(cubes.map((c) => c.name));
    let name = "New cube";
    let n = 2;
    while (existing.has(name)) name = `New cube ${n++}`;
    void create({ kind: "blank", name });
  };

  return (
    <div className="space-y-6">
      {error && <p className="rounded-lg border border-accent-cta/50 bg-accent-cta/10 px-4 py-3 text-sm text-accent-cta">{error}</p>}

      <div className="flex items-center justify-end">
        <Button type="button" variant="primary" disabled={busy} onClick={() => addCube()}>
          <Plus className="h-4 w-4" /> Add cube
        </Button>
      </div>

      {loading ? (
        <p className="text-sm text-text-secondary">Loading cubes...</p>
      ) : cubes.length === 0 ? (
        <div className="rounded-lg border border-border bg-surface p-8 text-center">
          <p className="text-lg text-text-secondary">No cubes yet</p>
          <p className="mt-2 text-sm text-text-muted">Click &ldquo;Add cube&rdquo; to build your first one.</p>
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {cubes.map((cube) => (
            <div key={cube.id} className="relative">
            <Link
              href={`/cubes/${cube.id}`}
              className="block rounded-lg border border-border bg-surface p-4 pr-10 hover:border-accent-primary"
            >
              <p className="font-display text-text-primary">{cube.name}</p>
              {cube.archetype && <p className="mt-1 text-xs text-accent-primary">{cube.archetype}</p>}
              <p className="mt-2 text-sm text-text-secondary">{cube.mainCount} main · {cube.extraCount} extra</p>
            </Link>
            <button
              type="button"
              disabled={busy}
              onClick={() => void deleteCube(cube.id, cube.name)}
              title={`Delete ${cube.name}`}
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
