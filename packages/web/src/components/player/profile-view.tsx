"use client";

import { useState } from "react";
import {
  Trophy,
  Flame,
  Swords,
  Coins,
  Crown,
  Medal,
  Lock,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { recentActivityLabel } from "@/lib/recent-activity";
import { RankBadge } from "@/components/rank/rank-badge";
import { visualForRank } from "@/components/rank/rank-visuals";
import { ACHIEVEMENTS } from "@yugidraft/shared/scoring";
import type { ScoringService } from "@yugidraft/shared/services";

// ---------- types ----------

type Profile = ReturnType<ScoringService["getProfile"]>;

export interface ProfileViewProps {
  profile: Profile;
  leaderboardRank: number | null;
}

// ---------- constants ----------

const LUCIDE_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  trophy: Trophy,
  flame: Flame,
  swords: Swords,
  coins: Coins,
  crown: Crown,
  medal: Medal,
};

// ---------- sub-components ----------

function StatCard({
  label,
  children,
  sub,
}: {
  label: string;
  children: React.ReactNode;
  sub?: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-border bg-[#0F0F23] p-4">
      <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-[#9aa0b8]">{label}</p>
      <div className="font-display text-2xl text-[#E6E8F0]">{children}</div>
      {sub && <p className="mt-1 text-xs text-[#9aa0b8]">{sub}</p>}
    </div>
  );
}

function ScopeToggle({
  scope,
  onChange,
}: {
  scope: "season" | "all";
  onChange: (s: "season" | "all") => void;
}) {
  return (
    <div className="flex gap-2">
      {(["season", "all"] as const).map((s) => (
        <button
          key={s}
          onClick={() => onChange(s)}
          className={cn(
            "rounded-lg px-4 py-1.5 text-sm font-semibold transition-colors",
            scope === s
              ? "bg-[#8b5cf6] text-white"
              : "bg-[#1a1a35] text-[#9aa0b8] hover:bg-[#232345] hover:text-[#E6E8F0]",
          )}
        >
          {s === "season" ? "Season" : "All-Time"}
        </button>
      ))}
    </div>
  );
}

function relativeTime(isoString: string): string {
  const now = Date.now();
  const then = new Date(isoString).getTime();
  const diffSec = Math.floor((now - then) / 1000);
  if (diffSec < 60) return "just now";
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
  return `${Math.floor(diffSec / 86400)}d ago`;
}

// ---------- main component ----------

export function ProfileView({ profile: initialProfile, leaderboardRank: initialRank }: ProfileViewProps) {
  const [scope, setScope] = useState<"season" | "all">("season");
  const [profile, setProfile] = useState<Profile>(initialProfile);
  const [rank, setRank] = useState<number | null>(initialRank);
  const [loading, setLoading] = useState(false);

  const handleScopeChange = async (next: "season" | "all") => {
    if (next === scope) return;
    setScope(next);
    setLoading(true);
    try {
      const [profileRes, lbRes] = await Promise.all([
        fetch(`/api/player/${profile.playerId}?scope=${next}`),
        fetch(`/api/leaderboard?scope=${next}`),
      ]);
      if (profileRes.ok) {
        const data = await profileRes.json();
        setProfile(data);
      }
      if (lbRes.ok) {
        const lbData = await lbRes.json();
        const rows: Array<{ playerId: number }> = lbData.rows ?? [];
        const pos = rows.findIndex((r) => r.playerId === profile.playerId);
        setRank(pos >= 0 ? pos + 1 : null);
      }
    } finally {
      setLoading(false);
    }
  };

  const total = profile.wins + profile.losses;
  const winRate = total > 0 ? Math.round((profile.wins / total) * 100) : 0;

  // Build unlocked set from profile
  const unlockedKeys = new Set(profile.achievements.map((a) => a.achievement_key));

  const rankColor = visualForRank(profile.rank.name).color;

  // Avatar initials
  const initials = profile.displayName
    .split(" ")
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("");

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-4">
        {/* Gradient avatar */}
        <div
          className="flex h-16 w-16 flex-shrink-0 items-center justify-center rounded-full text-lg font-bold text-white"
          style={{
            background: `linear-gradient(135deg, ${rankColor}60, ${rankColor}20)`,
            border: `2px solid ${rankColor}60`,
          }}
        >
          {initials || "?"}
        </div>

        <div className="min-w-0">
          <h1 className="font-display text-2xl text-[#E6E8F0] sm:text-3xl">{profile.displayName}</h1>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <RankBadge rank={profile.rank.name} size="lg" celebrate playerId={profile.playerId} />
            <span className="text-sm text-[#9aa0b8]">
              {profile.rank.nextAt !== null
                ? `${profile.rank.nextAt - profile.rating} rating to next rank`
                : "Max rank"}
            </span>
          </div>
        </div>
      </div>

      {/* Scope toggle */}
      <ScopeToggle scope={scope} onChange={handleScopeChange} />

      {/* Stat cards */}
      {loading ? (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-24 animate-pulse rounded-xl bg-[#0F0F23]" />
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <StatCard
            label="Season Winnings"
            sub={rank !== null ? `#${rank} server rank` : undefined}
          >
            <span style={{ color: "#f5c451" }}>{profile.winnings.toLocaleString()}</span>
          </StatCard>

          <StatCard label="Skill Rating">
            {profile.rating}
          </StatCard>

          <StatCard
            label="Win Streak"
            sub={`Best this season: ${profile.bestStreak}`}
          >
            {profile.currentStreak > 0 ? (
              <span className="inline-flex items-center gap-1" style={{ color: "#f97316" }}>
                <Flame className="h-5 w-5" />
                {profile.currentStreak}
              </span>
            ) : (
              <span>0</span>
            )}
          </StatCard>

          <StatCard
            label="Win / Loss"
            sub={total > 0 ? `${winRate}% win rate` : "No matches yet"}
          >
            <span>
              <span style={{ color: "#4ade80" }}>{profile.wins}W</span>
              <span className="mx-1 text-[#9aa0b8]">·</span>
              <span style={{ color: "#f87171" }}>{profile.losses}L</span>
            </span>
          </StatCard>
        </div>
      )}

      {/* Achievements */}
      <div>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-[#9aa0b8]">
          Achievements
        </h2>
        <div className="flex flex-wrap gap-2">
          {ACHIEVEMENTS.map((achievement) => {
            const unlocked = unlockedKeys.has(achievement.key);
            const Icon = LUCIDE_ICONS[achievement.icon] ?? Trophy;
            return (
              <div
                key={achievement.key}
                title={achievement.name}
                className={cn(
                  "flex h-[46px] w-[46px] items-center justify-center rounded-lg border transition-colors",
                  unlocked
                    ? "border-[#8b5cf6]/40 bg-[#8b5cf6]/10"
                    : "border-border bg-[#0F0F23]",
                )}
              >
                {unlocked ? (
                  <Icon className="h-5 w-5 text-[#a78bfa]" />
                ) : (
                  <Lock className="h-5 w-5 text-[#9aa0b8]" style={{ opacity: 0.32 }} />
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Recent results */}
      <div>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-[#9aa0b8]">
          Recent Activity
        </h2>
        {profile.recent.length === 0 ? (
          <div className="rounded-xl border border-border bg-[#0F0F23] p-6 text-center text-[#9aa0b8]">
            No activity yet.
          </div>
        ) : (
          <div className="space-y-2">
            {(profile.recent as Array<{
              kind: string;
              points: number;
              created_at: string;
              tournament_id: number | null;
              tournament_name: string | null;
            }>).map((entry, i) => {
              const label = recentActivityLabel(entry);
              return (
                <div
                  key={i}
                  className="flex items-center justify-between rounded-lg border border-border bg-[#0F0F23] px-4 py-3"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-[#E6E8F0]">{label}</p>
                    <p className="text-xs text-[#9aa0b8]">{relativeTime(entry.created_at)}</p>
                  </div>
                  <span className="ml-4 flex-shrink-0 font-semibold tabular-nums" style={{ color: "#4ade80" }}>
                    +{entry.points}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
