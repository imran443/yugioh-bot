"use client";

import { MatchBoard } from "./match-board";
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
  return (
    <MatchBoard
      matches={tournament.matches}
      tournamentSlug={tournamentSlug}
      tournamentFormat={tournament.format}
      currentUserPlayerId={tournament.currentUserPlayerId}
      isHost={isHost}
      onChanged={onChanged}
      emptyMessage="No matches yet."
    />
  );
}
