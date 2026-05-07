"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { SetPicker } from "./set-picker";

type Channel = {
  id: string;
  name: string;
};

export function CreateDraftForm() {
  const router = useRouter();
  const [name, setName] = React.useState("");
  const [channelId, setChannelId] = React.useState("");
  const [channels, setChannels] = React.useState<Channel[]>([]);
  const [channelsLoading, setChannelsLoading] = React.useState(true);
  const [selectedSets, setSelectedSets] = React.useState<string[]>([]);
  const [packSize, setPackSize] = React.useState(8);
  const [packsPerPlayer, setPacksPerPlayer] = React.useState(5);
  const [pickSeconds, setPickSeconds] = React.useState(45);
  const [alternatePass, setAlternatePass] = React.useState(true);
  const [randomizeSeats, setRandomizeSeats] = React.useState(false);
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
      setError("Draft name is required");
      return;
    }
    if (selectedSets.length === 0) {
      setError("Select at least one set");
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch("/api/drafts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          channelId: channelId || undefined,
          config: {
            setNames: selectedSets,
            includeNames: [],
            excludeNames: [],
            packSize,
            packsPerPlayer,
            pickSeconds,
            alternatePassDirection: alternatePass,
            randomizeSeats,
          },
        }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? "Failed to create draft");
      }

      const draft = await res.json();
      if (draft.webSlug) {
        router.push(`/draft/${draft.webSlug}`);
      } else {
        router.push("/drafts");
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
        <label htmlFor="draft-name" className="mb-1 block text-sm font-medium text-text-primary">
          Draft Name
        </label>
        <input
          id="draft-name"
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="My Awesome Draft"
          className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text-primary placeholder:text-text-secondary focus:border-accent-primary focus:outline-none"
          required
        />
      </div>

      <div>
        <label htmlFor="draft-channel" className="mb-1 block text-sm font-medium text-text-primary">
          Channel
        </label>
        <select
          id="draft-channel"
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

      <div>
        <label className="mb-1 block text-sm font-medium text-text-primary">
          Sets <span className="text-text-secondary">(select at least one)</span>
        </label>
        <SetPicker selectedSets={selectedSets} onSetsChange={setSelectedSets} />
      </div>

      <div className="grid grid-cols-3 gap-4">
        <div>
          <label htmlFor="pack-size" className="mb-1 block text-sm font-medium text-text-primary">
            Pack Size
          </label>
          <input
            id="pack-size"
            type="number"
            value={packSize}
            onChange={(e) => setPackSize(Math.max(1, parseInt(e.target.value) || 1))}
            min={1}
            className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text-primary focus:border-accent-primary focus:outline-none"
          />
        </div>
        <div>
          <label htmlFor="packs-per-player" className="mb-1 block text-sm font-medium text-text-primary">
            Packs/Player
          </label>
          <input
            id="packs-per-player"
            type="number"
            value={packsPerPlayer}
            onChange={(e) => setPacksPerPlayer(Math.max(1, parseInt(e.target.value) || 1))}
            min={1}
            className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text-primary focus:border-accent-primary focus:outline-none"
          />
        </div>
        <div>
          <label htmlFor="pick-seconds" className="mb-1 block text-sm font-medium text-text-primary">
            Pick Timer (s)
          </label>
          <input
            id="pick-seconds"
            type="number"
            value={pickSeconds}
            onChange={(e) => setPickSeconds(Math.max(5, parseInt(e.target.value) || 45))}
            min={5}
            className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text-primary focus:border-accent-primary focus:outline-none"
          />
        </div>
      </div>

      <div className="flex gap-6">
        <label className="flex items-center gap-2 text-sm text-text-primary">
          <input
            type="checkbox"
            checked={alternatePass}
            onChange={(e) => setAlternatePass(e.target.checked)}
            className="h-4 w-4 rounded border-border accent-accent-primary"
          />
          Alternate pass direction
        </label>
        <label className="flex items-center gap-2 text-sm text-text-primary">
          <input
            type="checkbox"
            checked={randomizeSeats}
            onChange={(e) => setRandomizeSeats(e.target.checked)}
            className="h-4 w-4 rounded border-border accent-accent-primary"
          />
          Randomize seats
        </label>
      </div>

      <Button type="submit" loading={submitting} size="lg" className="w-full">
        Create Draft
      </Button>
    </form>
  );
}
