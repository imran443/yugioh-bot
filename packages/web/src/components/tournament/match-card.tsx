"use client";

import { useState } from "react";
import { Trophy } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { Match } from "./types";

export interface MatchProjection {
  winWinnings: number;
  winRating: number;
  loseRating: number;
}

async function handleReport(
  tournamentSlug: string,
  tournamentMatchId: number,
  result: "win" | "loss",
  onReported: () => void
) {
  try {
    const res = await fetch(`/api/tournaments/${tournamentSlug}/report`, {
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

export function MatchCard({
  match,
  tournamentSlug,
  tournamentFormat,
  currentUserPlayerId,
  isHost,
  isReporting,
  projection,
  onReport,
  onCancelReport,
  onReported,
  onResolved,
}: {
  match: Match;
  tournamentSlug: string;
  tournamentFormat: string;
  currentUserPlayerId: number | null;
  isHost: boolean;
  isReporting: boolean;
  projection?: MatchProjection | null;
  onReport: () => void;
  onCancelReport: () => void;
  onReported: () => void;
  onResolved: () => void;
}) {
  const [resolveLoading, setResolveLoading] = useState<"approve" | "deny" | null>(null);
  const [resolveError, setResolveError] = useState<string | null>(null);

  const [confirmReopen, setConfirmReopen] = useState(false);
  const [reopenLoading, setReopenLoading] = useState(false);
  const [reopenError, setReopenError] = useState<string | null>(null);

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

  async function handleReopen() {
    setReopenLoading(true);
    setReopenError(null);
    try {
      const res = await fetch(`/api/tournaments/${tournamentSlug}/reopen`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tournamentMatchId: match.id }),
      });
      if (!res.ok) {
        const body = await res.json();
        throw new Error(body.error ?? "Failed to reopen");
      }
      setConfirmReopen(false);
      onResolved();
    } catch (err) {
      setReopenError(err instanceof Error ? err.message : "Failed to reopen");
    } finally {
      setReopenLoading(false);
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
    <div
      data-testid={`tournament-match-card-${match.id}`}
      className="rounded-xl border border-border bg-surface p-4 2xl:p-5"
    >
      <div
        data-testid={`tournament-match-card-header-${match.id}`}
        className="flex flex-col gap-3 lg:flex-col lg:items-start lg:justify-between xl:flex-row xl:items-center"
      >
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

        <div
          data-testid={`tournament-match-card-actions-${match.id}`}
          className="flex w-full flex-wrap items-center gap-2 lg:w-full xl:w-auto xl:justify-end"
        >
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

      {isHost && match.status === "completed" && tournamentFormat === "round_robin" && (
        <div className="mt-3 border-t border-border pt-3 text-sm">
          {confirmReopen ? (
            <div className="flex items-center gap-3">
              <span className="text-text-secondary">Reopen this match for re-reporting?</span>
              <Button variant="danger" size="sm" loading={reopenLoading} onClick={handleReopen}>
                Confirm
              </Button>
              <button type="button" className="text-text-secondary hover:text-text-primary" onClick={() => setConfirmReopen(false)}>
                Cancel
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmReopen(true)}
              className="inline-flex items-center gap-1.5 text-xs text-text-secondary hover:text-accent-cta"
            >
              Reopen match
            </button>
          )}
          {reopenError && <p className="mt-1 text-accent-cta">{reopenError}</p>}
        </div>
      )}

      {isReporting && (
        <div className="mt-4 border-t border-border pt-4">
          <p className="mb-3 text-sm text-text-secondary">
            Report your result:
          </p>
          {projection && (
            <p className="mb-3 font-mono text-xs text-text-muted">
              <span className="text-accent-success">
                Win → +{projection.winWinnings} pts, +{projection.winRating} elo
              </span>
              {" · "}
              <span className="text-accent-cta">
                Lose → +0 pts, {projection.loseRating} elo
              </span>
            </p>
          )}
          <div className="flex gap-3">
            <Button
              variant="primary"
              size="sm"
              onClick={() => handleReport(tournamentSlug, match.id, "win", onReported)}
            >
              I Won
            </Button>
            <Button
              variant="danger"
              size="sm"
              onClick={() => handleReport(tournamentSlug, match.id, "loss", onReported)}
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
