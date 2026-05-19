"use client";

import { useEffect, useState } from "react";
import type { StandingsRow } from "./types";

export function StandingsTab({ tournamentSlug }: { tournamentSlug: string }) {
  const [rows, setRows] = useState<StandingsRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    fetch(`/api/tournaments/${tournamentSlug}/standings`)
      .then((r) => {
        if (!r.ok) throw new Error("Failed to load standings");
        return r.json();
      })
      .then((data: StandingsRow[]) => {
        if (active) setRows(data);
      })
      .catch((e) => active && setError(e instanceof Error ? e.message : "Failed"));
    return () => { active = false; };
  }, [tournamentSlug]);

  if (error) return <p className="text-accent-cta">{error}</p>;
  if (!rows) return <div className="h-24 animate-pulse rounded-xl bg-surface" />;

  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="text-left text-text-muted">
          <th className="py-2">#</th>
          <th>Player</th>
          <th className="text-right">W</th>
          <th className="text-right">L</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={r.playerId} className="border-t border-border">
            <td className="py-2 text-text-muted">{i + 1}</td>
            <td className="text-text-primary">{r.displayName}</td>
            <td className="text-right text-accent-success">{r.wins}</td>
            <td className="text-right text-text-secondary">{r.losses}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
