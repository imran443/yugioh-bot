"use client";

import { useDraftStore } from "@/lib/stores/draft-store";
import { cn } from "@/lib/utils";
import { Clock } from "lucide-react";

interface TimerBarProps {
  className?: string;
}

export function TimerBar({ className }: TimerBarProps) {
  const packRound = useDraftStore((s) => s.packRound);
  const pickStep = useDraftStore((s) => s.pickStep);
  const timerSeconds = useDraftStore((s) => s.timerSeconds);
  const pickSeconds = useDraftStore((s) => s.pickSeconds);
  const completed = useDraftStore((s) => s.completed);

  const isUrgent = timerSeconds <= 10 && timerSeconds > 0;
  const isCritical = timerSeconds <= 5 && timerSeconds > 0;

  const minutes = Math.floor(timerSeconds / 60);
  const seconds = timerSeconds % 60;
  const timeDisplay = `${minutes}:${seconds.toString().padStart(2, "0")}`;

  const progressScale = pickSeconds > 0 ? timerSeconds / pickSeconds : 0;

  return (
    <div
      className={cn(
        "flex flex-col gap-2 rounded-xl border border-border bg-surface p-3",
        className
      )}
    >
      <div className="flex items-center justify-end text-[0.7rem] font-semibold uppercase tracking-[0.22em]">
        {!completed && (
          <span className={cn(isUrgent ? "text-accent-cta" : "text-accent-primary")}>
            {isUrgent ? "Urgent" : "Live"}
          </span>
        )}
      </div>

      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Clock
            className={cn(
              "h-5 w-5",
              isUrgent ? "text-accent-cta" : "text-text-secondary"
            )}
            aria-hidden="true"
          />
            <span className="text-sm font-semibold text-text-secondary">
              Pack {packRound} &middot; Pick {pickStep}
            </span>
          </div>

        {completed ? (
          <span className="font-display text-xl text-accent-success">
            Completed
          </span>
        ) : (
          <span
            className={cn(
              "font-display text-2xl tracking-wider",
              isUrgent ? "text-accent-cta" : "text-text-primary",
              isCritical && "motion-safe:animate-pulse"
            )}
          >
            {timeDisplay}
          </span>
        )}
      </div>

      {/* Progress bar — GPU-composited via scaleX */}
      {!completed && (
        <div className="h-2 w-full overflow-hidden rounded-full bg-bg-elevated">
          <div
            className={cn(
              "h-full w-full origin-left rounded-full motion-safe:transition-transform motion-safe:duration-1000",
              isUrgent ? "bg-accent-cta" : "bg-accent-primary"
            )}
            style={{ transform: `scaleX(${progressScale})` }}
            role="progressbar"
            aria-valuenow={timerSeconds}
            aria-valuemin={0}
            aria-valuemax={pickSeconds}
          />
        </div>
      )}
    </div>
  );
}
