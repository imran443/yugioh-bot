"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";

type Season = {
  id: number;
  number: number;
  name: string | null;
  status: "active" | "ended";
  startedAt: string;
  endedAt: string | null;
};

type LeaderboardRow = {
  playerId: number;
  displayName: string;
  winnings: number;
};

export function SeasonControl() {
  const [season, setSeason] = React.useState<Season | null | undefined>(undefined);
  const [loadError, setLoadError] = React.useState<string | null>(null);

  const [seasonName, setSeasonName] = React.useState("");
  const [startLoading, setStartLoading] = React.useState(false);
  const [startError, setStartError] = React.useState<string | null>(null);

  const [endLoading, setEndLoading] = React.useState(false);
  const [endError, setEndError] = React.useState<string | null>(null);
  const [confirmEnd, setConfirmEnd] = React.useState(false);

  const [lastChampion, setLastChampion] = React.useState<LeaderboardRow | null>(null);

  const fetchSeason = React.useCallback(async () => {
    setLoadError(null);
    try {
      const res = await fetch("/api/admin/season");
      if (!res.ok) {
        setLoadError("Failed to load season status.");
        return;
      }
      const data = (await res.json()) as { season: Season | null };
      setSeason(data.season);
    } catch {
      setLoadError("Failed to load season status.");
    }
  }, []);

  React.useEffect(() => {
    void fetchSeason();
  }, [fetchSeason]);

  const handleStart = async () => {
    setStartError(null);
    setStartLoading(true);
    try {
      const res = await fetch("/api/admin/season", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "start", name: seasonName.trim() || undefined }),
      });
      const data = (await res.json()) as { season?: Season; error?: string };
      if (!res.ok || data.error) {
        setStartError(data.error ?? `Failed to start season (${res.status}).`);
        return;
      }
      setSeason(data.season ?? null);
      setSeasonName("");
      setLastChampion(null);
    } finally {
      setStartLoading(false);
    }
  };

  const fetchLastChampion = async () => {
    try {
      const res = await fetch("/api/leaderboard?scope=all");
      if (!res.ok) return;
      const data = (await res.json()) as { rows: LeaderboardRow[] };
      if (data.rows.length > 0) {
        setLastChampion(data.rows[0]);
      }
    } catch {
      // best-effort
    }
  };

  const handleEnd = async () => {
    setEndError(null);
    setEndLoading(true);
    try {
      const res = await fetch("/api/admin/season", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "end" }),
      });
      const data = (await res.json()) as { season?: Season; error?: string };
      if (!res.ok || data.error) {
        setEndError(data.error ?? `Failed to end season (${res.status}).`);
        return;
      }
      setSeason(data.season ?? null);
      setConfirmEnd(false);
      await fetchLastChampion();
    } finally {
      setEndLoading(false);
    }
  };

  const formatDate = (iso: string) =>
    new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });

  return (
    <section className="rounded-xl border border-border bg-surface p-6">
      <h2 className="mb-4 font-display text-lg text-text-primary">Season</h2>

      {loadError && <p className="mb-3 text-sm text-destructive">{loadError}</p>}

      {season === undefined && !loadError && (
        <p className="mb-4 text-sm text-text-secondary">Loading season status...</p>
      )}

      {season !== undefined && (
        <div className="mb-4 rounded-lg border border-border bg-bg-elevated/40 px-4 py-3">
          {season?.status === "active" ? (
            <div>
              <p className="text-sm font-semibold text-text-primary">
                Season {season.number}{season.name ? ` — ${season.name}` : ""}
              </p>
              <p className="text-xs text-text-muted">Started {formatDate(season.startedAt)}</p>
            </div>
          ) : (
            <p className="text-sm text-text-secondary">No active season</p>
          )}
        </div>
      )}

      {lastChampion && (
        <div className="mb-4 rounded-lg border border-accent-primary/30 bg-accent-primary/10 px-4 py-3">
          <p className="text-sm text-text-primary">
            Last season champion:{" "}
            <span className="font-semibold">{lastChampion.displayName}</span>{" "}
            <span className="text-text-muted">({lastChampion.winnings} pts)</span>
          </p>
        </div>
      )}

      <div className="space-y-6">
        {/* Start Season */}
        {season?.status !== "active" && (
          <div className="space-y-3">
            <h3 className="text-sm font-medium text-text-primary">Start New Season</h3>
            <div>
              <label htmlFor="season-name" className="mb-1 block text-xs text-text-secondary">
                Season name (optional)
              </label>
              <input
                id="season-name"
                type="text"
                value={seasonName}
                onChange={(e) => setSeasonName(e.target.value)}
                placeholder="e.g. Spring 2025"
                className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text-primary placeholder:text-text-muted focus:border-accent-primary focus:outline-none"
              />
            </div>
            {startError && <p className="text-sm text-destructive">{startError}</p>}
            <Button
              variant="primary"
              size="sm"
              loading={startLoading}
              onClick={() => void handleStart()}
            >
              Start Season
            </Button>
          </div>
        )}

        {/* End Season */}
        {season?.status === "active" && (
          <div className="space-y-3">
            <h3 className="text-sm font-medium text-text-primary">End Season</h3>
            {endError && <p className="text-sm text-destructive">{endError}</p>}
            {confirmEnd ? (
              <div className="flex items-center gap-3">
                <span className="text-sm text-text-secondary">End Season {season.number}?</span>
                <Button
                  variant="danger"
                  size="sm"
                  loading={endLoading}
                  onClick={() => void handleEnd()}
                >
                  Confirm End
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={endLoading}
                  onClick={() => setConfirmEnd(false)}
                >
                  Cancel
                </Button>
              </div>
            ) : (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => { setEndError(null); setConfirmEnd(true); }}
              >
                End Season
              </Button>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
