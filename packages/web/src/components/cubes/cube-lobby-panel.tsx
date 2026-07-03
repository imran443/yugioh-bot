"use client";

import * as React from "react";

interface AllowedCube {
  id: number;
  name: string;
  archetype: string | null;
  mainCount: number;
  extraCount: number;
  sampleImages: string[];
}

interface CubeLobbyPanelProps {
  slug: string;
  allowedCubes: AllowedCube[];
  themeSelection: "host_assigned" | "random" | "player_pick";
  onClaimed?: () => void;
}

export function CubeLobbyPanel({ slug, allowedCubes, themeSelection, onClaimed }: CubeLobbyPanelProps) {
  const [claiming, setClaiming] = React.useState<number | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [preflight, setPreflight] = React.useState<{ errors: string[]; warnings: string[] } | null>(null);

  React.useEffect(() => {
    fetch(`/api/drafts/${slug}/preflight`)
      .then((res) => (res.ok ? res.json() : { errors: [], warnings: [] }))
      .then((data) => setPreflight(data))
      .catch(() => {});
  }, [slug]);

  const claim = async (cubeId: number) => {
    setClaiming(cubeId);
    setError(null);
    try {
      const res = await fetch(`/api/drafts/${slug}/claim-cube`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cubeId }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error ?? "Could not claim cube");
        return;
      }
      onClaimed?.();
    } finally {
      setClaiming(null);
    }
  };

  return (
    <section className="rounded-xl border border-border bg-surface p-4">
      <h2 className="mb-3 font-display text-lg text-text-primary">Themes</h2>

      {preflight?.errors.length ? (
        <div className="mb-3 rounded-lg border border-accent-cta/50 bg-accent-cta/10 px-3 py-2 text-sm text-accent-cta">
          {preflight.errors.map((e, i) => <p key={i}>{e}</p>)}
        </div>
      ) : null}
      {preflight?.warnings.length ? (
        <div className="mb-3 rounded-lg border border-accent-gold/40 bg-accent-gold/10 px-3 py-2 text-sm text-accent-gold">
          {preflight.warnings.map((w, i) => <p key={i}>{w}</p>)}
          <p className="mt-1 text-xs opacity-80">You can re-roll, edit the cube, turn the Extra phase off, or proceed anyway.</p>
        </div>
      ) : null}
      {error && <div className="mb-3 rounded-lg border border-accent-cta/50 bg-accent-cta/10 px-3 py-2 text-sm text-accent-cta">{error}</div>}

      {themeSelection === "random" ? (
        <p className="text-sm text-text-secondary">Themes are assigned randomly and revealed at start.</p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {allowedCubes.map((cube) => (
            <div key={cube.id} className="rounded-lg border border-border bg-bg-elevated/40 p-3 transition-colors hover:border-border/80">
              <p className="font-display text-text-primary">{cube.name}</p>
              {cube.archetype && cube.archetype !== cube.name && <p className="text-xs text-accent-primary">{cube.archetype}</p>}
              <p className="mt-1 text-xs tabular-nums text-text-secondary">{cube.mainCount} main, {cube.extraCount} extra</p>
              {cube.sampleImages.length > 0 && (
                <div className="mt-2 flex gap-1">
                  {cube.sampleImages.slice(0, 4).map((img, i) => (
                    <img key={i} src={img} alt="" className="h-12 w-8 rounded object-contain" />
                  ))}
                </div>
              )}
              {themeSelection === "player_pick" && (
                <button
                  type="button"
                  onClick={() => void claim(cube.id)}
                  disabled={claiming !== null}
                  className="mt-2 w-full rounded-lg border border-accent-primary/60 bg-accent-primary/10 px-3 py-1.5 text-sm font-semibold text-accent-primary transition-colors hover:bg-accent-primary/20 motion-safe:active:translate-y-px disabled:opacity-50"
                >
                  {claiming === cube.id ? "Claiming..." : "Claim"}
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
