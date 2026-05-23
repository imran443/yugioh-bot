"use client";

import { useEffect, useState } from "react";
import { ChevronRight } from "lucide-react";
import type { StandingsRow } from "./types";

function rankGlyph(index: number): string {
  if (index === 0) return "🥇";
  if (index === 1) return "🥈";
  if (index === 2) return "🥉";
  return `${index + 1}`;
}

export function OverviewStandings({
  tournamentSlug,
  currentUserPlayerId,
  onGoToStandings,
}: {
  tournamentSlug: string;
  currentUserPlayerId: number | null;
  onGoToStandings: () => void;
}) {
  const [standings, setStandings] = useState<StandingsRow[] | null>(null);

  useEffect(() => {
    let active = true;
    fetch(`/api/tournaments/${tournamentSlug}/standings`)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((data: StandingsRow[]) => {
        if (active) setStandings(data);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [tournamentSlug]);

  return (
    <section className="rounded-xl border border-border bg-surface p-5">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="font-body text-sm font-semibold uppercase tracking-wider text-text-secondary">
          Top standings
        </h2>
        <button
          type="button"
          onClick={onGoToStandings}
          className="inline-flex min-h-[44px] items-center gap-1 py-2 text-xs text-accent-primary hover:underline"
        >
          See full standings
          <ChevronRight className="h-3.5 w-3.5" />
        </button>
      </div>

      {standings === null ? (
        <div className="space-y-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="h-6 animate-pulse rounded bg-bg-deep" />
          ))}
        </div>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-text-muted">
              <th className="py-1">#</th>
              <th>Player</th>
              <th className="text-right">W</th>
              <th className="text-right">L</th>
            </tr>
          </thead>
          <tbody>
            {standings.slice(0, 3).map((r, i) => (
              <tr key={r.playerId} className="border-t border-border">
                <td className="py-1.5 font-mono text-text-muted">{rankGlyph(i)}</td>
                <td
                  className={`max-w-0 truncate ${
                    r.playerId === currentUserPlayerId
                      ? "font-semibold text-accent-primary"
                      : "text-text-primary"
                  }`}
                  title={r.displayName}
                >
                  {r.displayName}
                </td>
                <td className="w-8 text-right tabular-nums text-accent-success">{r.wins}</td>
                <td className="w-8 text-right tabular-nums text-text-secondary">{r.losses}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
