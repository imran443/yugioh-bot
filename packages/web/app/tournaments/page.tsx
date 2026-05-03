"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Trophy, Users, ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

interface Tournament {
  id: number;
  name: string;
  format: string;
  status: string;
  participantCount: number;
  webSlug?: string;
}

export default function TournamentsPage() {
  const [tournaments, setTournaments] = useState<Tournament[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/tournaments")
      .then((res) => {
        if (!res.ok) throw new Error("Failed to load tournaments");
        return res.json();
      })
      .then((data: Tournament[]) => {
        setTournaments(data);
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

  const active = tournaments.filter((t) => t.status === "active");
  const pending = tournaments.filter((t) => t.status === "pending");

  return (
    <main className="min-h-screen bg-bg-deep text-text-primary">
      <div className="mx-auto max-w-4xl p-4 sm:p-6 lg:p-8">
        <div className="mb-8 flex items-center justify-between">
          <h1 className="font-display text-2xl text-text-primary sm:text-3xl">
            Tournaments
          </h1>
        </div>

        {tournaments.length === 0 ? (
          <div className="rounded-lg border border-border bg-surface p-8 text-center">
            <Trophy className="mx-auto mb-4 h-12 w-12 text-text-muted" />
            <p className="text-lg text-text-secondary">No active tournaments</p>
            <p className="mt-2 text-sm text-text-muted">
              Tournaments created in Discord will appear here
            </p>
          </div>
        ) : (
          <div className="space-y-8">
            {active.length > 0 && (
              <section>
                <h2 className="mb-4 font-body text-lg font-semibold text-accent-gold">
                  Active
                </h2>
                <div className="grid gap-4 sm:grid-cols-2">
                  {active.map((t) => (
                    <TournamentCard key={t.id} tournament={t} />
                  ))}
                </div>
              </section>
            )}

            {pending.length > 0 && (
              <section>
                <h2 className="mb-4 font-body text-lg font-semibold text-text-secondary">
                  Pending
                </h2>
                <div className="grid gap-4 sm:grid-cols-2">
                  {pending.map((t) => (
                    <TournamentCard key={t.id} tournament={t} />
                  ))}
                </div>
              </section>
            )}
          </div>
        )}
      </div>
    </main>
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
            <Badge variant={statusVariant}>
              {tournament.status}
            </Badge>
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
