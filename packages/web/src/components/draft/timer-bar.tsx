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
  const draftedCount = useDraftStore((s) => s.myPool.length);
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
        "flex flex-col gap-3 rounded-xl border border-border bg-surface p-3",
        className
      )}
    >
      <div className="mx-auto grid w-full max-w-3xl grid-cols-1 items-center gap-2 text-center sm:grid-cols-[1fr_auto_1fr] sm:gap-4">
        <div className="flex items-center justify-center gap-2 text-sm font-semibold text-text-secondary sm:justify-end">
          <Clock
            className={cn(
              "h-4 w-4",
              isUrgent ? "text-accent-cta" : "text-text-secondary"
            )}
            aria-hidden="true"
          />
          <span>Pack {packRound} &middot; Pick {pickStep}</span>
        </div>

        {completed ? (
          <span className="font-display text-2xl tracking-wide text-accent-success">
            Completed
          </span>
        ) : (
          <span
            role="timer"
            aria-label={`Time remaining ${timeDisplay}`}
            className={cn(
              "rounded-2xl border px-5 py-2 font-display text-3xl leading-none tracking-wider shadow-card sm:min-w-36",
              isUrgent ? "border-accent-cta/60 bg-accent-cta/10" : "border-accent-primary/50 bg-accent-primary/10",
              isUrgent ? "text-accent-cta" : "text-text-primary",
              isCritical && "motion-safe:animate-pulse"
            )}
          >
            {timeDisplay}
          </span>
        )}

        <div className="flex items-center justify-center gap-2 sm:justify-start">
          <span className="rounded-full border border-border bg-bg-elevated/70 px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em] text-text-secondary">
            Drafted
          </span>
          <span className="font-display text-xl tracking-wide text-text-primary">
            {draftedCount} / 40
          </span>
        </div>
      </div>

      {/* Progress bar — GPU-composited via scaleX */}
      {!completed && (
        <div className="flex items-center gap-3">
          <span className={cn("shrink-0 text-[1.025rem] font-semibold uppercase leading-none tracking-[0.22em]", isUrgent ? "text-accent-cta" : "text-accent-primary")}>
            {isUrgent ? "Urgent" : "Live"}
          </span>
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
        </div>
      )}
    </div>
  );
}
