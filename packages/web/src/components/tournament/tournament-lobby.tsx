"use client";

import { useState } from "react";
import { Link as LinkIcon, Check, Play, UserPlus, X, LogOut, Megaphone } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { TournamentDetail } from "./types";

interface TournamentLobbyProps {
  tournament: TournamentDetail;
  tournamentSlug: string;
  isCreator: boolean;
  currentUserId: string | null;
  onChanged: () => void;
}

export function TournamentLobby({
  tournament,
  tournamentSlug,
  isCreator,
  onChanged,
}: TournamentLobbyProps) {
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [showCancelConfirm, setShowCancelConfirm] = useState(false);
  const [copiedLink, setCopiedLink] = useState(false);
  const [announced, setAnnounced] = useState(false);

  const isParticipant = tournament.isParticipant;
  const participantCount = tournament.participants.length;
  const canStart = participantCount >= 2;

  async function handleJoin() {
    setActionLoading("join");
    setActionError(null);
    try {
      const res = await fetch(`/api/tournaments/${tournamentSlug}/join`, { method: "POST" });
      if (!res.ok) {
        const body = await res.json();
        throw new Error(body.error ?? "Failed to join tournament");
      }
      onChanged();
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
      const res = await fetch(`/api/tournaments/${tournamentSlug}`, { method: "POST" });
      if (!res.ok) {
        const body = await res.json();
        throw new Error(body.error ?? "Failed to start");
      }
      onChanged();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to start");
    } finally {
      setActionLoading(null);
    }
  }

  async function handleAddBot() {
    setActionLoading("add-bot");
    setActionError(null);
    try {
      const res = await fetch(`/api/tournaments/${tournamentSlug}/join-bot`, { method: "POST" });
      if (!res.ok) {
        const body = await res.json();
        throw new Error(body.error ?? "Failed to add bot");
      }
      onChanged();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to add bot");
    } finally {
      setActionLoading(null);
    }
  }

  async function handleCancel() {
    setActionLoading("cancel");
    setActionError(null);
    try {
      const res = await fetch(`/api/tournaments/${tournamentSlug}`, { method: "DELETE" });
      if (!res.ok) {
        const body = await res.json();
        throw new Error(body.error ?? "Failed to cancel");
      }
      setShowCancelConfirm(false);
      onChanged();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to cancel");
    } finally {
      setActionLoading(null);
    }
  }

  return (
    <>
      {actionError && (
        <div className="mb-4 rounded-lg border border-accent-cta/50 bg-accent-cta/10 px-4 py-2 text-sm text-accent-cta">
          {actionError}
        </div>
      )}

      {/* Invite & share — visible to anyone on a pending tournament */}
      <section className="mb-6 rounded-xl border border-border bg-surface p-5">
        <div className="mb-3 flex items-center gap-2">
          <LinkIcon className="h-4 w-4 text-accent-primary" />
          <h2 className="font-body text-sm font-semibold uppercase tracking-wider text-text-secondary">
            Invite link
          </h2>
        </div>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-stretch">
          <code className="flex-1 truncate rounded-lg border border-border bg-bg-deep px-3 py-2 font-mono text-sm text-text-primary">
            {typeof window !== "undefined"
              ? `${window.location.origin}/tournament/${tournamentSlug}`
              : `/tournament/${tournamentSlug}`}
          </code>
          <div className="flex gap-2">
            <Button
              variant={copiedLink ? "secondary" : "primary"}
              size="md"
              onClick={async () => {
                const url = `${window.location.origin}/tournament/${tournamentSlug}`;
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
                    const res = await fetch(`/api/tournaments/${tournamentSlug}/announce`, {
                      method: "POST",
                    });
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
                {announced ? (
                  <Check className="h-4 w-4 text-accent-success" />
                ) : (
                  <Megaphone className="h-4 w-4" />
                )}
                {announced ? "Announced" : "Announce"}
              </Button>
            )}
          </div>
        </div>
        <p className="mt-2 text-xs text-text-secondary">
          Share this link with players so they can join.
        </p>
      </section>

      {/* Players — chips + empty seats + progress + hosting/leave row */}
      <section className="mb-6 rounded-xl border border-border bg-surface p-5">
        <div className="mb-4 flex items-center justify-between gap-3">
          <h2 className="font-body text-lg font-semibold text-text-primary">
            Players
            <span className="ml-2 text-text-secondary">({participantCount})</span>
          </h2>
          <span className="font-mono text-xs uppercase tracking-wider text-text-secondary">
            {participantCount} / 2 minimum
          </span>
        </div>

        <div className="mb-4 h-1 w-full overflow-hidden rounded-full bg-bg-deep">
          <div
            className={`h-full motion-safe:transition-all motion-safe:duration-300 ${
              canStart ? "bg-accent-success" : "bg-accent-primary"
            }`}
            style={{ width: `${Math.min(100, (participantCount / 2) * 100)}%` }}
          />
        </div>

        <div className="flex flex-wrap gap-2">
          {tournament.participants.map((p) => {
            const isYou = p.playerId === tournament.currentUserPlayerId;
            const isHost = isCreator && isYou;
            const canKick = isCreator && !isYou;
            return (
              <span
                key={p.playerId}
                className={`group inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm motion-safe:transition-colors ${
                  isYou
                    ? "border-accent-primary/40 bg-accent-primary/10 text-text-primary"
                    : "border-border bg-bg-elevated text-text-secondary"
                }`}
              >
                <span
                  className={`h-1.5 w-1.5 rounded-full ${isYou ? "bg-accent-primary" : "bg-text-secondary"}`}
                />
                <span className="font-body font-medium">{p.displayName}</span>
                {isHost && (
                  <span className="rounded-sm bg-accent-gold/20 px-1 py-px font-mono text-[10px] uppercase tracking-wider text-accent-gold">
                    Host
                  </span>
                )}
                {isYou && !isHost && (
                  <span className="font-mono text-[10px] uppercase tracking-wider text-text-secondary">
                    You
                  </span>
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
                        const res = await fetch(`/api/tournaments/${tournamentSlug}/kick`, {
                          method: "POST",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({ playerId: p.playerId }),
                        });
                        if (!res.ok) {
                          const body = await res.json();
                          throw new Error(body.error ?? "Failed to remove");
                        }
                        onChanged();
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
          {Array.from({ length: Math.max(0, 2 - participantCount) }).map((_, i) => (
            <span
              key={`empty-${i}`}
              className="inline-flex items-center gap-2 rounded-full border border-dashed border-border px-3 py-1.5 text-sm text-text-secondary"
            >
              <UserPlus className="h-3.5 w-3.5" />
              <span className="font-mono text-xs uppercase tracking-wider">Open seat</span>
            </span>
          ))}
        </div>

        {isParticipant && (
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
                  const res = await fetch(`/api/tournaments/${tournamentSlug}/leave`, {
                    method: "POST",
                  });
                  if (!res.ok) {
                    const body = await res.json();
                    throw new Error(body.error ?? "Failed to leave");
                  }
                  onChanged();
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
      {isCreator && (
        <div className="mb-6 flex flex-col items-center gap-2">
          <div className="flex flex-col gap-2 sm:flex-row">
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
            {process.env.NODE_ENV !== "production" && (
              <Button
                variant="secondary"
                size="lg"
                loading={actionLoading === "add-bot"}
                onClick={handleAddBot}
              >
                <UserPlus className="h-5 w-5" />
                Add Bot
              </Button>
            )}
          </div>
          {!canStart && (
            <p className="font-mono text-xs uppercase tracking-wider text-text-secondary">
              Need {2 - participantCount} more{" "}
              {2 - participantCount === 1 ? "player" : "players"} to start
            </p>
          )}
        </div>
      )}

      {!isParticipant && (
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
      {isCreator && (
        <div className="mb-8 flex justify-center">
          {showCancelConfirm ? (
            <div className="flex items-center gap-3 rounded-lg border border-accent-cta/40 bg-accent-cta/5 px-4 py-2 text-sm">
              <span className="text-text-secondary">Cancel this tournament?</span>
              <Button
                variant="danger"
                size="sm"
                loading={actionLoading === "cancel"}
                onClick={handleCancel}
              >
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
    </>
  );
}
