"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import type { DraftConfig } from "@yugidraft/shared/types";
import { Button } from "@/components/ui/button";
import { parseCustomCardIds } from "@/lib/custom-card-pool";
import { SetPicker } from "./set-picker";

type Channel = {
  id: string;
  name: string;
};

type DraftTemplate = {
  id: number;
  name: string;
  config: DraftConfig;
};

export function CreateDraftForm() {
  const router = useRouter();
  const [name, setName] = React.useState("");
  const [channelId, setChannelId] = React.useState("");
  const [channels, setChannels] = React.useState<Channel[]>([]);
  const [channelsLoading, setChannelsLoading] = React.useState(true);
  const [templates, setTemplates] = React.useState<DraftTemplate[]>([]);
  const [selectedTemplateName, setSelectedTemplateName] = React.useState("");
  const [templateName, setTemplateName] = React.useState("");
  const [templateStatus, setTemplateStatus] = React.useState<string | null>(null);
  const [selectedSets, setSelectedSets] = React.useState<string[]>([]);
  const [customCardText, setCustomCardText] = React.useState("");
  const [packSize, setPackSize] = React.useState(8);
  const [packsPerPlayer, setPacksPerPlayer] = React.useState(5);
  const [pickSeconds, setPickSeconds] = React.useState(45);
  const [alternatePass, setAlternatePass] = React.useState(true);
  const [randomizeSeats, setRandomizeSeats] = React.useState(false);
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const customCardParse = parseCustomCardIds(customCardText);

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

  React.useEffect(() => {
    let cancelled = false;
    fetch("/api/draft-templates")
      .then((res) => (res.ok ? res.json() : { templates: [] }))
      .then((data) => {
        if (!cancelled) setTemplates(data.templates ?? []);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const buildConfig = (): DraftConfig => ({
    setNames: selectedSets,
    customCardIds: customCardParse.cardIds,
    includeNames: [],
    excludeNames: [],
    packSize,
    packsPerPlayer,
    pickSeconds,
    alternatePassDirection: alternatePass,
    randomizeSeats,
  });

  const validatePool = () => {
    if (selectedSets.length === 0 && customCardParse.cardIds.length === 0) {
      return "Select at least one set or paste custom card IDs";
    }
    if (customCardParse.errors.length > 0) {
      return `Remove invalid card IDs: ${customCardParse.errors.slice(0, 3).join(", ")}`;
    }

    return null;
  };

  const applyTemplate = (template: DraftTemplate) => {
    const config = template.config;
    setSelectedTemplateName(template.name);
    setTemplateName(template.name);
    setSelectedSets(config.setNames ?? []);
    setCustomCardText((config.customCardIds ?? []).join("\n"));
    setPackSize(config.packSize ?? 8);
    setPacksPerPlayer(config.packsPerPlayer ?? 5);
    setPickSeconds(config.pickSeconds ?? 45);
    setAlternatePass(config.alternatePassDirection ?? true);
    setRandomizeSeats(config.randomizeSeats ?? false);
    setTemplateStatus(`Loaded ${template.name}`);
  };

  const handleTemplateChange = (templateName: string) => {
    const template = templates.find((item) => item.name === templateName);
    if (template) applyTemplate(template);
  };

  const handleSaveTemplate = async () => {
    setTemplateStatus(null);
    setError(null);

    if (!templateName.trim()) {
      setError("Template name is required");
      return;
    }
    const poolError = validatePool();
    if (poolError) {
      setError(poolError);
      return;
    }

    const res = await fetch("/api/draft-templates", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: templateName.trim(), config: buildConfig() }),
    });

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setError(data.error ?? "Failed to save pool");
      return;
    }

    const data = await res.json();
    const saved = data.template as DraftTemplate;
    setTemplates((current) =>
      [...current.filter((item) => item.name !== saved.name), saved].sort((a, b) => a.name.localeCompare(b.name)),
    );
    setSelectedTemplateName(saved.name);
    setTemplateStatus(`Saved ${saved.name}`);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!name.trim()) {
      setError("Draft name is required");
      return;
    }
    const poolError = validatePool();
    if (poolError) {
      setError(poolError);
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
          config: buildConfig(),
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

      <div className="rounded-xl border border-border bg-surface/60 p-4">
        <div className="mb-4 flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h2 className="text-sm font-semibold uppercase tracking-[0.18em] text-text-primary">Pool Source</h2>
            <p className="mt-1 text-sm text-text-secondary">Combine synced sets with exact passcodes for a server-ready cube.</p>
          </div>
          <div className="flex gap-2 text-xs text-text-secondary">
            <span className="rounded-full border border-border px-2 py-1">{selectedSets.length} sets</span>
            <span className="rounded-full border border-border px-2 py-1">{customCardParse.cardIds.length} cards</span>
          </div>
        </div>

        <div className="space-y-4">
          <div className="grid gap-3 rounded-lg border border-border bg-bg-elevated/50 p-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
            <div>
              <label htmlFor="saved-pool" className="mb-1 block text-sm font-medium text-text-primary">
                Saved Pool
              </label>
              <select
                id="saved-pool"
                value={selectedTemplateName}
                onChange={(e) => handleTemplateChange(e.target.value)}
                className="native-select w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text-primary focus:border-accent-primary focus:outline-none"
              >
                <option value="">Choose a saved pool</option>
                {templates.map((template) => (
                  <option key={template.id} value={template.name}>
                    {template.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="template-name" className="mb-1 block text-sm font-medium text-text-primary">
                Template Name
              </label>
              <input
                id="template-name"
                type="text"
                value={templateName}
                onChange={(e) => setTemplateName(e.target.value)}
                placeholder="Goat Cube"
                className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text-primary placeholder:text-text-secondary focus:border-accent-primary focus:outline-none"
              />
            </div>
            <button
              type="button"
              onClick={handleSaveTemplate}
              className="rounded-lg border border-accent-primary/60 bg-accent-primary/10 px-4 py-2 text-sm font-semibold text-accent-primary hover:bg-accent-primary/20"
            >
              Save Pool
            </button>
            {templateStatus && <p className="text-xs text-accent-primary sm:col-span-3">{templateStatus}</p>}
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium text-text-primary">Sets</label>
            <SetPicker selectedSets={selectedSets} onSetsChange={setSelectedSets} />
          </div>

          <div>
            <label htmlFor="custom-card-ids" className="mb-1 block text-sm font-medium text-text-primary">
              Custom Card IDs
            </label>
            <textarea
              id="custom-card-ids"
              value={customCardText}
              onChange={(e) => setCustomCardText(e.target.value)}
              placeholder="46986414\n83764718, 12345678"
              rows={4}
              className="w-full resize-y rounded-lg border border-border bg-bg-elevated px-3 py-2 font-mono text-sm text-text-primary placeholder:text-text-secondary focus:border-accent-primary focus:outline-none"
            />
            <div className="mt-2 flex flex-col gap-1 text-xs sm:flex-row sm:items-center sm:justify-between">
              <p className="text-text-secondary">Paste YGOPRODeck passcodes separated by new lines, commas, or spaces.</p>
              {customCardParse.errors.length > 0 && (
                <p className="text-accent-cta">Invalid: {customCardParse.errors.slice(0, 3).join(", ")}</p>
              )}
            </div>
          </div>
        </div>
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
