"use client";

import { useState, useEffect } from "react";
import { Swords, Check } from "lucide-react";
import { MatchCard, type MatchProjection } from "./match-card";
import { projectMatch } from "@yugidraft/shared/scoring";
import type { Match } from "./types";

export function YourActionCard({
  actionMatch,
  tournamentSlug,
  tournamentFormat,
  currentUserPlayerId,
  onChanged,
}: {
  actionMatch: Match | null;
  tournamentSlug: string;
  tournamentFormat: string;
  currentUserPlayerId: number | null;
  onChanged: () => void;
}) {
  const [reporting, setReporting] = useState(false);
  const [projection, setProjection] = useState<MatchProjection | null>(null);

  // Fetch projection when we know both players
  useEffect(() => {
    setProjection(null);
    if (!actionMatch || !currentUserPlayerId) return;

    const oppId =
      actionMatch.playerOneId === currentUserPlayerId
        ? actionMatch.playerTwoId
        : actionMatch.playerOneId;

    if (!oppId) return;

    let cancelled = false;
    Promise.all([
      fetch(`/api/player/${currentUserPlayerId}`).then((r) => r.ok ? r.json() : null),
      fetch(`/api/player/${oppId}`).then((r) => r.ok ? r.json() : null),
    ]).then(([myProfile, oppProfile]) => {
      if (cancelled) return;
      const myElo: number = myProfile?.rating ?? 1000;
      const oppElo: number = oppProfile?.rating ?? 1000;
      const proj = projectMatch({ myElo, oppElo, seasonMultiplier: 1 });
      setProjection({ winWinnings: proj.winWinnings, winRating: proj.winRating, loseRating: proj.loseRating });
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [actionMatch, currentUserPlayerId]);

  if (!actionMatch) {
    return (
      <section className="mb-6 flex items-center gap-3 rounded-xl border border-border bg-surface p-5 text-text-secondary">
        <Check className="h-5 w-5 text-accent-success" />
        <span>You&apos;re all caught up — nothing needs your attention right now.</span>
      </section>
    );
  }

  return (
    <section className="mb-6 rounded-xl border border-accent-primary/40 bg-accent-primary/5 p-5">
      <div className="mb-3 flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-accent-primary">
        <Swords className="h-4 w-4" />
        Your match — Round {actionMatch.roundNumber}
      </div>
      <MatchCard
        match={actionMatch}
        tournamentSlug={tournamentSlug}
        tournamentFormat={tournamentFormat}
        currentUserPlayerId={currentUserPlayerId}
        isHost={false}
        isReporting={reporting}
        projection={projection}
        onReport={() => setReporting(true)}
        onCancelReport={() => setReporting(false)}
        onReported={() => {
          setReporting(false);
          onChanged();
        }}
        onResolved={onChanged}
      />
    </section>
  );
}
