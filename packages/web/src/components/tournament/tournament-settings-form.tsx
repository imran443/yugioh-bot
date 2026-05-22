"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";

// datetime-local needs "YYYY-MM-DDTHH:mm" (local time, no seconds/zone).
function isoToLocalInput(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function TournamentSettingsForm({
  tournamentSlug,
  initialDeadlineAt,
  initialReportConfirmWindowHours,
  onSaved,
}: {
  tournamentSlug: string;
  initialDeadlineAt?: string;
  initialReportConfirmWindowHours?: number;
  onSaved: () => void;
}) {
  const [deadline, setDeadline] = React.useState(isoToLocalInput(initialDeadlineAt));
  const [hours, setHours] = React.useState(
    initialReportConfirmWindowHours != null ? String(initialReportConfirmWindowHours) : "",
  );
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [saved, setSaved] = React.useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSaved(false);
    setSaving(true);
    try {
      const body: { deadlineAt: string | null; reportConfirmWindowHours: number | null } = {
        deadlineAt: deadline ? new Date(deadline).toISOString() : null,
        reportConfirmWindowHours: hours.trim() ? Number(hours) : null,
      };
      const res = await fetch(`/api/tournaments/${tournamentSlug}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? "Failed to save settings");
      }
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "An error occurred");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="space-y-3 rounded-xl border border-border bg-surface p-4"
    >
      <h3 className="font-body text-sm font-semibold uppercase tracking-wider text-text-secondary">
        Tournament settings
      </h3>
      {error && <p className="text-sm text-accent-cta">{error}</p>}
      <div>
        <label
          htmlFor="settings-deadline"
          className="mb-1 block text-sm font-medium text-text-primary"
        >
          Deadline (optional)
        </label>
        <input
          id="settings-deadline"
          type="datetime-local"
          value={deadline}
          onChange={(e) => setDeadline(e.target.value)}
          className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text-primary focus:border-accent-primary focus:outline-none"
        />
        <p className="mt-1 text-xs text-text-secondary">
          Auto-closes the tournament once this time passes.
        </p>
      </div>
      <div>
        <label
          htmlFor="settings-hours"
          className="mb-1 block text-sm font-medium text-text-primary"
        >
          Confirm window (hours, optional)
        </label>
        <input
          id="settings-hours"
          type="number"
          min={1}
          max={720}
          value={hours}
          placeholder="24"
          onChange={(e) => setHours(e.target.value)}
          className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text-primary placeholder:text-text-secondary focus:border-accent-primary focus:outline-none"
        />
        <p className="mt-1 text-xs text-text-secondary">
          Reports auto-approve if the opponent doesn&apos;t confirm in time (default 24).
        </p>
      </div>
      <Button type="submit" loading={saving} size="sm">
        {saved ? "Saved" : "Save settings"}
      </Button>
    </form>
  );
}
