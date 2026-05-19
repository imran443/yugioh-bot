"use client";

import { useState } from "react";
import { MatchCard } from "./match-card";
import { YourActionCard } from "./your-action-card";
import { deriveMyMatches } from "./use-my-matches";
import type { TournamentDetail } from "./types";

export function MyMatchesTab({
  tournament,
  tournamentSlug,
  onChanged,
}: {
  tournament: TournamentDetail;
  tournamentSlug: string;
  onChanged: () => void;
}) {
  const [reportingMatch, setReportingMatch] = useState<number | null>(null);

  if (!tournament.isParticipant || tournament.currentUserPlayerId === null) {
    return (
      <p className="text-sm text-text-secondary">
        You&apos;re not participating in this tournament.
      </p>
    );
  }

  const { mine, actionMatch } = deriveMyMatches(tournament);
  const remainingMine = actionMatch ? mine.filter((m) => m.id !== actionMatch.id) : mine;

  return (
    <div>
      <YourActionCard
        actionMatch={actionMatch}
        tournamentSlug={tournamentSlug}
        tournamentFormat={tournament.format}
        currentUserPlayerId={tournament.currentUserPlayerId}
        onChanged={onChanged}
      />

      {remainingMine.length > 0 && (
        <section>
          <h3 className="mb-3 text-sm font-semibold text-text-muted">Your Matches</h3>
          <div className="space-y-3">
            {remainingMine.map((match) => (
              <MatchCard
                key={match.id}
                match={match}
                tournamentSlug={tournamentSlug}
                tournamentFormat={tournament.format}
                currentUserPlayerId={tournament.currentUserPlayerId}
                isHost={false}
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
        </section>
      )}
    </div>
  );
}
