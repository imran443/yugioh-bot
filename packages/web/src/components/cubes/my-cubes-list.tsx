"use client";

import * as React from "react";
import Link from "next/link";
import { Boxes, ChevronRight } from "lucide-react";

interface SavedPool {
  id: number;
  name: string;
  setNames: string[];
  customCardIds: number[];
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

export function MyCubesList() {
  const [pools, setPools] = React.useState<SavedPool[]>([]);
  const [loaded, setLoaded] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    fetch("/api/draft-templates")
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error("load failed"))))
      .then((data: { templates?: SavedPool[] }) => {
        if (!cancelled) setPools(data.templates ?? []);
      })
      .catch(() => {
        if (!cancelled) setError("Failed to load saved pools.");
      })
      .finally(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) {
    return <p className="rounded-lg border border-accent-cta/50 bg-accent-cta/10 px-4 py-3 text-sm text-accent-cta">{error}</p>;
  }

  if (!loaded) {
    return <p className="text-sm text-text-secondary">Loading saved pools...</p>;
  }

  if (pools.length === 0) {
    return (
      <div className="rounded-xl border border-border bg-surface p-8 text-center">
        <Boxes className="mx-auto mb-4 h-12 w-12 text-text-muted" />
        <p className="text-lg font-semibold text-text-primary">No saved pools yet</p>
        <p className="mt-2 text-sm text-text-secondary">Saved card pools created in drafts or settings will appear here.</p>
      </div>
    );
  }

  return (
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
      {pools.map((pool) => (
        <Link
          key={pool.id}
          href={`/cubes/${pool.id}`}
          className="group rounded-xl border border-border bg-surface p-5 shadow-card transition-colors hover:border-accent-primary/70 hover:bg-bg-elevated/60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-primary"
        >
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <h2 className="truncate font-display text-lg text-text-primary">{pool.name}</h2>
              <p className="mt-2 text-sm text-text-secondary">
                {plural(pool.customCardIds.length, "passcode")} · {plural(pool.setNames.length, "set")}
              </p>
            </div>
            <ChevronRight className="mt-1 h-5 w-5 shrink-0 text-text-muted transition-transform group-hover:translate-x-0.5 group-hover:text-accent-primary" />
          </div>
        </Link>
      ))}
    </div>
  );
}
