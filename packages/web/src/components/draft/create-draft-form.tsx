"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import type { DraftConfig } from "@yugidraft/shared/types";
import { Button } from "@/components/ui/button";
import { parseCustomCardIds } from "@/lib/custom-card-pool";
import { CardPoolGrid } from "@/components/cards/card-pool-grid";
import type { CardSummary } from "@/lib/card-types";
import {
  DraftConfigFields,
  type DraftConfigFieldsValue,
  configFromFields,
  validateFields,
} from "./draft-config-fields";

type Channel = { id: string; name: string };
type DraftTemplate = { id: number; name: string; config: DraftConfig };

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
  const [fields, setFields] = React.useState<DraftConfigFieldsValue>({
    setNames: [],
    customCardText: "",
    cardsPerPlayerText: "40",
    packSizeText: "15",
    pickSecondsText: "45",
  });
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [poolCards, setPoolCards] = React.useState<CardSummary[]>([]);
  const [poolUnknownIds, setPoolUnknownIds] = React.useState<number[]>([]);
  const [poolLoading, setPoolLoading] = React.useState(false);

  const handlePool = React.useCallback(
    (cards: CardSummary[], unknownIds: number[], loading: boolean) => {
      setPoolCards(cards);
      setPoolUnknownIds(unknownIds);
      setPoolLoading(loading);
    },
    [],
  );

  React.useEffect(() => {
    let cancelled = false;
    setChannelsLoading(true);
    fetch("/api/discord/channels")
      .then((res) => res.json())
      .then((data) => { if (!cancelled) setChannels(data.channels ?? []); })
      .catch(() => {})
      .finally(() => { if (!cancelled) setChannelsLoading(false); });
    return () => { cancelled = true; };
  }, []);

  React.useEffect(() => {
    let cancelled = false;
    fetch("/api/draft-templates")
      .then((res) => (res.ok ? res.json() : { templates: [] }))
      .then((data) => { if (!cancelled) setTemplates(data.templates ?? []); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const applyTemplate = (template: DraftTemplate) => {
    const c = template.config;
    setSelectedTemplateName(template.name);
    setTemplateName(template.name);
    setFields((f) => ({
      ...f,
      setNames: c.setNames ?? [],
      customCardText: (c.customCardIds ?? []).join("\n"),
    }));
    setTemplateStatus(`Loaded ${template.name}`);
  };

  const handleTemplateChange = (tName: string) => {
    const t = templates.find((item) => item.name === tName);
    if (t) applyTemplate(t);
  };

  const handleSaveTemplate = async () => {
    setTemplateStatus(null);
    setError(null);
    if (!templateName.trim()) { setError("Template name is required"); return; }
    const poolError = validateFields(fields);
    if (poolError) { setError(poolError); return; }

    const { cardIds: customCardIds } = parseCustomCardIds(fields.customCardText);
    const res = await fetch("/api/draft-templates", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: templateName.trim(), config: { setNames: fields.setNames, customCardIds } }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setError(data.error ?? "Failed to save pool");
      return;
    }
    const data = await res.json();
    const saved = data.template as DraftTemplate;
    setTemplates((cur) =>
      [...cur.filter((item) => item.name !== saved.name), saved].sort((a, b) => a.name.localeCompare(b.name)),
    );
    setSelectedTemplateName(saved.name);
    setTemplateStatus(`Saved ${saved.name}`);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!name.trim()) { setError("Draft name is required"); return; }
    const poolError = validateFields(fields);
    if (poolError) { setError(poolError); return; }

    setSubmitting(true);
    try {
      const res = await fetch("/api/drafts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          channelId: channelId || undefined,
          config: configFromFields(fields),
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? "Failed to create draft");
      }
      const draft = await res.json();
      router.push(draft.webSlug ? `/draft/${draft.webSlug}` : "/drafts");
    } catch (err) {
      setError(err instanceof Error ? err.message : "An error occurred");
    } finally {
      setSubmitting(false);
    }
  };

  const { cardIds } = parseCustomCardIds(fields.customCardText);
  const poolTotal = poolCards.length + poolUnknownIds.length;

  return (
    <form onSubmit={handleSubmit}>
      <div className="grid grid-cols-1 items-start gap-8 xl:grid-cols-[1fr_360px]">
        {/* Left column — form inputs */}
        <div className="space-y-6">
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
                  <option key={ch.id} value={ch.id}>#{ch.name}</option>
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
                <span className="rounded-full border border-border px-2 py-1">{fields.setNames.length} sets</span>
                <span className="rounded-full border border-border px-2 py-1">{cardIds.length} cards</span>
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
                    {templates.map((t) => (
                      <option key={t.id} value={t.name}>{t.name}</option>
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

              <DraftConfigFields
                value={fields}
                onChange={setFields}
                poolBuilderShowPreview={false}
                onPool={handlePool}
              />
            </div>
          </div>

          <Button type="submit" loading={submitting} size="lg" className="w-full">
            Create Draft
          </Button>
        </div>

        {/* Right column — sticky live pool preview */}
        <div className="sticky top-6 hidden xl:block">
          <div className="overflow-hidden rounded-xl border border-border bg-surface/60 shadow-lg shadow-black/20">
            <div className="flex items-center justify-between border-b border-border bg-bg-elevated/40 px-4 py-3">
              <span className="text-xs font-semibold uppercase tracking-widest text-accent-primary">Card Pool</span>
              <span aria-live="polite" className="flex items-center gap-2 text-sm text-text-secondary">
                {poolLoading
                  ? <span className="text-xs text-text-muted">resolving…</span>
                  : <><span className="tabular-nums font-semibold text-text-primary">{poolTotal}</span> card{poolTotal !== 1 ? "s" : ""}</>
                }
              </span>
            </div>
            <div className="p-3">
              <CardPoolGrid
                cards={poolCards}
                unknownIds={poolUnknownIds}
                loading={poolLoading}
                showSummary
                heightClassName="h-[calc(100vh-22rem)]"
                emptyMessage="Add sets or card IDs on the left to preview the pool."
              />
            </div>
          </div>
        </div>
      </div>
    </form>
  );
}
