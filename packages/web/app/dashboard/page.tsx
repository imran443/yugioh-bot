"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  Trophy,
  Layers,
  Swords,
  TrendingUp,
  Users,
  ArrowRight,
  Target,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

interface Tournament {
  id: number;
  name: string;
  format: string;
  status: string;
  participantCount: number;
  webSlug?: string;
}

interface Draft {
  id: number;
  name: string;
  status: string;
  currentPackRound: number;
  currentPickStep: number;
  playerCount: number;
  webSlug?: string;
}

interface Stats {
  wins: number;
  losses: number;
}

interface DashboardData {
  tournaments: Tournament[];
  drafts: Draft[];
  stats: Stats;
}

export default function DashboardPage() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/dashboard")
      .then((res) => {
        if (!res.ok) throw new Error("Failed to load dashboard");
        return res.json();
      })
      .then((d: DashboardData) => {
        setData(d);
        setLoading(false);
      })
      .catch((err) => {
        setError(err.message);
        setLoading(false);
      });
  }, []);

  if (loading) {
    return (
      <main className="min-h-screen bg-bg-deep text-text-primary">
        <div className="mx-auto max-w-4xl p-6">
          <div className="flex items-center justify-center py-20">
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-accent-primary border-t-transparent" />
          </div>
        </div>
      </main>
    );
  }

  if (error) {
    return (
      <main className="min-h-screen bg-bg-deep text-text-primary">
        <div className="mx-auto max-w-4xl p-6">
          <div className="rounded-lg border border-accent-cta/20 bg-accent-cta/10 p-6 text-accent-cta">
            {error}
          </div>
        </div>
      </main>
    );
  }

  const totalGames = (data?.stats.wins ?? 0) + (data?.stats.losses ?? 0);
  const winRate =
    totalGames > 0 ? Math.round((data!.stats.wins / totalGames) * 100) : 0;

  return (
    <main className="min-h-screen bg-bg-deep text-text-primary">
      <div className="mx-auto max-w-4xl p-4 sm:p-6 lg:p-8">
        <h1 className="mb-8 font-display text-2xl text-text-primary sm:text-3xl">
          Dashboard
        </h1>

        {/* Stats Cards */}
        <div className="mb-8 grid grid-cols-2 gap-4 sm:grid-cols-4">
          <StatCard
            icon={<Trophy className="h-5 w-5 text-accent-gold" />}
            label="Wins"
            value={data?.stats.wins ?? 0}
          />
          <StatCard
            icon={<Target className="h-5 w-5 text-accent-cta" />}
            label="Losses"
            value={data?.stats.losses ?? 0}
          />
          <StatCard
            icon={<Swords className="h-5 w-5 text-accent-primary" />}
            label="Matches"
            value={totalGames}
          />
          <StatCard
            icon={<TrendingUp className="h-5 w-5 text-accent-success" />}
            label="Win Rate"
            value={`${winRate}%`}
          />
        </div>

        {/* Active Tournaments */}
        <section className="mb-8">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="flex items-center gap-2 font-body text-lg font-semibold text-text-primary">
              <Trophy className="h-5 w-5 text-accent-gold" />
              Your Tournaments
            </h2>
            <Link href="/tournaments">
              <Button variant="ghost" size="sm">
                View All
                <ArrowRight className="ml-1 h-4 w-4" />
              </Button>
            </Link>
          </div>

          {data?.tournaments.length === 0 ? (
            <div className="rounded-lg border border-border bg-surface p-6 text-center">
              <p className="text-text-secondary">
                No active tournaments. Join one from Discord!
              </p>
            </div>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2">
              {data?.tournaments.map((t) => (
                <TournamentCard key={t.id} tournament={t} />
              ))}
            </div>
          )}
        </section>

        {/* Active Drafts */}
        <section>
          <div className="mb-4 flex items-center justify-between">
            <h2 className="flex items-center gap-2 font-body text-lg font-semibold text-text-primary">
              <Layers className="h-5 w-5 text-accent-primary" />
              Your Drafts
            </h2>
          </div>

          {data?.drafts.length === 0 ? (
            <div className="rounded-lg border border-border bg-surface p-6 text-center">
              <p className="text-text-secondary">
                No active drafts. Join one from Discord!
              </p>
            </div>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2">
              {data?.drafts.map((d) => (
                <DraftCard key={d.id} draft={d} />
              ))}
            </div>
          )}
        </section>
      </div>
    </main>
  );
}

function StatCard({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: string | number;
}) {
  return (
    <div className="rounded-xl border border-border bg-surface p-4">
      <div className="mb-2 flex items-center gap-2">
        {icon}
        <span className="text-xs font-semibold uppercase tracking-wide text-text-muted">
          {label}
        </span>
      </div>
      <div className="font-display text-2xl text-text-primary">{value}</div>
    </div>
  );
}

function TournamentCard({ tournament }: { tournament: Tournament }) {
  const statusVariant =
    tournament.status === "active"
      ? "success"
      : tournament.status === "pending"
        ? "warning"
        : "default";

  const formatLabel =
    tournament.format === "round_robin"
      ? "Round Robin"
      : tournament.format === "single_elim"
        ? "Single Elimination"
        : tournament.format;

  return (
    <Link
      href={`/tournament/${tournament.id}`}
      className="group block rounded-xl border border-border bg-surface p-5 motion-safe:transition-colors hover:border-accent-primary/30 hover:bg-bg-elevated"
    >
      <div className="flex items-start justify-between">
        <div>
          <h3 className="font-body text-lg font-semibold text-text-primary">
            {tournament.name}
          </h3>
          <div className="mt-2 flex items-center gap-3">
            <Badge variant={statusVariant}>{tournament.status}</Badge>
            <span className="text-sm text-text-muted">{formatLabel}</span>
          </div>
        </div>
        <ArrowRight className="h-5 w-5 shrink-0 text-text-muted motion-safe:transition-transform group-hover:translate-x-1" />
      </div>
      <div className="mt-4 flex items-center gap-2 text-sm text-text-secondary">
        <Users className="h-4 w-4" />
        <span>{tournament.participantCount} participants</span>
      </div>
    </Link>
  );
}

function DraftCard({ draft }: { draft: Draft }) {
  const statusVariant =
    draft.status === "active"
      ? "success"
      : draft.status === "pending"
        ? "warning"
        : "default";

  return (
    <div className="rounded-xl border border-border bg-surface p-5">
      <div className="flex items-start justify-between">
        <div>
          <h3 className="font-body text-lg font-semibold text-text-primary">
            {draft.name}
          </h3>
          <div className="mt-2 flex items-center gap-3">
            <Badge variant={statusVariant}>{draft.status}</Badge>
            {draft.status === "active" && (
              <span className="text-sm text-text-muted">
                Pack {draft.currentPackRound}, Pick {draft.currentPickStep}
              </span>
            )}
          </div>
        </div>
      </div>
      <div className="mt-4 flex items-center gap-2 text-sm text-text-secondary">
        <Users className="h-4 w-4" />
        <span>{draft.playerCount} players</span>
      </div>
      {draft.webSlug && draft.status === "active" && (
        <div className="mt-3">
          <Link
            href={`/draft/${draft.webSlug}`}
            className="text-sm font-semibold text-accent-primary hover:text-accent-secondary"
          >
            Open Draft Room →
          </Link>
        </div>
      )}
    </div>
  );
}
