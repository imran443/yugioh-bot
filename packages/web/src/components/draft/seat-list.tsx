"use client";

import { useDraftStore } from "@/lib/stores/draft-store";
import { cn } from "@/lib/utils";
import { Check, User } from "lucide-react";

interface SeatListProps {
  className?: string;
}

export function SeatList({ className }: SeatListProps) {
  const seats = useDraftStore((s) => s.seats);
  const activeSeat = seats.find((seat) => seat.isCurrentPlayer) ?? null;

  return (
    <div
      className={cn(
        "flex flex-col gap-3 rounded-xl border border-border bg-surface p-3",
        className
      )}
    >
      <div className="flex items-center justify-between">
        <h3 className="font-display text-lg text-text-primary">Players</h3>
        {activeSeat && (
          <span className="rounded-full bg-accent-primary/10 px-2.5 py-1 text-[0.7rem] font-semibold uppercase tracking-wide text-accent-primary">
            You: Seat {activeSeat.seatIndex + 1}
          </span>
        )}
      </div>
      <div className="flex flex-col gap-2" role="list" aria-label="Draft players">
        {seats.length === 0 && (
          <p className="rounded-xl border border-dashed border-border px-3 py-4 text-sm text-text-secondary">
            Waiting for players...
          </p>
        )}
        {seats.map((seat) => (
          <div
            key={seat.seatIndex}
            role="listitem"
            className={cn(
              "flex items-center gap-3 rounded-lg border p-2 motion-safe:transition-colors",
               seat.isCurrentPlayer
                 ? "border-accent-primary/50 bg-accent-primary/10"
                 : "border-border bg-bg-elevated/50"
             )}
           >
            {/* Avatar placeholder */}
            <div
              className={cn(
                "flex h-8 w-8 shrink-0 items-center justify-center rounded-full",
                seat.isCurrentPlayer
                  ? "bg-accent-primary text-white"
                  : "bg-bg-elevated text-text-secondary"
              )}
            >
              <User className="h-4 w-4" aria-hidden="true" />
            </div>

            {/* Player info */}
            <div className="flex min-w-0 flex-1 flex-col">
              <span
                className={cn(
                  "truncate text-sm font-semibold",
                  seat.isCurrentPlayer ? "text-accent-primary" : "text-text-primary"
                )}
              >
                {seat.displayName}
              </span>
              <span className="text-xs text-text-secondary">
                Seat {seat.seatIndex + 1}
              </span>
            </div>

            {/* Status indicator */}
            {seat.hasPicked ? (
              <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-accent-success/20 text-accent-success">
                <Check className="h-4 w-4" aria-hidden="true" />
              </div>
            ) : (
              <div
                className={cn(
                  "h-2.5 w-2.5 shrink-0 rounded-full",
                  seat.isCurrentPlayer
                    ? "bg-accent-primary motion-safe:animate-pulse"
                    : "bg-text-secondary/30"
                )}
                aria-label={
                  seat.isCurrentPlayer ? "Current turn" : "Waiting"
                }
              />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
