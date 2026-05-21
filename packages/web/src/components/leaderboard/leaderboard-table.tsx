"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Trophy, Flame } from "lucide-react";
import { cn } from "@/lib/utils";

export interface LeaderboardRow {
  playerId: number;
  displayName: string;
  winnings: number;
  rating: number;
  rank: string;
  currentStreak: number;
  wins: number;
  losses: number;
  winRate: number;
}

interface LeaderboardTableProps {
  rows: LeaderboardRow[];
  currentPlayerId: number | null;
  scope: "season" | "all";
  onScopeChange: (scope: "season" | "all") => void;
}

const RANK_COLORS: Record<string, string> = {
  Diamond: "#a78bfa",
  Platinum: "#7dd3fc",
  Gold: "#f5c451",
  Silver: "#cbd5e1",
  Bronze: "#d6a06a",
};

function RankBadge({ rank }: { rank: string }) {
  const color = RANK_COLORS[rank] ?? "#9aa0b8";
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold"
      style={{
        background: `${color}18`,
        color,
        border: `1px solid ${color}40`,
      }}
    >
      {rank}
    </span>
  );
}

function PositionNumber({ pos }: { pos: number }) {
  if (pos === 1)
    return (
      <span className="inline-flex items-center gap-1 font-bold tabular-nums" style={{ color: "#f5c451" }}>
        <Trophy className="h-3.5 w-3.5" />1
      </span>
    );
  if (pos === 2)
    return (
      <span className="font-bold tabular-nums" style={{ color: "#cbd5e1" }}>
        #2
      </span>
    );
  if (pos === 3)
    return (
      <span className="font-bold tabular-nums" style={{ color: "#d6a06a" }}>
        #3
      </span>
    );
  return <span className="tabular-nums text-[#9aa0b8]">#{pos}</span>;
}

export function LeaderboardTable({
  rows,
  currentPlayerId,
  scope,
  onScopeChange,
}: LeaderboardTableProps) {
  const router = useRouter();

  return (
    <div>
      {/* Scope toggle */}
      <div className="mb-4 flex gap-2">
        <button
          onClick={() => onScopeChange("season")}
          className={cn(
            "rounded-lg px-4 py-1.5 text-sm font-semibold transition-colors",
            scope === "season"
              ? "bg-[#8b5cf6] text-white"
              : "bg-[#1a1a35] text-[#9aa0b8] hover:bg-[#232345] hover:text-[#E6E8F0]",
          )}
        >
          Season
        </button>
        <button
          onClick={() => onScopeChange("all")}
          className={cn(
            "rounded-lg px-4 py-1.5 text-sm font-semibold transition-colors",
            scope === "all"
              ? "bg-[#8b5cf6] text-white"
              : "bg-[#1a1a35] text-[#9aa0b8] hover:bg-[#232345] hover:text-[#E6E8F0]",
          )}
        >
          All-Time
        </button>
      </div>

      {rows.length === 0 ? (
        <div className="rounded-xl border border-border bg-surface p-8 text-center text-[#9aa0b8]">
          No players on the leaderboard yet.
        </div>
      ) : (
        /* Horizontally scrollable wrapper — prevents page-level overflow at 375px */
        <div className="overflow-x-auto rounded-xl border border-border">
          <table className="w-full min-w-[600px] text-sm">
            <thead>
              <tr className="border-b border-border bg-[#0F0F23]">
                <th className="py-3 pl-4 pr-2 text-left text-xs font-semibold uppercase tracking-wide text-[#9aa0b8]">
                  #
                </th>
                <th className="py-3 px-2 text-left text-xs font-semibold uppercase tracking-wide text-[#9aa0b8]">
                  Player
                </th>
                <th className="py-3 px-2 text-left text-xs font-semibold uppercase tracking-wide text-[#9aa0b8]">
                  Rank
                </th>
                <th className="py-3 px-2 text-right text-xs font-semibold uppercase tracking-wide text-[#9aa0b8]">
                  Rating
                </th>
                <th className="py-3 px-2 text-right text-xs font-semibold uppercase tracking-wide text-[#9aa0b8]">
                  Winnings
                </th>
                <th className="py-3 px-2 text-right text-xs font-semibold uppercase tracking-wide text-[#9aa0b8]">
                  Streak
                </th>
                <th className="py-3 px-2 text-right text-xs font-semibold uppercase tracking-wide text-[#9aa0b8]">
                  W / L
                </th>
                <th className="py-3 pl-2 pr-4 text-right text-xs font-semibold uppercase tracking-wide text-[#9aa0b8]">
                  Win%
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => {
                const isCurrentUser = row.playerId === currentPlayerId;
                return (
                  <tr
                    key={row.playerId}
                    onClick={() => router.push(`/player/${row.playerId}`)}
                    className={cn(
                      "cursor-pointer border-b border-border transition-colors last:border-0",
                      isCurrentUser
                        ? "border-l-2 border-l-[#8b5cf6] bg-[#8b5cf6]/10 hover:bg-[#8b5cf6]/15"
                        : "hover:bg-[#1a1a35]",
                    )}
                  >
                    <td className="py-3 pl-4 pr-2 text-left">
                      <PositionNumber pos={i + 1} />
                    </td>
                    <td className="py-3 px-2 font-medium text-[#E6E8F0]">
                      {row.displayName}
                      {isCurrentUser && (
                        <span className="ml-2 text-xs text-[#8b5cf6]">(you)</span>
                      )}
                    </td>
                    <td className="py-3 px-2">
                      <RankBadge rank={row.rank} />
                    </td>
                    <td className="py-3 px-2 text-right tabular-nums text-[#E6E8F0]">
                      {row.rating}
                    </td>
                    <td
                      className="py-3 px-2 text-right tabular-nums font-semibold"
                      style={{ color: "#f5c451" }}
                    >
                      {row.winnings.toLocaleString()}
                    </td>
                    <td className="py-3 px-2 text-right tabular-nums">
                      {row.currentStreak > 0 ? (
                        <span className="inline-flex items-center justify-end gap-1" style={{ color: "#f97316" }}>
                          <Flame className="h-3.5 w-3.5" />
                          {row.currentStreak}
                        </span>
                      ) : (
                        <span className="text-[#9aa0b8]">—</span>
                      )}
                    </td>
                    <td className="py-3 px-2 text-right tabular-nums text-[#9aa0b8]">
                      <span style={{ color: "#4ade80" }}>{row.wins}</span>
                      <span className="mx-1">/</span>
                      <span style={{ color: "#f87171" }}>{row.losses}</span>
                    </td>
                    <td className="py-3 pl-2 pr-4 text-right tabular-nums text-[#E6E8F0]">
                      {row.winRate}%
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
