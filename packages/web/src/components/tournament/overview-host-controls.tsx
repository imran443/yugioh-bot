"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ShieldAlert, X } from "lucide-react";
import { Button } from "@/components/ui/button";

export function OverviewHostControls({ tournamentSlug }: { tournamentSlug: string }) {
  const router = useRouter();
  const [showConfirm, setShowConfirm] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleCancel() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/tournaments/${tournamentSlug}`, { method: "DELETE" });
      if (!res.ok) {
        const body = await res.json();
        throw new Error(body.error ?? "Failed to cancel");
      }
      router.push("/tournaments");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to cancel");
      setLoading(false);
    }
  }

  return (
    <section className="rounded-xl border border-border bg-surface p-5">
      <div className="mb-3 flex items-center gap-2">
        <ShieldAlert className="h-4 w-4 text-text-secondary" />
        <h2 className="font-body text-sm font-semibold uppercase tracking-wider text-text-secondary">
          Host controls
        </h2>
      </div>

      {error && (
        <div className="mb-3 rounded-lg border border-accent-cta/50 bg-accent-cta/10 px-3 py-2 text-sm text-accent-cta">
          {error}
        </div>
      )}

      {showConfirm ? (
        <div className="flex flex-col gap-3 rounded-lg border border-accent-cta/40 bg-accent-cta/5 px-4 py-3 text-sm">
          <span className="text-text-secondary">
            Cancel this tournament? Players will be notified and standings will be frozen. This cannot be undone.
          </span>
          <div className="flex items-center gap-3">
            <Button variant="danger" size="md" loading={loading} onClick={handleCancel}>
              Yes, cancel
            </Button>
            <button
              type="button"
              className="inline-flex min-h-[44px] items-center px-2 text-text-secondary hover:text-text-primary"
              onClick={() => setShowConfirm(false)}
            >
              Go back
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setShowConfirm(true)}
          className="inline-flex min-h-[44px] items-center gap-1.5 py-2 text-sm text-text-secondary motion-safe:transition-colors hover:text-accent-cta"
        >
          <X className="h-4 w-4" />
          Cancel tournament
        </button>
      )}
    </section>
  );
}
