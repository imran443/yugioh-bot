"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { BarChart3, ChevronLeft, Trophy } from "lucide-react";
import { Badge } from "@/components/ui/badge";

interface Standing {
  playerId: number;
  displayName: string;
  wins: number;
  losses: number;
}

export default function TournamentStandingsPage() {
  const params = useParams();
  const id = typeof params.slug === "string" ? params.slug : "";

  const [standings, setStandings] = useState<Standing[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    fetch(`/api/tournaments/${id}/standings`)
      .then((res) => {
        if (!res.ok) throw new Error("Failed to load standings");
        return res.json();
      })
      .then((data: Standing[]) => {
        setStandings(data);
        setLoading(false);
      })
      .catch((err) => {
        setError(err.message);
        setLoading(false);
      });
  }, [id]);

  if (loading) {
    return (
      <div>
        <div className="mx-auto max-w-3xl p-6">
          <div className="flex items-center justify-center py-20">
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-accent-primary border-t-transparent" />
          </div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div>
        <div className="mx-auto max-w-3xl p-6">
          <div className="rounded-lg border border-accent-cta/20 bg-accent-cta/10 p-6 text-accent-cta">
            {error}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="mx-auto max-w-3xl p-4 sm:p-6 lg:p-8">
        <Link
          href={`/tournament/${id}`}
          className="mb-4 inline-flex items-center gap-1 text-sm text-text-muted hover:text-text-secondary"
        >
          <ChevronLeft className="h-4 w-4" />
          Back to Tournament
        </Link>

        <h1 className="mb-6 flex items-center gap-3 font-display text-2xl text-text-primary sm:text-3xl">
          <BarChart3 className="h-7 w-7 text-accent-primary" />
          Standings
        </h1>

        {standings.length === 0 ? (
          <div className="rounded-lg border border-border bg-surface p-8 text-center">
            <Trophy className="mx-auto mb-4 h-12 w-12 text-text-muted" />
            <p className="text-lg text-text-secondary">No standings yet</p>
            <p className="mt-2 text-sm text-text-muted">
              Matches need to be completed before standings appear
            </p>
          </div>
        ) : (
          <div className="overflow-hidden rounded-xl border border-border bg-surface">
            <table className="w-full text-left">
              <thead>
                <tr className="border-b border-border bg-bg-elevated">
                  <th className="px-4 py-3 text-sm font-semibold text-text-muted sm:px-6">
                    Rank
                  </th>
                  <th className="px-4 py-3 text-sm font-semibold text-text-muted sm:px-6">
                    Player
                  </th>
                  <th className="px-4 py-3 text-right text-sm font-semibold text-text-muted sm:px-6">
                    Wins
                  </th>
                  <th className="px-4 py-3 text-right text-sm font-semibold text-text-muted sm:px-6">
                    Losses
                  </th>
                  <th className="px-4 py-3 text-right text-sm font-semibold text-text-muted sm:px-6">
                    Record
                  </th>
                </tr>
              </thead>
              <tbody>
                {standings.map((s, index) => (
                  <tr
                    key={s.playerId}
                    className="border-b border-border last:border-0 hover:bg-bg-elevated/50"
                  >
                    <td className="px-4 py-3 sm:px-6">
                      {index === 0 ? (
                        <Badge variant="warning">
                          <Trophy className="mr-1 inline h-3 w-3" />
                          1st
                        </Badge>
                      ) : index === 1 ? (
                        <span className="text-sm font-semibold text-text-secondary">
                          2nd
                        </span>
                      ) : index === 2 ? (
                        <span className="text-sm font-semibold text-text-muted">
                          3rd
                        </span>
                      ) : (
                        <span className="text-sm text-text-muted">
                          {index + 1}th
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 font-body font-semibold text-text-primary sm:px-6">
                      {s.displayName}
                    </td>
                    <td className="px-4 py-3 text-right text-accent-success sm:px-6">
                      {s.wins}
                    </td>
                    <td className="px-4 py-3 text-right text-accent-cta sm:px-6">
                      {s.losses}
                    </td>
                    <td className="px-4 py-3 text-right text-text-secondary sm:px-6">
                      {s.wins}W - {s.losses}L
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
