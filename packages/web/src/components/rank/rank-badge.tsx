"use client";

import { useEffect, useId, useState } from "react";
import { cn } from "@/lib/utils";
import { visualForRank } from "./rank-visuals";
import { didRankUp } from "./rank-up";

export interface RankBadgeProps {
  rank: string;
  /** sm = table + dashboard (default), lg = profile header */
  size?: "sm" | "lg";
  /** run idle + hover animation (default true) */
  animate?: boolean;
  /** play the one-shot rank-up pop on mount when the tier increased */
  celebrate?: boolean;
  /** required when celebrate is true — scopes the localStorage key */
  playerId?: number;
}

export function RankBadge({
  rank,
  size = "sm",
  animate = true,
  celebrate = false,
  playerId,
}: RankBadgeProps) {
  const visual = visualForRank(rank);
  const gradientId = useId();
  const [popping, setPopping] = useState(false);

  useEffect(() => {
    if (!celebrate || playerId == null) return;
    const key = `rank:lastSeen:${playerId}`;
    let prev: string | null = null;
    try {
      prev = window.localStorage.getItem(key);
    } catch {
      return; // storage unavailable (private mode etc.)
    }
    if (didRankUp(prev, rank)) setPopping(true);
    try {
      window.localStorage.setItem(key, rank);
    } catch {
      // ignore write failures
    }
  }, [celebrate, playerId, rank]);

  const gemSize = size === "lg" ? 22 : 15;
  const sizing = size === "lg" ? "px-3 py-1 text-sm gap-2" : "px-2.5 py-0.5 text-xs gap-1.5";

  return (
    <span
      data-testid="rank-badge"
      className={cn(
        "relative inline-flex items-center overflow-hidden rounded-full font-semibold",
        sizing,
        animate && !popping && visual.idleClass,
        animate &&
          "motion-safe:transition-transform motion-safe:duration-150 motion-safe:hover:-translate-y-0.5 motion-safe:hover:scale-105",
        popping && "rank-pop",
      )}
      style={{
        color: visual.color,
        background: `${visual.color}18`,
        border: `1px solid ${visual.color}40`,
      }}
      onAnimationEnd={() => setPopping(false)}
    >
      <svg
        className="rank-gem flex-shrink-0"
        width={gemSize}
        height={gemSize}
        viewBox="0 0 24 24"
        aria-hidden="true"
      >
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor={visual.gradientFrom} />
            <stop offset="1" stopColor={visual.gradientTo} />
          </linearGradient>
        </defs>
        <path fill={`url(#${gradientId})`} d="M6 3h12l4 6-10 13L2 9Z" />
        <path fill="#ffffff44" d="M6 3h12l-6 6Z" />
      </svg>
      {animate && visual.twinkle && (
        <>
          <i className="rank-twinkle rank-twinkle-1" aria-hidden="true" />
          <i className="rank-twinkle rank-twinkle-2" aria-hidden="true" />
        </>
      )}
      <span className="rank-label">{rank}</span>
    </span>
  );
}
