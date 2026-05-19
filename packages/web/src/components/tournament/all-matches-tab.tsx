"use client";

import { useState } from "react";
import { MatchCard } from "./match-card";
import type { TournamentDetail } from "./types";

export function AllMatchesTab({
  tournament,
  tournamentSlug,
  onChanged,
  isHost = false,
}: {
  tournament: TournamentDetail;
  tournamentSlug: string;
  onChanged: () => void;
  isHost?: boolean;
}) {
  const [reportingMatch, setReportingMatch] = useState<number | null>(null);

  const rounds = Array.from(new Set(tournament.matches.map((m) => m.roundNumber))).sort(
    (a, b) => a - b,
  );

  if (tournament.matches.length === 0) {
    return <p className="text-sm text-text-secondary">No matches yet.</p>;
  }

  return (
    <div>
      {rounds.map((round) => (
        <div key={round} className="mb-6">
          <h3 className="mb-3 text-sm font-semibold text-text-muted">Round {round}</h3>
          <div className="space-y-3">
            {tournament.matches
              .filter((m) => m.roundNumber === round)
              .map((match) => (
                <MatchCard
                  key={match.id}
                  match={match}
                  tournamentSlug={tournamentSlug}
                  tournamentFormat={tournament.format}
                  currentUserPlayerId={tournament.currentUserPlayerId}
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
      ))}
    </div>
  );
}
