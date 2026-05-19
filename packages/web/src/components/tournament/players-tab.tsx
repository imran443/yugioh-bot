"use client";

import { useState } from "react";
import { Users, UserPlus, X, LogOut } from "lucide-react";
import type { TournamentDetail } from "./types";

export function PlayersTab({
  tournament,
  tournamentSlug,
  isCreator,
  currentUserPlayerId,
  onChanged,
}: {
  tournament: TournamentDetail;
  tournamentSlug: string;
  isCreator: boolean;
  currentUserPlayerId: number | null;
  onChanged: () => void;
}) {
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const participantCount = tournament.participants.length;
  const canStart = tournament.status === "pending" && participantCount >= 2;

  async function handleKick(playerId: number) {
    setActionLoading(`kick-${playerId}`);
    setActionError(null);
    try {
      const res = await fetch(`/api/tournaments/${tournamentSlug}/kick`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ playerId }),
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
  }

  async function handleLeave() {
    setActionLoading("leave");
    setActionError(null);
    try {
      const res = await fetch(`/api/tournaments/${tournamentSlug}/leave`, { method: "POST" });
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
  }

  return (
    <section className="rounded-xl border border-border bg-surface p-5">
      <div className="mb-4 flex items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 font-body text-lg font-semibold text-text-primary">
          <Users className="h-5 w-5 text-accent-primary" />
          Players
          <span className="text-text-secondary">({participantCount})</span>
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

      {actionError && (
        <p className="mb-3 text-sm text-accent-cta">{actionError}</p>
      )}

      {tournament.participants.length === 0 && tournament.status !== "pending" ? (
        <p className="text-sm text-text-secondary">No participants.</p>
      ) : (
        <div className="flex flex-wrap gap-2">
          {tournament.participants.map((p) => {
            const isYou = p.playerId === currentUserPlayerId;
            const isHostAndYou = isCreator && isYou;
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
                <span
                  className={`h-1.5 w-1.5 rounded-full ${isYou ? "bg-accent-primary" : "bg-text-secondary"}`}
                />
                <span className="font-body font-medium">{p.displayName}</span>
                {isHostAndYou && (
                  <span className="rounded-sm bg-accent-gold/20 px-1 py-px font-mono text-[10px] uppercase tracking-wider text-accent-gold">
                    Host
                  </span>
                )}
                {isYou && !isHostAndYou && (
                  <span className="font-mono text-[10px] uppercase tracking-wider text-text-secondary">
                    You
                  </span>
                )}
                {canKick && (
                  <button
                    type="button"
                    aria-label={`Remove ${p.displayName}`}
                    disabled={actionLoading === `kick-${p.playerId}`}
                    className="ml-1 inline-flex h-4 w-4 items-center justify-center rounded-full text-text-secondary motion-safe:transition-colors hover:bg-accent-cta/20 hover:text-accent-cta disabled:opacity-50"
                    onClick={() => handleKick(p.playerId)}
                  >
                    <X className="h-3 w-3" />
                  </button>
                )}
              </span>
            );
          })}
          {tournament.status === "pending" &&
            Array.from({ length: Math.max(0, 2 - participantCount) }).map((_, i) => (
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

      {tournament.status === "pending" && tournament.isParticipant && (
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
            onClick={handleLeave}
          >
            <LogOut className="h-3.5 w-3.5" />
            {isCreator ? "Leave as participant" : "Leave tournament"}
          </button>
        </div>
      )}
    </section>
  );
}
