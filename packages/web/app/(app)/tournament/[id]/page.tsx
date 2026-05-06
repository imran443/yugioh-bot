"use client";

import { useEffect, useState, useCallback } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { Trophy, Users, Swords, BarChart3, ChevronLeft, Play, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

interface Participant {
  playerId: number;
  displayName: string;
}

interface Match {
  id: number;
  roundNumber: number;
  playerOneId: number;
  playerTwoId: number | null;
  playerOneName: string;
  playerTwoName: string | null;
  status: string;
  winnerId: number | null;
  metadata: Record<string, unknown>;
}

interface TournamentDetail {
  id: number;
  name: string;
  format: string;
  status: string;
  createdByUserId: string;
  participants: Participant[];
  matches: Match[];
}

export default function TournamentDetailPage() {
  const params = useParams();
  const id = typeof params.id === "string" ? params.id : "";

  const [tournament, setTournament] = useState<TournamentDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reportingMatch, setReportingMatch] = useState<number | null>(null);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [showCancelConfirm, setShowCancelConfirm] = useState(false);

  useEffect(() => {
    fetch("/api/auth/session")
      .then((r) => r.json())
      .then((s) => {
        if (s?.user?.id) setCurrentUserId(s.user.id);
      })
      .catch(() => {});
  }, []);

  const fetchTournament = useCallback(() => {
    if (!id) return;
    setLoading(true);
    fetch(`/api/tournaments/${id}`)
      .then((res) => {
        if (!res.ok) throw new Error("Failed to load tournament");
        return res.json();
      })
      .then((data: TournamentDetail) => {
        setTournament(data);
        setLoading(false);
      })
      .catch((err) => {
        setError(err.message);
        setLoading(false);
      });
  }, [id]);

  useEffect(() => {
    fetchTournament();
  }, [fetchTournament]);

  const handleCancel = async () => {
    setActionLoading("cancel");
    setActionError(null);
    try {
      const res = await fetch(`/api/tournaments/${id}`, { method: "DELETE" });
      if (!res.ok) {
        const body = await res.json();
        throw new Error(body.error ?? "Failed to cancel");
      }
      setShowCancelConfirm(false);
      fetchTournament();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to cancel");
    } finally {
      setActionLoading(null);
    }
  };

  if (loading) {
    return (
      <div>
        <div className="mx-auto max-w-4xl p-6">
          <div className="flex items-center justify-center py-20">
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-accent-primary border-t-transparent" />
          </div>
        </div>
      </div>
    );
  }

  if (error || !tournament) {
    return (
      <div>
        <div className="mx-auto max-w-4xl p-6">
          <div className="rounded-lg border border-accent-cta/20 bg-accent-cta/10 p-6 text-accent-cta">
            {error ?? "Tournament not found"}
          </div>
        </div>
      </div>
    );
  }

  const formatLabel =
    tournament.format === "round_robin"
      ? "Round Robin"
      : tournament.format === "single_elim"
        ? "Single Elimination"
        : tournament.format;

  const statusVariant =
    tournament.status === "active"
      ? "success"
      : tournament.status === "pending"
        ? "warning"
        : tournament.status === "cancelled"
          ? "danger"
          : "default";

  const isCreator = currentUserId === tournament.createdByUserId;
  const rounds = Array.from(
    new Set(tournament.matches.map((m) => m.roundNumber))
  ).sort((a, b) => a - b);

  return (
    <div>
      <div className="mx-auto max-w-4xl p-4 sm:p-6 lg:p-8">
        {actionError && (
          <div className="mb-4 rounded-lg border border-accent-cta/50 bg-accent-cta/10 px-4 py-2 text-sm text-accent-cta">
            {actionError}
          </div>
        )}

        <div className="mb-6">
          <Link
            href="/tournaments"
            className="mb-4 inline-flex items-center gap-1 text-sm text-text-muted hover:text-text-secondary"
          >
            <ChevronLeft className="h-4 w-4" />
            All Tournaments
          </Link>

          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <h1 className="font-display text-2xl text-text-primary sm:text-3xl">
                {tournament.name}
              </h1>
              <div className="mt-2 flex items-center gap-3">
                <Badge variant={statusVariant}>{tournament.status}</Badge>
                <span className="text-sm text-text-muted">{formatLabel}</span>
              </div>
            </div>

            <div className="flex items-center gap-2">
              {tournament.status === "active" && (
                <Link href={`/tournament/${id}/standings`}>
                  <Button variant="secondary" size="sm">
                    <BarChart3 className="mr-1.5 h-4 w-4" />
                    Standings
                  </Button>
                </Link>
              )}
            </div>
          </div>
        </div>

        {isCreator && (tournament.status === "pending" || tournament.status === "active") && (
          <div className="mb-6 rounded-xl border border-border bg-surface p-5">
            {showCancelConfirm ? (
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <p className="text-sm text-text-secondary">
                  Are you sure you want to cancel this tournament?
                </p>
                <div className="flex gap-3">
                  <Button variant="danger" size="sm" loading={actionLoading === "cancel"} onClick={handleCancel}>
                    Yes, Cancel
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => setShowCancelConfirm(false)}>
                    Go Back
                  </Button>
                </div>
              </div>
            ) : (
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <p className="font-semibold text-text-primary">
                    {tournament.status === "pending" ? "Ready to begin?" : "Tournament in progress"}
                  </p>
                  <p className="text-sm text-text-secondary">
                    {tournament.status === "pending"
                      ? "Start the tournament once all players have joined."
                      : "You can cancel this tournament if needed."}
                  </p>
                </div>
                <div className="flex gap-3">
                  {tournament.status === "pending" && (
                    <Button
                      variant="primary"
                      loading={actionLoading === "start"}
                      onClick={async () => {
                        setActionLoading("start");
                        setActionError(null);
                        try {
                          const res = await fetch(`/api/tournaments/${id}`, { method: "POST" });
                          if (!res.ok) {
                            const body = await res.json();
                            throw new Error(body.error ?? "Failed to start");
                          }
                          fetchTournament();
                        } catch (err) {
                          setActionError(err instanceof Error ? err.message : "Failed to start");
                        } finally {
                          setActionLoading(null);
                        }
                      }}
                    >
                      <Play className="h-4 w-4" />
                      Start Tournament
                    </Button>
                  )}
                  <Button
                    variant="secondary"
                    onClick={() => setShowCancelConfirm(true)}
                  >
                    <X className="h-4 w-4" />
                    Cancel
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}

        {!isCreator && tournament.status === "pending" && (
          <div className="mb-6 rounded-xl border border-border bg-surface p-5 text-center">
            <p className="text-text-secondary">
              Waiting for the creator to start this tournament
            </p>
          </div>
        )}

        {tournament.status !== "pending" && tournament.status !== "active" && (
          <Link href={`/tournament/${id}/standings`}>
            <Button variant="secondary" size="sm">
              <BarChart3 className="mr-1.5 h-4 w-4" />
              Standings
            </Button>
          </Link>
        )}

        <section className="mb-8 rounded-xl border border-border bg-surface p-5">
          <h2 className="mb-4 flex items-center gap-2 font-body text-lg font-semibold text-text-primary">
            <Users className="h-5 w-5 text-accent-primary" />
            Participants ({tournament.participants.length})
          </h2>
          {tournament.participants.length === 0 ? (
            <p className="text-sm text-text-secondary">No participants yet.</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {tournament.participants.map((p) => (
                <span
                  key={p.playerId}
                  className="rounded-full bg-bg-elevated px-3 py-1 text-sm text-text-secondary"
                >
                  {p.displayName}
                </span>
              ))}
            </div>
          )}
        </section>

        {tournament.matches.length > 0 && (
          <section>
            <h2 className="mb-4 flex items-center gap-2 font-body text-lg font-semibold text-text-primary">
              <Swords className="h-5 w-5 text-accent-primary" />
              Matches
            </h2>

            {rounds.map((round) => (
              <div key={round} className="mb-6">
                <h3 className="mb-3 text-sm font-semibold text-text-muted">
                  Round {round}
                </h3>
                <div className="space-y-3">
                  {tournament.matches
                    .filter((m) => m.roundNumber === round)
                    .map((match) => (
                      <MatchCard
                        key={match.id}
                        match={match}
                        tournamentId={id}
                        isReporting={reportingMatch === match.id}
                        onReport={() => setReportingMatch(match.id)}
                        onCancelReport={() => setReportingMatch(null)}
                        onReported={() => {
                          setReportingMatch(null);
                          fetchTournament();
                        }}
                      />
                    ))}
                </div>
              </div>
            ))}
          </section>
        )}
      </div>
    </div>
  );
}

function MatchCard({
  match,
  tournamentId,
  isReporting,
  onReport,
  onCancelReport,
  onReported,
}: {
  match: Match;
  tournamentId: string;
  isReporting: boolean;
  onReport: () => void;
  onCancelReport: () => void;
  onReported: () => void;
}) {
  const isBye = match.metadata?.bye === true;
  const isCompleted = match.status === "completed";
  const isPendingApproval = match.status === "pending_approval";
  const isOpen = match.status === "open";

  const statusBadge =
    isBye || isCompleted ? (
      <Badge variant="success">Completed</Badge>
    ) : isPendingApproval ? (
      <Badge variant="warning">Pending Approval</Badge>
    ) : (
      <Badge variant="default">Open</Badge>
    );

  return (
    <div className="rounded-xl border border-border bg-surface p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <div className="flex flex-col gap-1">
            <span
              className={`font-body font-semibold ${
                match.winnerId === match.playerOneId
                  ? "text-accent-success"
                  : "text-text-primary"
              }`}
            >
              {match.playerOneName}
              {match.winnerId === match.playerOneId && (
                <Trophy className="ml-1.5 inline h-3.5 w-3.5 text-accent-gold" />
              )}
            </span>
            {match.playerTwoName && (
              <span
                className={`font-body font-semibold ${
                  match.winnerId === match.playerTwoId
                    ? "text-accent-success"
                    : "text-text-primary"
                }`}
              >
                {match.playerTwoName}
                {match.winnerId === match.playerTwoId && (
                  <Trophy className="ml-1.5 inline h-3.5 w-3.5 text-accent-gold" />
                )}
              </span>
            )}
            {isBye && (
              <span className="text-sm text-text-muted">Bye</span>
            )}
          </div>
        </div>

        <div className="flex items-center gap-3">
          {statusBadge}
          {isOpen && !isReporting && (
            <Button variant="primary" size="sm" onClick={onReport}>
              Report
            </Button>
          )}
        </div>
      </div>

      {isReporting && (
        <div className="mt-4 border-t border-border pt-4">
          <p className="mb-3 text-sm text-text-secondary">
            Report your result:
          </p>
          <div className="flex gap-3">
            <Button
              variant="primary"
              size="sm"
              onClick={() => handleReport(tournamentId, match.id, "win", onReported)}
            >
              I Won
            </Button>
            <Button
              variant="danger"
              size="sm"
              onClick={() => handleReport(tournamentId, match.id, "loss", onReported)}
            >
              I Lost
            </Button>
            <Button variant="ghost" size="sm" onClick={onCancelReport}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

async function handleReport(
  tournamentId: string,
  tournamentMatchId: number,
  result: "win" | "loss",
  onReported: () => void
) {
  try {
    const res = await fetch(`/api/tournaments/${tournamentId}/report`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tournamentMatchId, result }),
    });

    if (!res.ok) {
      const data = await res.json();
      alert(data.error ?? "Failed to report match");
      return;
    }

    onReported();
  } catch {
    alert("Failed to report match");
  }
}