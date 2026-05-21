"use client";

import { useState } from "react";
import {
  LeaderboardTable,
  type LeaderboardRow,
} from "@/components/leaderboard/leaderboard-table";

interface LeaderboardClientProps {
  initialRows: LeaderboardRow[];
  currentPlayerId: number | null;
}

export function LeaderboardClient({ initialRows, currentPlayerId }: LeaderboardClientProps) {
  const [rows, setRows] = useState<LeaderboardRow[]>(initialRows);
  const [scope, setScope] = useState<"season" | "all">("season");
  const [loading, setLoading] = useState(false);

  const handleScopeChange = async (next: "season" | "all") => {
    if (next === scope) return;
    setScope(next);
    setLoading(true);
    try {
      const res = await fetch(`/api/leaderboard?scope=${next}`);
      if (res.ok) {
        const data = await res.json();
        setRows(data.rows ?? []);
      }
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="space-y-2">
        <div className="flex gap-2">
          <div className="h-9 w-24 animate-pulse rounded-lg bg-[#1a1a35]" />
          <div className="h-9 w-24 animate-pulse rounded-lg bg-[#1a1a35]" />
        </div>
        <div className="h-48 animate-pulse rounded-xl bg-[#0F0F23]" />
      </div>
    );
  }

  return (
    <LeaderboardTable
      rows={rows}
      currentPlayerId={currentPlayerId}
      scope={scope}
      onScopeChange={handleScopeChange}
    />
  );
}
