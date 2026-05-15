"use client";

import { useEffect, useState, useCallback } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { Trophy, Users, Swords, BarChart3, ChevronLeft, Play, X, Link as LinkIcon, LogOut, Megaphone, Check, UserPlus } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useTournamentWebsocket } from "@/lib/hooks/use-tournament-websocket";

interface Participant {
  playerId: number;
  displayName: string;
}

interface Match {
  id: number;
  matchId: number | null;
  roundNumber: number;
  playerOneId: number;
  playerTwoId: number | null;
  playerOneName: string;
  playerTwoName: string | null;
  status: string;
  winnerId: number | null;
  reporterId: number | null;
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
  isParticipant: boolean;
  currentUserPlayerId: number | null;
}

export default function TournamentDetailPage() {
  const params = useParams();
  const id = typeof params.slug === "string" ? params.slug : "";

  const [tournament, setTournament] = useState<TournamentDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reportingMatch, setReportingMatch] = useState<number | null>(null);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [showCancelConfirm, setShowCancelConfirm] = useState(false);
  const [copiedLink, setCopiedLink] = useState(false);
  const [announced, setAnnounced] = useState(false);

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

  useTournamentWebsocket(id, {
    onParticipantJoined: () => fetchTournament(),
    onParticipantLeft: () => fetchTournament(),
    onStarted: () => fetchTournament(),
    onCancelled: () => fetchTournament(),
    onMatchUpdated: () => fetchTournament(),
  });

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

  function getFormatLabel(format: string): string {
    if (format === "round_robin") return "Round Robin";
    if (format === "single_elim") return "Single Elimination";
    return format;
  }

  function getStatusVariant(status: string): "default" | "danger" | "success" | "warning" {
    if (status === "active") return "success";
    if (status === "pending") return "warning";
    if (status === "cancelled") return "danger";
    return "default";
  }

  const formatLabel = getFormatLabel(tournament.format);
  const statusVariant = getStatusVariant(tournament.status);

  const isCreator = currentUserId === tournament.createdByUserId;
  const isParticipant = tournament.isParticipant;
  const participantCount = tournament.participants.length;
  const canStart = tournament.status === "pending" && participantCount >= 2;
  const rounds = Array.from(
    new Set(tournament.matches.map((m) => m.roundNumber))
  ).sort((a, b) => a - b);

  async function handleJoin() {
    setActionLoading("join");
    setActionError(null);
    try {
      const res = await fetch(`/api/tournaments/${id}/join`, { method: "POST" });
      if (!res.ok) {
        const body = await res.json();
        throw new Error(body.error ?? "Failed to join tournament");
      }
      fetchTournament();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to join tournament");
    } finally {
      setActionLoading(null);
    }
  }

  async function handleStart() {
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
  }

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

        {/* Invite & share — visible to anyone on a pending tournament */}
        {tournament.status === "pending" && (
          <section className="mb-6 rounded-xl border border-border bg-surface p-5">
            <div className="mb-3 flex items-center gap-2">
              <LinkIcon className="h-4 w-4 text-accent-primary" />
              <h2 className="font-body text-sm font-semibold uppercase tracking-wider text-text-secondary">
                Invite link
              </h2>
            </div>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-stretch">
              <code className="flex-1 truncate rounded-lg border border-border bg-bg-deep px-3 py-2 font-mono text-sm text-text-primary">
                {typeof window !== "undefined" ? `${window.location.origin}/tournament/${id}` : `/tournament/${id}`}
              </code>
              <div className="flex gap-2">
                <Button
                  variant={copiedLink ? "secondary" : "primary"}
                  size="md"
                  onClick={async () => {
                    const url = `${window.location.origin}/tournament/${id}`;
                    await navigator.clipboard.writeText(url);
                    setCopiedLink(true);
                    setTimeout(() => setCopiedLink(false), 1500);
                  }}
                >
                  {copiedLink ? <Check className="h-4 w-4" /> : <LinkIcon className="h-4 w-4" />}
                  {copiedLink ? "Copied" : "Copy"}
                </Button>
                {isCreator && (
                  <Button
                    variant="secondary"
                    size="md"
                    loading={actionLoading === "announce"}
                    onClick={async () => {
                      setActionLoading("announce");
                      setActionError(null);
                      try {
                        const res = await fetch(`/api/tournaments/${id}/announce`, { method: "POST" });
                        if (!res.ok) {
                          const body = await res.json();
                          throw new Error(body.error ?? "Failed to announce");
                        }
                        setAnnounced(true);
                        setTimeout(() => setAnnounced(false), 2500);
                      } catch (err) {
                        setActionError(err instanceof Error ? err.message : "Failed to announce");
                      } finally {
                        setActionLoading(null);
                      }
                    }}
                  >
                    {announced ? <Check className="h-4 w-4 text-accent-success" /> : <Megaphone className="h-4 w-4" />}
                    {announced ? "Announced" : "Announce"}
                  </Button>
                )}
              </div>
            </div>
            <p className="mt-2 text-xs text-text-secondary">
              Share this link with players so they can join.
            </p>
          </section>
        )}

        {/* Players — chips + empty seats + progress + hosting/leave row */}
        <section className="mb-6 rounded-xl border border-border bg-surface p-5">
          <div className="mb-4 flex items-center justify-between gap-3">
            <h2 className="flex items-center gap-2 font-body text-lg font-semibold text-text-primary">
              <Users className="h-5 w-5 text-accent-primary" />
              Players
              <span className="text-text-secondary">({tournament.participants.length})</span>
            </h2>
            {tournament.status === "pending" && (
              <span className="font-mono text-xs uppercase tracking-wider text-text-secondary">
                {participantCount} / 2 minimum
              </span>
            )}
          </div>

          {tournament.status === "pending" && (
            <div className="mb-4 h-1 w-full overflow-hidden rounded-full bg-bg-deep">
              <div
                className={`h-full motion-safe:transition-all motion-safe:duration-300 ${
                  canStart ? "bg-accent-success" : "bg-accent-primary"
                }`}
                style={{ width: `${Math.min(100, (participantCount / 2) * 100)}%` }}
              />
            </div>
          )}

          {tournament.participants.length === 0 && tournament.status !== "pending" ? (
            <p className="text-sm text-text-secondary">No participants.</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {tournament.participants.map((p) => {
                const isYou = p.playerId === tournament.currentUserPlayerId;
                const isHost = isCreator && isYou;
                const canKick = isCreator && tournament.status === "pending" && !isYou;
                return (
                  <span
                    key={p.playerId}
                    className={`group inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm motion-safe:transition-colors ${
                      isYou
                        ? "border-accent-primary/40 bg-accent-primary/10 text-text-primary"
                        : "border-border bg-bg-elevated text-text-secondary"
                    }`}
                  >
                    <span className={`h-1.5 w-1.5 rounded-full ${isYou ? "bg-accent-primary" : "bg-text-secondary"}`} />
                    <span className="font-body font-medium">{p.displayName}</span>
                    {isHost && (
                      <span className="rounded-sm bg-accent-gold/20 px-1 py-px font-mono text-[10px] uppercase tracking-wider text-accent-gold">
                        Host
                      </span>
                    )}
                    {isYou && !isHost && (
                      <span className="font-mono text-[10px] uppercase tracking-wider text-text-secondary">You</span>
                    )}
                    {canKick && (
                      <button
                        type="button"
                        aria-label={`Remove ${p.displayName}`}
                        className="ml-1 inline-flex h-4 w-4 items-center justify-center rounded-full text-text-secondary motion-safe:transition-colors hover:bg-accent-cta/20 hover:text-accent-cta"
                        onClick={async () => {
                          setActionLoading(`kick-${p.playerId}`);
                          setActionError(null);
                          try {
                            const res = await fetch(`/api/tournaments/${id}/kick`, {
                              method: "POST",
                              headers: { "Content-Type": "application/json" },
                              body: JSON.stringify({ playerId: p.playerId }),
                            });
                            if (!res.ok) {
                              const body = await res.json();
                              throw new Error(body.error ?? "Failed to remove");
                            }
                            fetchTournament();
                          } catch (err) {
                            setActionError(err instanceof Error ? err.message : "Failed to remove");
                          } finally {
                            setActionLoading(null);
                          }
                        }}
                      >
                        <X className="h-3 w-3" />
                      </button>
                    )}
                  </span>
                );
              })}
              {tournament.status === "pending" &&
                Array.from({ length: Math.max(0, 2 - tournament.participants.length) }).map((_, i) => (
                  <span
                    key={`empty-${i}`}
                    className="inline-flex items-center gap-2 rounded-full border border-dashed border-border px-3 py-1.5 text-sm text-text-secondary"
                  >
                    <UserPlus className="h-3.5 w-3.5" />
                    <span className="font-mono text-xs uppercase tracking-wider">Open seat</span>
                  </span>
                ))}
            </div>
          )}

          {tournament.status === "pending" && isParticipant && (
            <div className="mt-4 flex items-center justify-between border-t border-border pt-4 text-sm">
              <p className="text-text-secondary">
                {isCreator
                  ? "Hosting and playing in this tournament."
                  : "You're in. Waiting for the organizer to start."}
              </p>
              <button
                type="button"
                disabled={actionLoading === "leave"}
                className="inline-flex items-center gap-1.5 text-text-secondary motion-safe:transition-colors hover:text-text-primary disabled:opacity-50"
                onClick={async () => {
                  setActionLoading("leave");
                  setActionError(null);
                  try {
                    const res = await fetch(`/api/tournaments/${id}/leave`, { method: "POST" });
                    if (!res.ok) {
                      const body = await res.json();
                      throw new Error(body.error ?? "Failed to leave");
                    }
                    fetchTournament();
                  } catch (err) {
                    setActionError(err instanceof Error ? err.message : "Failed to leave");
                  } finally {
                    setActionLoading(null);
                  }
                }}
              >
                <LogOut className="h-3.5 w-3.5" />
                {isCreator ? "Leave as participant" : "Leave tournament"}
              </button>
            </div>
          )}
        </section>

        {/* Primary action — Start (organizer pending) or Join (non-participant pending) */}
        {tournament.status === "pending" && isCreator && (
          <div className="mb-6 flex flex-col items-center gap-2">
            <Button
              variant="primary"
              size="lg"
              loading={actionLoading === "start"}
              disabled={!canStart}
              title={!canStart ? "Need at least 2 participants to start" : undefined}
              onClick={handleStart}
              className="min-w-[240px]"
            >
              <Play className="h-5 w-5" />
              Start Tournament
            </Button>
            {!canStart && (
              <p className="font-mono text-xs uppercase tracking-wider text-text-secondary">
                Need {2 - participantCount} more {2 - participantCount === 1 ? "player" : "players"} to start
              </p>
            )}
          </div>
        )}

        {tournament.status === "pending" && !isParticipant && (
          <div className="mb-6 flex flex-col items-center gap-2">
            <Button
              variant="primary"
              size="lg"
              loading={actionLoading === "join"}
              onClick={handleJoin}
              className="min-w-[240px]"
            >
              <UserPlus className="h-5 w-5" />
              Join Tournament
            </Button>
          </div>
        )}

        {/* Cancel — quiet destructive footer link, organizer only */}
        {isCreator && (tournament.status === "pending" || tournament.status === "active") && (
          <div className="mb-8 flex justify-center">
            {showCancelConfirm ? (
              <div className="flex items-center gap-3 rounded-lg border border-accent-cta/40 bg-accent-cta/5 px-4 py-2 text-sm">
                <span className="text-text-secondary">Cancel this tournament?</span>
                <Button variant="danger" size="sm" loading={actionLoading === "cancel"} onClick={handleCancel}>
                  Yes, cancel
                </Button>
                <button
                  type="button"
                  className="text-text-secondary hover:text-text-primary"
                  onClick={() => setShowCancelConfirm(false)}
                >
                  Go back
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setShowCancelConfirm(true)}
                className="inline-flex items-center gap-1.5 text-xs text-text-secondary motion-safe:transition-colors hover:text-accent-cta"
              >
                <X className="h-3.5 w-3.5" />
                Cancel tournament
              </button>
            )}
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
                        currentUserPlayerId={tournament.currentUserPlayerId}
                        isReporting={reportingMatch === match.id}
                        onReport={() => setReportingMatch(match.id)}
                        onCancelReport={() => setReportingMatch(null)}
                        onReported={() => {
                          setReportingMatch(null);
                          fetchTournament();
                        }}
                        onResolved={() => fetchTournament()}
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
  currentUserPlayerId,
  isReporting,
  onReport,
  onCancelReport,
  onReported,
  onResolved,
}: {
  match: Match;
  tournamentId: string;
  currentUserPlayerId: number | null;
  isReporting: boolean;
  onReport: () => void;
  onCancelReport: () => void;
  onReported: () => void;
  onResolved: () => void;
}) {
  const [resolveLoading, setResolveLoading] = useState<"approve" | "deny" | null>(null);
  const [resolveError, setResolveError] = useState<string | null>(null);

  const isBye = match.metadata?.bye === true;
  const isCompleted = match.status === "completed";
  const isPendingApproval = match.status === "pending_approval";
  const isOpen = match.status === "open";

  const isOpponent =
    currentUserPlayerId !== null &&
    match.reporterId !== null &&
    currentUserPlayerId !== match.reporterId &&
    (match.playerOneId === currentUserPlayerId || match.playerTwoId === currentUserPlayerId);

  async function handleApprove() {
    if (!match.matchId) return;
    setResolveLoading("approve");
    setResolveError(null);
    try {
      const res = await fetch(`/api/matches/${match.matchId}/approve`, { method: "POST" });
      if (!res.ok) {
        const body = await res.json();
        throw new Error(body.error ?? "Failed to approve");
      }
      onResolved();
    } catch (err) {
      setResolveError(err instanceof Error ? err.message : "Failed to approve");
    } finally {
      setResolveLoading(null);
    }
  }

  async function handleDeny() {
    if (!match.matchId) return;
    setResolveLoading("deny");
    setResolveError(null);
    try {
      const res = await fetch(`/api/matches/${match.matchId}/deny`, { method: "POST" });
      if (!res.ok) {
        const body = await res.json();
        throw new Error(body.error ?? "Failed to deny");
      }
      onResolved();
    } catch (err) {
      setResolveError(err instanceof Error ? err.message : "Failed to deny");
    } finally {
      setResolveLoading(null);
    }
  }

  function getStatusBadge() {
    if (isBye || isCompleted) {
      return <Badge variant="success">Completed</Badge>;
    }
    if (isPendingApproval) {
      return <Badge variant="warning">Pending Approval</Badge>;
    }
    return <Badge variant="default">Open</Badge>;
  }

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
          {getStatusBadge()}
          {isOpen && !isReporting && (
            <Button variant="primary" size="sm" onClick={onReport}>
              Report
            </Button>
          )}
          {isPendingApproval && isOpponent && (
            <>
              <Button
                variant="primary"
                size="sm"
                loading={resolveLoading === "approve"}
                onClick={handleApprove}
              >
                Approve
              </Button>
              <Button
                variant="danger"
                size="sm"
                loading={resolveLoading === "deny"}
                onClick={handleDeny}
              >
                Deny
              </Button>
            </>
          )}
        </div>
      </div>

      {resolveError && (
        <p className="mt-2 text-sm text-accent-cta">{resolveError}</p>
      )}

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