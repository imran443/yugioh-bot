"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";

type Channel = {
  id: string;
  name: string;
};

export function CreateTournamentForm() {
  const router = useRouter();
  const [name, setName] = React.useState("");
  const [format, setFormat] = React.useState<"round_robin" | "single_elim">("round_robin");
  const [channelId, setChannelId] = React.useState("");
  const [channels, setChannels] = React.useState<Channel[]>([]);
  const [channelsLoading, setChannelsLoading] = React.useState(true);
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    setChannelsLoading(true);
    fetch("/api/discord/channels")
      .then((res) => res.json())
      .then((data) => {
        if (!cancelled) setChannels(data.channels ?? []);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setChannelsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!name.trim()) {
      setError("Tournament name is required");
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch("/api/tournaments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), format }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? "Failed to create tournament");
      }

      const tournament = await res.json();
      if (tournament.webSlug) {
        router.push(`/tournament/${tournament.webSlug}`);
      } else {
        router.push("/tournaments");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "An error occurred");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      {error && (
        <div className="rounded-lg border border-accent-cta/50 bg-accent-cta/10 px-4 py-2 text-sm text-accent-cta">
          {error}
        </div>
      )}

      <div>
        <label htmlFor="tournament-name" className="mb-1 block text-sm font-medium text-text-primary">
          Tournament Name
        </label>
        <input
          id="tournament-name"
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="My Tournament"
          className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text-primary placeholder:text-text-secondary focus:border-accent-primary focus:outline-none"
          required
        />
      </div>

      <div>
        <label htmlFor="tournament-format" className="mb-1 block text-sm font-medium text-text-primary">
          Format
        </label>
        <select
          id="tournament-format"
          value={format}
          onChange={(e) => setFormat(e.target.value as "round_robin" | "single_elim")}
          className="native-select w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text-primary focus:border-accent-primary focus:outline-none"
        >
          <option value="round_robin">Round Robin</option>
          <option value="single_elim">Single Elimination</option>
        </select>
      </div>

      <div>
        <label htmlFor="tournament-channel" className="mb-1 block text-sm font-medium text-text-primary">
          Channel
        </label>
        <select
          id="tournament-channel"
          value={channelId}
          onChange={(e) => setChannelId(e.target.value)}
          className="native-select w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text-primary focus:border-accent-primary focus:outline-none"
        >
          <option value="">Default Channel</option>
          {channelsLoading ? (
            <option disabled>Loading channels...</option>
          ) : (
            channels.map((ch) => (
              <option key={ch.id} value={ch.id}>
                #{ch.name}
              </option>
            ))
          )}
        </select>
      </div>

      <Button type="submit" loading={submitting} size="lg" className="w-full">
        Create Tournament
      </Button>
    </form>
  );
}
