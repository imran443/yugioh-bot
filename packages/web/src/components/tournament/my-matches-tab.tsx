"use client";

import { MatchBoard } from "./match-board";
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
  if (!tournament.isParticipant || tournament.currentUserPlayerId === null) {
    return (
      <p className="text-sm text-text-secondary">
        You&apos;re not participating in this tournament.
      </p>
    );
  }

  const { mine, actionMatch } = deriveMyMatches(tournament);
  const remainingMine = actionMatch ? mine.filter((m) => m.id !== actionMatch.id) : mine;

  if (mine.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-border bg-surface px-5 py-6 text-sm text-text-secondary">
        You do not have any matches in this view yet.
      </div>
    );
  }

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
          <MatchBoard
            matches={remainingMine}
            tournamentSlug={tournamentSlug}
            tournamentFormat={tournament.format}
            currentUserPlayerId={tournament.currentUserPlayerId}
            isHost={false}
            onChanged={onChanged}
          />
        </section>
      )}
    </div>
  );
}
