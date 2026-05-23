"use client";

import { YourActionCard } from "./your-action-card";
import { TournamentSettingsForm } from "./tournament-settings-form";
import { OverviewProgress } from "./overview-progress";
import { OverviewRecentResults } from "./overview-recent-results";
import { OverviewStandings } from "./overview-standings";
import { OverviewInfo } from "./overview-info";
import { OverviewHostControls } from "./overview-host-controls";
import { deriveMyMatches } from "./use-my-matches";
import type { TournamentDetail } from "./types";

export function OverviewTab({
  tournament,
  tournamentSlug,
  isHost,
  currentUserPlayerId,
  onChanged,
  onGoToStandings,
}: {
  tournament: TournamentDetail;
  tournamentSlug: string;
  isHost: boolean;
  currentUserPlayerId: number | null;
  onChanged: () => void;
  onGoToStandings: () => void;
}) {
  const isActive = tournament.status === "active";
  const { actionMatch } = deriveMyMatches(tournament);
  const showActionCard = isActive && tournament.isParticipant;

  if (!isActive) {
    // Non-active overview is never reached today (page only mounts Overview for
    // active tournaments), but guard so the component is safe in isolation.
    return (
      <div className="grid gap-6 lg:grid-cols-12">
        <div className="lg:col-span-5 lg:col-start-8">
          <OverviewInfo tournament={tournament} />
        </div>
      </div>
    );
  }

  // Mobile-first: everything is a full-width column by default. Progress and the
  // action card span full width at the top so they read first on mobile; at lg the
  // secondary cards drop into a right rail. Source order == mobile priority.
  return (
    <div className="space-y-6">
      {showActionCard && (
        <YourActionCard
          actionMatch={actionMatch}
          tournamentSlug={tournamentSlug}
          tournamentFormat={tournament.format}
          currentUserPlayerId={currentUserPlayerId}
          onChanged={onChanged}
        />
      )}
      <OverviewProgress tournament={tournament} />

      <div className="grid gap-6 lg:grid-cols-12">
        <div className="space-y-6 lg:col-span-7">
          <OverviewStandings
            tournamentSlug={tournamentSlug}
            currentUserPlayerId={currentUserPlayerId}
            onGoToStandings={onGoToStandings}
          />
          <OverviewRecentResults matches={tournament.matches} />
        </div>

        <aside className="space-y-6 lg:col-span-5">
          <OverviewInfo tournament={tournament} />
          {isHost && (
            <TournamentSettingsForm
              tournamentSlug={tournamentSlug}
              initialDeadlineAt={tournament.deadlineAt}
              initialReportConfirmWindowHours={tournament.reportConfirmWindowHours}
              onSaved={onChanged}
            />
          )}
          {isHost && <OverviewHostControls tournamentSlug={tournamentSlug} />}
        </aside>
      </div>
    </div>
  );
}
