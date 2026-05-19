"use client";

import { useState } from "react";
import { MatchCard } from "./match-card";
import type { Match } from "./types";

export function MatchBoard({
  matches,
  tournamentSlug,
  tournamentFormat,
  currentUserPlayerId,
  isHost,
  onChanged,
  emptyMessage = "You do not have any matches in this view yet.",
}: {
  matches: Match[];
  tournamentSlug: string;
  tournamentFormat: string;
  currentUserPlayerId: number | null;
  isHost: boolean;
  onChanged: () => void;
  emptyMessage?: string;
}) {
  const [reportingMatch, setReportingMatch] = useState<number | null>(null);

  const rounds = Array.from(new Set(matches.map((m) => m.roundNumber))).sort(
    (a, b) => a - b,
  );

  if (matches.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-border bg-surface px-5 py-6 text-sm text-text-secondary">
        {emptyMessage}
      </div>
    );
  }

  return (
    <div
      data-testid="tournament-round-board"
      className="overflow-x-auto pb-3 xl:overflow-visible"
    >
      <div
        data-testid="tournament-round-board-grid"
        className="flex min-w-max gap-4 xl:min-w-0 xl:grid xl:gap-5 2xl:flex 2xl:flex-wrap 2xl:items-start"
        style={{ gridTemplateColumns: `repeat(${rounds.length}, minmax(26rem, 1fr))` }}
      >
        {rounds.map((round) => {
          const roundMatches = matches.filter((m) => m.roundNumber === round);
          return (
            <div
              key={round}
              data-testid={`tournament-round-column-${round}`}
              className="w-[24rem] shrink-0 rounded-2xl border border-border bg-surface/70 p-4 xl:w-auto xl:min-w-0 xl:max-w-none 2xl:min-w-[28rem] 2xl:flex-1"
            >
              <div className="mb-4 flex items-center justify-between gap-3 border-b border-border pb-3">
                <h3 className="text-sm font-semibold uppercase tracking-wider text-text-secondary">
                  Round {round}
                </h3>
                <span className="text-xs text-text-muted">
                  {roundMatches.length} match{roundMatches.length === 1 ? "" : "es"}
                </span>
              </div>
              <div className="space-y-3">
                {roundMatches.map((match) => (
                  <MatchCard
                    key={match.id}
                    match={match}
                    tournamentSlug={tournamentSlug}
                    tournamentFormat={tournamentFormat}
                    currentUserPlayerId={currentUserPlayerId}
                    isHost={isHost}
                    isReporting={reportingMatch === match.id}
                    onReport={() => setReportingMatch(match.id)}
                    onCancelReport={() => setReportingMatch(null)}
                    onReported={() => {
                      setReportingMatch(null);
                      onChanged();
                    }}
                    onResolved={onChanged}
                  />
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
