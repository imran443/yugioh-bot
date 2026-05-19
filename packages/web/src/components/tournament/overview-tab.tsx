"use client";

import { useEffect, useState } from "react";
import { ChevronRight } from "lucide-react";
import { YourActionCard } from "./your-action-card";
import { deriveMyMatches } from "./use-my-matches";
import type { TournamentDetail, StandingsRow } from "./types";

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
  const [standings, setStandings] = useState<StandingsRow[] | null>(null);

  useEffect(() => {
    if (tournament.status !== "active") return;
    let active = true;
    fetch(`/api/tournaments/${tournamentSlug}/standings`)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((data: StandingsRow[]) => { if (active) setStandings(data); })
      .catch(() => {});
    return () => { active = false; };
  }, [tournamentSlug, tournament.status]);

  const { actionMatch } = deriveMyMatches(tournament);
  const showActionCard = tournament.status === "active" && tournament.isParticipant;

  const allRounds = tournament.matches.map((m) => m.roundNumber);
  const maxRound = allRounds.length > 0 ? Math.max(...allRounds) : 0;
  const highestActiveRound = allRounds.length > 0 ? Math.min(...allRounds) : 0;
  const completedMatches = tournament.matches.filter((m) => m.status === "completed").length;
  const totalMatches = tournament.matches.length;

  // Highest round that has at least one non-completed match, or maxRound if all done
  const currentRound =
    maxRound > 0
      ? tournament.matches.find((m) => m.status !== "completed")?.roundNumber ?? maxRound
      : 0;

  return (
    <div>
      {showActionCard && (
        <YourActionCard
          actionMatch={actionMatch}
          tournamentSlug={tournamentSlug}
          tournamentFormat={tournament.format}
          currentUserPlayerId={currentUserPlayerId}
          onChanged={onChanged}
        />
      )}

      {tournament.status === "active" && totalMatches > 0 && (
        <section className="mb-6 rounded-xl border border-border bg-surface p-5">
          <p className="text-sm text-text-secondary">
            <span className="font-semibold text-text-primary">
              Round {currentRound} of {maxRound}
            </span>
            {" · "}
            {completedMatches}/{totalMatches} matches done
          </p>
          <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-bg-deep">
            <div
              className="h-full bg-accent-primary motion-safe:transition-all motion-safe:duration-300"
              style={{
                width: totalMatches > 0 ? `${(completedMatches / totalMatches) * 100}%` : "0%",
              }}
            />
          </div>
        </section>
      )}

      {tournament.status === "active" && (
        <section className="rounded-xl border border-border bg-surface p-5">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="font-body text-sm font-semibold uppercase tracking-wider text-text-secondary">
              Top Standings
            </h2>
            <button
              type="button"
              onClick={onGoToStandings}
              className="inline-flex items-center gap-1 text-xs text-accent-primary hover:underline"
            >
              See full standings
              <ChevronRight className="h-3.5 w-3.5" />
            </button>
          </div>

          {standings === null ? (
            <div className="space-y-2">
              {Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="h-6 animate-pulse rounded bg-surface" />
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
                    <td className="py-1.5 text-text-muted">{i + 1}</td>
                    <td
                      className={
                        r.playerId === currentUserPlayerId
                          ? "font-semibold text-accent-primary"
                          : "text-text-primary"
                      }
                    >
                      {r.displayName}
                    </td>
                    <td className="text-right text-accent-success">{r.wins}</td>
                    <td className="text-right text-text-secondary">{r.losses}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}
    </div>
  );
}
