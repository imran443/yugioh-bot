"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import type { DraftConfig } from "@yugidraft/shared/types";
import { Button } from "@/components/ui/button";

type Channel = { id: string; name: string };

export function CreateThemeDraftForm() {
  const router = useRouter();
  const [name, setName] = React.useState("");
  const [channelId, setChannelId] = React.useState("");
  const [channels, setChannels] = React.useState<Channel[]>([]);
  const [themePackSize, setThemePackSize] = React.useState(3);
  const [cardsPerPlayer, setCardsPerPlayer] = React.useState(40);
  const [extraDeckEnabled, setExtraDeckEnabled] = React.useState(true);
  const [extraDeckSize, setExtraDeckSize] = React.useState(15);
  const [burnUnpicked, setBurnUnpicked] = React.useState(false);
  const [uniqueThemes, setUniqueThemes] = React.useState(true);
  const [themeSelection, setThemeSelection] = React.useState<"player_pick" | "random" | "host_assigned">("player_pick");
  const [pickSeconds, setPickSeconds] = React.useState(45);
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    fetch("/api/discord/channels")
      .then((res) => res.json())
      .then((data) => setChannels(data.channels ?? []))
      .catch(() => {});
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!name.trim()) {
      setError("Draft name is required");
      return;
    }
    const config: DraftConfig = {
      mode: "theme",
      allowedCubeIds: [],
      themePackSize,
      cardsPerPlayer,
      extraDeckEnabled,
      extraDeckSize,
      burnUnpicked,
      uniqueThemes,
      themeSelection,
      pickSeconds,
    };
    setSubmitting(true);
    try {
      const res = await fetch("/api/drafts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), channelId: channelId || undefined, config }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? "Failed to create theme draft");
      }
      const draft = await res.json();
      // Land in the draft, where you build its theme cubes.
      router.push(draft.webSlug ? `/draft/${draft.webSlug}` : "/drafts");
    } catch (err) {
      setError(err instanceof Error ? err.message : "An error occurred");
    } finally {
      setSubmitting(false);
    }
  };

  const inputCls =
    "w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text-primary focus:border-accent-primary focus:outline-none";

  return (
    <form onSubmit={handleSubmit} className="max-w-2xl space-y-6">
      {error && (
        <div className="rounded-lg border border-accent-cta/50 bg-accent-cta/10 px-4 py-2 text-sm text-accent-cta">{error}</div>
      )}

      <p className="rounded-lg border border-border bg-surface/60 px-4 py-3 text-sm text-text-secondary">
        Set up the draft here, then add your theme cubes (one per archetype) inside the draft on the next screen.
      </p>

      <div>
        <label htmlFor="theme-draft-name" className="mb-1 block text-sm font-medium text-text-primary">Draft Name</label>
        <input id="theme-draft-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Friday Theme Night" className={inputCls} required />
      </div>

      <div>
        <label htmlFor="theme-draft-channel" className="mb-1 block text-sm font-medium text-text-primary">Channel</label>
        <select id="theme-draft-channel" value={channelId} onChange={(e) => setChannelId(e.target.value)} className={`native-select ${inputCls}`}>
          <option value="">Default Channel</option>
          {channels.map((ch) => <option key={ch.id} value={ch.id}>#{ch.name}</option>)}
        </select>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <label className="text-sm text-text-primary">
          Choices per pick
          <input type="number" min={2} value={themePackSize} onChange={(e) => setThemePackSize(Number(e.target.value))} className={`mt-1 ${inputCls}`} />
        </label>
        <label className="text-sm text-text-primary">
          Main deck size
          <input type="number" min={20} value={cardsPerPlayer} onChange={(e) => setCardsPerPlayer(Number(e.target.value))} className={`mt-1 ${inputCls}`} />
        </label>
        <label className="text-sm text-text-primary">
          Pick seconds
          <input type="number" min={5} value={pickSeconds} onChange={(e) => setPickSeconds(Number(e.target.value))} className={`mt-1 ${inputCls}`} />
        </label>
        <label className="text-sm text-text-primary">
          Theme selection
          <select value={themeSelection} onChange={(e) => setThemeSelection(e.target.value as typeof themeSelection)} className={`native-select mt-1 ${inputCls}`}>
            <option value="player_pick">Players pick</option>
            <option value="random">Random</option>
            <option value="host_assigned">Host assigned</option>
          </select>
        </label>
      </div>

      <div className="space-y-3">
        <label className="flex items-center gap-2 text-sm text-text-primary">
          <input type="checkbox" checked={extraDeckEnabled} onChange={(e) => setExtraDeckEnabled(e.target.checked)} />
          Draft an Extra Deck phase
        </label>
        {extraDeckEnabled && (
          <label className="block text-sm text-text-primary">
            Extra Deck size
            <input type="number" min={1} value={extraDeckSize} onChange={(e) => setExtraDeckSize(Number(e.target.value))} className={`mt-1 ${inputCls}`} />
          </label>
        )}
        <label className="flex items-center gap-2 text-sm text-text-primary">
          <input type="checkbox" checked={burnUnpicked} onChange={(e) => setBurnUnpicked(e.target.checked)} />
          Burn unpicked choices (discard instead of returning to the pool)
        </label>
        <label className="flex items-center gap-2 text-sm text-text-primary">
          <input type="checkbox" checked={uniqueThemes} onChange={(e) => setUniqueThemes(e.target.checked)} />
          Every player gets a distinct theme
        </label>
      </div>

      <Button type="submit" loading={submitting} size="lg" className="w-full">Create Theme Draft</Button>
    </form>
  );
}
