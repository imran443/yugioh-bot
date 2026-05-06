"use client";

import { useEffect, useState } from "react";
import { Layers, Plus } from "lucide-react";
import Link from "next/link";
import { DraftCard, type DraftCardProps } from "@/components/draft/draft-card";

interface DraftsData {
  active: DraftCardProps[];
  pending: DraftCardProps[];
  completed: DraftCardProps[];
  cancelled: DraftCardProps[];
}

export default function DraftsPage() {
  const [data, setData] = useState<DraftsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/drafts")
      .then((res) => {
        if (!res.ok) throw new Error("Failed to load drafts");
        return res.json();
      })
      .then((d: DraftsData) => {
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

  const totalDrafts =
    (data?.active.length ?? 0) +
    (data?.pending.length ?? 0) +
    (data?.completed.length ?? 0) +
    (data?.cancelled.length ?? 0);

  return (
    <main className="min-h-screen bg-bg-deep text-text-primary">
      <div className="mx-auto max-w-4xl p-4 sm:p-6 lg:p-8">
        <div className="mb-8 flex items-center justify-between">
          <h1 className="font-display text-2xl text-text-primary sm:text-3xl">
            Drafts
          </h1>
          <Link
            href="/drafts/new"
            className="inline-flex items-center gap-2 rounded-lg bg-accent-primary px-4 py-2 text-sm font-semibold text-white hover:bg-accent-secondary"
          >
            <Plus className="h-4 w-4" />
            New Draft
          </Link>
        </div>

        {totalDrafts === 0 ? (
          <div className="rounded-lg border border-border bg-surface p-8 text-center">
            <Layers className="mx-auto mb-4 h-12 w-12 text-text-muted" />
            <p className="text-lg text-text-secondary">No drafts yet</p>
            <p className="mt-2 text-sm text-text-muted">
              Drafts created in Discord will appear here
            </p>
          </div>
        ) : (
          <div className="space-y-8">
            {data && data.active.length > 0 && (
              <section>
                <h2 className="mb-4 font-body text-lg font-semibold text-accent-success">
                  Active
                </h2>
                <div className="grid gap-4 sm:grid-cols-2">
                  {data.active.map((d) => (
                    <DraftCard key={d.id} draft={d} />
                  ))}
                </div>
              </section>
            )}

            {data && data.pending.length > 0 && (
              <section>
                <h2 className="mb-4 font-body text-lg font-semibold text-accent-gold">
                  Pending
                </h2>
                <div className="grid gap-4 sm:grid-cols-2">
                  {data.pending.map((d) => (
                    <DraftCard key={d.id} draft={d} />
                  ))}
                </div>
              </section>
            )}

            {data && data.completed.length > 0 && (
              <section>
                <h2 className="mb-4 font-body text-lg font-semibold text-text-secondary">
                  Completed
                </h2>
                <div className="grid gap-4 sm:grid-cols-2">
                  {data.completed.map((d) => (
                    <DraftCard key={d.id} draft={d} />
                  ))}
                </div>
              </section>
            )}

            {data && data.cancelled.length > 0 && (
              <section>
                <h2 className="mb-4 font-body text-lg font-semibold text-text-muted">
                  Cancelled
                </h2>
                <div className="grid gap-4 sm:grid-cols-2">
                  {data.cancelled.map((d) => (
                    <DraftCard key={d.id} draft={d} />
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