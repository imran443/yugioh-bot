"use client";

import * as React from "react";
import { Clock, Layers, Package, Pencil, User, Users, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DraftConfigFields,
  type DraftConfigFieldsValue,
  configFromFields,
  validateFields,
  fieldsFromConfig,
} from "./draft-config-fields";
import { CardPoolGrid } from "@/components/cards/card-pool-grid";
import type { CardSummary } from "@/lib/card-types";

interface DraftManageViewProps {
  draft: {
    id: number;
    name: string;
    status: string;
    createdByUserId: string;
    createdAt: string;
    config: {
      packSize?: number;
      packsPerPlayer?: number;
      pickSeconds?: number;
      setNames?: string[];
      customCardIds?: number[];
      alternatePassDirection?: boolean;
      randomizeSeats?: boolean;
    };
    players: Array<{
      playerId: number;
      displayName: string;
      seatIndex?: number;
      pickCount: number;
      finishedAt?: string;
      joinedAt: string;
    }>;
    playerCount: number;
  };
  isCreator: boolean;
  isParticipant: boolean;
  onStart: () => Promise<void>;
  onCancel: () => Promise<void>;
  onUpdate: (data: { name?: string; config?: unknown }) => Promise<void>;
  onJoin: () => Promise<void>;
  onAddBot?: () => Promise<void>;
  isDev?: boolean;
  slug?: string;
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function DraftManageView({
  draft,
  isCreator,
  isParticipant,
  onStart,
  onCancel,
  onUpdate,
  onJoin,
  onAddBot,
  isDev,
  slug,
}: DraftManageViewProps) {
  const [editing, setEditing] = React.useState(false);
  const [nameValue, setNameValue] = React.useState(draft.name);
  const [saving, setSaving] = React.useState(false);
  const [starting, setStarting] = React.useState(false);
  const [cancelling, setCancelling] = React.useState(false);
  const [joining, setJoining] = React.useState(false);
  const [addingBot, setAddingBot] = React.useState(false);
  const [showCancelConfirm, setShowCancelConfirm] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  // Card pool
  const [poolCards, setPoolCards] = React.useState<CardSummary[] | null>(null);
  const [poolError, setPoolError] = React.useState(false);
  const loadPool = React.useCallback(() => {
    if (!slug) return;
    setPoolCards(null);
    setPoolError(false);
    fetch(`/api/drafts/${slug}/pool`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((data: { cards: CardSummary[] }) => setPoolCards(data.cards))
      .catch(() => setPoolError(true));
  }, [slug]);
  React.useEffect(() => { loadPool(); }, [loadPool]);
  const onUpdateWithPoolRefresh = React.useCallback(async (data: { name?: string; config?: unknown }) => {
    await onUpdate(data);
    if (data.config !== undefined) loadPool();
  }, [onUpdate, loadPool]);

  // Config edit mode
  const [isEditingConfig, setIsEditingConfig] = React.useState(false);
  const [editFields, setEditFields] = React.useState<DraftConfigFieldsValue>(() =>
    fieldsFromConfig(draft.config, draft.config.customCardIds),
  );
  const [editError, setEditError] = React.useState<string | null>(null);
  const [configSaving, setConfigSaving] = React.useState(false);

  const handleSaveName = async () => {
    const trimmed = nameValue.trim();
    if (!trimmed) return;
    setSaving(true);
    setError(null);
    try {
      await onUpdateWithPoolRefresh({ name: trimmed });
      setEditing(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update name");
    } finally {
      setSaving(false);
    }
  };

  const handleStart = async () => {
    setStarting(true);
    setError(null);
    try {
      await onStart();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start draft");
    } finally {
      setStarting(false);
    }
  };

  const handleCancel = async () => {
    setCancelling(true);
    setError(null);
    try {
      await onCancel();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to cancel draft");
    } finally {
      setCancelling(false);
      setShowCancelConfirm(false);
    }
  };

  const handleJoin = async () => {
    setJoining(true);
    setError(null);
    try {
      await onJoin();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to join draft");
    } finally {
      setJoining(false);
    }
  };

  const handleAddBot = async () => {
    if (!onAddBot) return;
    setAddingBot(true);
    setError(null);
    try {
      await onAddBot();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add bot");
    } finally {
      setAddingBot(false);
    }
  };

  const handleStartEditConfig = () => {
    setEditFields(fieldsFromConfig(draft.config, draft.config.customCardIds));
    setEditError(null);
    setIsEditingConfig(true);
  };

  const handleCancelEditConfig = () => {
    setIsEditingConfig(false);
    setEditFields(fieldsFromConfig(draft.config, draft.config.customCardIds));
    setEditError(null);
  };

  const handleSaveConfig = async () => {
    setEditError(null);
    const err = validateFields(editFields);
    if (err) { setEditError(err); return; }

    setConfigSaving(true);
    try {
      await onUpdateWithPoolRefresh({ config: configFromFields(editFields) });
      setIsEditingConfig(false);
    } catch (err) {
      setEditError(err instanceof Error ? err.message : "Failed to save configuration");
    } finally {
      setConfigSaving(false);
    }
  };

  function getActionSection() {
    if (isCreator) {
      return (
        <div className="flex flex-col gap-3 rounded-xl border border-border bg-surface p-6 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="font-semibold text-text-primary">Ready to begin?</p>
            <p className="text-sm text-text-secondary">
              Start the draft once all players have joined.
            </p>
          </div>
          <div className="flex gap-3">
            {showCancelConfirm ? (
              <>
                <span className="flex items-center text-sm text-text-secondary">
                  Are you sure?
                </span>
                <Button
                  variant="danger"
                  size="sm"
                  loading={cancelling}
                  onClick={handleCancel}
                >
                  Yes, Cancel
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setShowCancelConfirm(false)}
                >
                  No, Go Back
                </Button>
              </>
            ) : (
              <>
                <Button
                  variant="primary"
                  loading={starting}
                  onClick={handleStart}
                >
                  Start Draft
                </Button>
                {isDev && onAddBot && (
                  <Button
                    variant="secondary"
                    size="sm"
                    loading={addingBot}
                    onClick={handleAddBot}
                  >
                    Add Bot
                  </Button>
                )}
                <Button
                  variant="secondary"
                  onClick={() => setShowCancelConfirm(true)}
                >
                  Cancel Draft
                </Button>
              </>
            )}
          </div>
        </div>
      );
    }

    if (isParticipant) {
      return (
        <div className="rounded-xl border border-border bg-surface p-6 text-center">
          <p className="text-text-secondary">
            You have joined this draft. Waiting for the creator to start.
          </p>
        </div>
      );
    }

    return (
      <div className="flex flex-col gap-3 rounded-xl border border-border bg-surface p-6 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="font-semibold text-text-primary">Want to play?</p>
          <p className="text-sm text-text-secondary">
            Join this draft to participate when it starts.
          </p>
        </div>
        <Button
          variant="primary"
          loading={joining}
          onClick={handleJoin}
        >
          Join Draft
        </Button>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      {error && (
        <div className="rounded-lg border border-accent-cta/50 bg-accent-cta/10 px-4 py-2 text-sm text-accent-cta">
          {error}
        </div>
      )}

      <div className="rounded-xl border border-border bg-surface p-6">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            {editing && isCreator ? (
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={nameValue}
                  onChange={(e) => setNameValue(e.target.value)}
                  className="w-full rounded-lg border border-border bg-bg-deep px-3 py-1.5 text-lg font-semibold text-text-primary focus:border-accent-primary focus:outline-none"
                  autoFocus
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleSaveName();
                    if (e.key === "Escape") {
                      setNameValue(draft.name);
                      setEditing(false);
                    }
                  }}
                />
                <Button
                  variant="primary"
                  size="sm"
                  loading={saving}
                  onClick={handleSaveName}
                >
                  Save
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setNameValue(draft.name);
                    setEditing(false);
                  }}
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>
            ) : (
              <h1
                className="font-display text-xl text-text-primary sm:text-2xl"
                onClick={() => isCreator && setEditing(true)}
                role={isCreator ? "button" : undefined}
                tabIndex={isCreator ? 0 : undefined}
                onKeyDown={
                  isCreator
                    ? (e) => {
                        if (e.key === "Enter") setEditing(true);
                      }
                    : undefined
                }
                style={isCreator ? { cursor: "text" } : undefined}
              >
                {draft.name}
              </h1>
            )}
            <div className="mt-2 flex items-center gap-3">
              <Badge variant="warning">Pending</Badge>
              <span className="flex items-center gap-1 text-sm text-text-secondary">
                <Clock className="h-3.5 w-3.5" />
                {formatDate(draft.createdAt)}
              </span>
            </div>
          </div>
        </div>
      </div>

      <div className="rounded-xl border border-border bg-surface p-6">
        <h2 className="mb-4 font-display text-lg text-text-primary">
          <Users className="mr-2 inline h-5 w-5 text-accent-primary" />
          Players ({draft.playerCount})
        </h2>
        {draft.players.length === 0 ? (
          <p className="text-sm text-text-secondary">No players have joined yet.</p>
        ) : (
          <ul className="flex flex-col gap-2" role="list">
            {draft.players.map((player) => (
              <li
                key={player.playerId}
                className="flex items-center gap-3 rounded-lg border border-border bg-bg-elevated/50 p-3"
              >
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-bg-elevated text-text-secondary">
                  <User className="h-4 w-4" />
                </div>
                <div className="min-w-0 flex-1">
                  <span className="text-sm font-semibold text-text-primary">
                    {player.displayName}
                  </span>
                  {player.seatIndex !== undefined && player.seatIndex !== null && (
                    <span className="ml-2 text-xs text-text-muted">
                      Seat {player.seatIndex + 1}
                    </span>
                  )}
                </div>
                <span className="shrink-0 text-xs text-text-muted">
                  {formatDate(player.joinedAt)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="rounded-xl border border-border bg-surface p-6">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="font-display text-lg text-text-primary">
            <Layers className="mr-2 inline h-5 w-5 text-accent-primary" />
            Configuration
          </h2>
          {isCreator && !isEditingConfig && (
            <Button variant="secondary" size="sm" onClick={handleStartEditConfig}>
              <Pencil className="mr-1.5 h-3.5 w-3.5" />
              Edit Configuration
            </Button>
          )}
        </div>

        {isEditingConfig ? (
          <div className="space-y-5">
            {editError && (
              <div className="rounded-lg border border-accent-cta/50 bg-accent-cta/10 px-4 py-2 text-sm text-accent-cta">
                {editError}
              </div>
            )}
            <DraftConfigFields value={editFields} onChange={setEditFields} />
            <div className="flex gap-3">
              <Button variant="primary" size="sm" loading={configSaving} onClick={handleSaveConfig}>
                Save Configuration
              </Button>
              <Button variant="ghost" size="sm" onClick={handleCancelEditConfig} disabled={configSaving}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <>
            <div className="grid gap-4 sm:grid-cols-3">
                <div className="rounded-lg border border-border bg-bg-elevated/50 p-3">
                  <span className="block text-xs text-text-muted">
                    <Package className="mr-1 inline h-3.5 w-3.5" />
                    Cards/Player
                  </span>
                  <span className="mt-1 block text-lg font-semibold text-text-primary">
                    {draft.config.cardsPerPlayer ?? 40}
                  </span>
                </div>
                <div className="rounded-lg border border-border bg-bg-elevated/50 p-3">
                  <span className="block text-xs text-text-muted">
                    <Package className="mr-1 inline h-3.5 w-3.5" />
                    Cards/Pack
                  </span>
                  <span className="mt-1 block text-lg font-semibold text-text-primary">
                    {draft.config.packSize ?? "—"}
                  </span>
                </div>
                <div className="rounded-lg border border-border bg-bg-elevated/50 p-3">
                  <span className="block text-xs text-text-muted">
                    <Clock className="mr-1 inline h-3.5 w-3.5" />
                    Pick Timer
                  </span>
                  <span className="mt-1 block text-lg font-semibold text-text-primary">
                    {draft.config.pickSeconds ? `${draft.config.pickSeconds}s` : "—"}
                  </span>
                </div>
              </div>
            {draft.config.setNames && draft.config.setNames.length > 0 && (
              <div className="mt-4">
                <span className="mb-2 block text-xs text-text-muted">Sets</span>
                <div className="flex flex-wrap gap-2">
                  {draft.config.setNames.map((setName) => (
                    <span
                      key={setName}
                      className="rounded-lg border border-border bg-bg-elevated/50 px-2.5 py-1 text-sm text-text-secondary"
                    >
                      {setName}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {slug && (
        <div className="rounded-xl border border-border bg-surface p-6">
          <h2 className="mb-4 font-display text-lg text-text-primary">
            <Layers className="mr-2 inline h-5 w-5 text-accent-primary" aria-hidden="true" />
            Card Pool {poolCards ? <span className="tabular-nums">({poolCards.length} card{poolCards.length === 1 ? "" : "s"})</span> : null}
          </h2>
          {poolError ? (
            <div className="flex items-center justify-between rounded-lg border border-accent-cta/40 bg-accent-cta/10 px-4 py-2 text-sm text-accent-cta">
              <span>Couldn&apos;t load the pool.</span>
              <Button variant="ghost" size="sm" onClick={loadPool}>Retry</Button>
            </div>
          ) : (
            <CardPoolGrid
              cards={poolCards ?? []}
              loading={poolCards === null}
              heightClassName="h-[32rem]"
              emptyMessage="This draft's pool hasn't been resolved yet."
            />
          )}
        </div>
      )}

      {getActionSection()}
    </div>
  );
}