"use client";

import { useState } from "react";
import { Swords, Check } from "lucide-react";
import { MatchCard } from "./match-card";
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
  const roundLabel =
    tournamentFormat === "single_elim" && actionMatch != null
      ? ` — Round ${actionMatch.roundNumber}`
      : "";

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
        Your match{roundLabel}
      </div>
      <MatchCard
        match={actionMatch}
        tournamentSlug={tournamentSlug}
        tournamentFormat={tournamentFormat}
        currentUserPlayerId={currentUserPlayerId}
        isHost={false}
        isReporting={reporting}
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
