"use client";

import { useEffect, useState, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import { DraftManageView } from "@/components/draft/draft-manage-view";
import { DraftSummaryView } from "@/components/draft/draft-summary-view";
import { CardGrid } from "@/components/draft/card-grid";
import { DraftCardPreview } from "@/components/draft/draft-card-preview";
import { TimerBar } from "@/components/draft/timer-bar";
import { SeatList } from "@/components/draft/seat-list";
import { PoolPanel } from "@/components/draft/pool-panel";
import { ThemeLobbyPanel } from "@/components/themes/theme-lobby-panel";
import { ThemeDraftBuilder } from "@/components/themes/theme-draft-builder";
import { useDraftStore } from "@/lib/stores/draft-store";
import { useDraftWebsocket } from "@/lib/hooks/use-draft-websocket";
import { useDraftCountdown } from "@/lib/hooks/use-draft-countdown";
import { useDraftExpiryResync } from "@/lib/hooks/use-draft-expiry-resync";
import { usePoolImagePrefetch } from "@/lib/hooks/use-pool-image-prefetch";

const DRAFT_STATUS = {
  active: "active",
  completed: "completed",
} as const;

interface DraftPlayer {
  playerId: number;
  displayName: string;
  seatIndex?: number;
  pickCount: number;
  finishedAt?: string;
  joinedAt: string;
}

interface DraftData {
  id: number;
  name: string;
  status: string;
  createdByUserId: string;
  createdAt: string;
  startedAt?: string;
  endedAt?: string;
  currentPackRound?: number;
  currentPickStep?: number;
  config: {
    packSize?: number;
    packsPerPlayer?: number;
    cardsPerPlayer?: number;
    pickSeconds?: number;
    setNames?: string[];
    customCardIds?: number[];
    mode?: "booster" | "theme";
    themeSelection?: "host_assigned" | "random" | "player_pick";
    uniqueThemes?: boolean;
    extraDeckEnabled?: boolean;
    extraDeckSize?: number;
  };
  phase?: "main" | "extra";
  themeProgress?: { main: number; mainTotal: number; extra: number; extraTotal: number };
  allowedThemes?: Array<{
    id: number;
    name: string;
    archetype: string | null;
    mainCount: number;
    extraCount: number;
    sampleImages: string[];
  }>;
  players: DraftPlayer[];
  playerCount: number;
  participantPickCount?: number;
  tournamentId?: number | null;
  isParticipant: boolean;
  currentPack?: Array<{
    id: number;
    name: string;
    type: string;
    frameType: string;
    attribute?: string;
    level?: number;
    effectText: string;
    atk?: number;
    def?: number;
    imageUrl: string;
    imageUrlSmall: string;
  }>;
  myPool?: Array<{
    id: number;
    name: string;
    type: string;
    frameType: string;
    attribute?: string;
    level?: number;
    effectText: string;
    atk?: number;
    def?: number;
    imageUrl: string;
    imageUrlSmall: string;
  }>;
  seats?: Array<{
    seatIndex: number;
    playerId: number;
    displayName: string;
    hasPicked: boolean;
    isCurrentPlayer: boolean;
  }>;
  packRound?: number;
  pickStep?: number;
  timerSeconds?: number;
  isMyTurn?: boolean;
  completed?: boolean;
  pickSeconds?: number;
}

export default function DraftDetailPage() {
  const params = useParams();
  const router = useRouter();
  const slug = typeof params.slug === "string" ? params.slug : "";

  const [draft, setDraft] = useState<DraftData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);

  const setFromServer = useDraftStore((s) => s.setFromServer);
  const storeCompleted = useDraftStore((s) => s.completed);
  // Live drafted count (updates optimistically on each pick), so the theme phase
  // indicator stays in lock-step with the Your Pool / DRAFTED counters.
  const draftedCount = useDraftStore((s) => s.myPool.length);

  const fetchDraft = useCallback(async () => {
    try {
      const res = await fetch(`/api/drafts/${slug}`);
      if (!res.ok) {
        if (res.status === 404) throw new Error("Draft not found");
        if (res.status === 401) {
          router.push("/login");
          return;
        }
        throw new Error("Failed to load draft");
      }
      const data = await res.json();
      if (data.status === DRAFT_STATUS.active) {
        setFromServer({
          slug,
          packRound: data.packRound ?? data.currentPackRound ?? 1,
          pickStep: data.pickStep ?? data.currentPickStep ?? 1,
          currentPack: data.currentPack ?? [],
          myPool: data.myPool ?? [],
          seats: data.seats ?? [],
          timerSeconds: data.timerSeconds ?? 0,
          isMyTurn: data.isMyTurn ?? false,
          completed: data.completed ?? false,
          pickSeconds: data.pickSeconds ?? data.config?.pickSeconds ?? 60,
        });
      }
      setDraft(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load draft");
    } finally {
      setLoading(false);
    }
  }, [setFromServer, slug, router]);

  useDraftWebsocket(slug, {
    onStatusChange: (status) => {
      if (status === DRAFT_STATUS.completed) return;
      void fetchDraft();
    },
    onResync: () => {
      void fetchDraft();
    },
    onSeatsChange: () => {
      void fetchDraft();
    },
  });
  useDraftCountdown();
  useDraftExpiryResync(slug);
  usePoolImagePrefetch(slug, draft?.status === "active");

  useEffect(() => {
    fetch("/api/auth/session")
      .then((r) => r.json())
      .then((s) => {
        if (s?.user?.id) setCurrentUserId(s.user.id);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    fetchDraft();
  }, [fetchDraft]);

  useEffect(() => {
    if (storeCompleted && draft?.status === DRAFT_STATUS.active) {
      void fetchDraft();
    }
  }, [storeCompleted, draft?.status, fetchDraft]);

  const handleStart = async () => {
    const res = await fetch(`/api/drafts/${slug}`, { method: "POST" });
    if (!res.ok) {
      const body = await res.json();
      throw new Error(body.error ?? "Failed to start draft");
    }
    await fetchDraft();
    router.refresh();
  };

  const handleCancel = async () => {
    const res = await fetch(`/api/drafts/${slug}`, { method: "DELETE" });
    if (!res.ok) {
      const body = await res.json();
      throw new Error(body.error ?? "Failed to cancel draft");
    }
    await fetchDraft();
  };

  const handleUpdate = async (data: { name?: string; config?: unknown }) => {
    const res = await fetch(`/api/drafts/${slug}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    if (!res.ok) {
      const body = await res.json();
      throw new Error(body.error ?? "Failed to update draft");
    }
    await fetchDraft();
  };

  const handleDelete = async () => {
    const res = await fetch(`/api/drafts/${slug}`, { method: "DELETE" });
    if (!res.ok) {
      const body = await res.json();
      throw new Error(body.error ?? "Failed to delete draft");
    }
    router.push("/drafts");
  };

  const handleExportYdk = async (): Promise<string> => {
    const res = await fetch(`/api/drafts/${slug}/export`);
    if (!res.ok) throw new Error("Failed to export deck");
    return res.text();
  };

  if (loading) {
    return (
      <div>
        <div className="mx-auto max-w-4xl p-6">
          <div className="flex items-center justify-center py-20">
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-accent-primary border-t-transparent" />
          </div>
        </div>
      </div>
    );
  }

  if (error || !draft) {
    return (
      <div>
        <div className="mx-auto max-w-4xl p-6">
          <div className="rounded-lg border border-accent-cta/20 bg-accent-cta/10 p-6 text-accent-cta">
            {error ?? "Draft not found"}
          </div>
        </div>
      </div>
    );
  }

  const isCreator = currentUserId === draft.createdByUserId;
  const isParticipant = draft.isParticipant;
  const totalDraftCards =
    (draft.config.cardsPerPlayer ?? 40) +
    (draft.config.mode === "theme" && (draft.config.extraDeckEnabled ?? true)
      ? draft.config.extraDeckSize ?? 15
      : 0);

  const handleJoin = async () => {
    const res = await fetch(`/api/drafts/${slug}/join`, { method: "POST" });
    if (!res.ok) {
      const body = await res.json();
      throw new Error(body.error ?? "Failed to join draft");
    }
    await fetchDraft();
  };

  const handleAddBot = async () => {
    const res = await fetch(`/api/drafts/${slug}/join-bot`, { method: "POST" });
    if (!res.ok) {
      const body = await res.json();
      throw new Error(body.error ?? "Failed to add bot");
    }
    await fetchDraft();
  };

  const isThemeDraft = draft.config.mode === "theme";
  // Live phase, derived from the optimistic drafted count so labels + progress
  // update the instant a pick lands (not only on the next full fetch).
  const themeMainTotal = draft.config.cardsPerPlayer ?? 40;
  const themeExtraTotal = (draft.config.extraDeckEnabled ?? true) ? draft.config.extraDeckSize ?? 15 : 0;
  const themeInExtra = isThemeDraft && draftedCount >= themeMainTotal && themeExtraTotal > 0;

  if (draft.status === "pending") {
    return (
      <div>
        {isThemeDraft && (
          <div className="mx-auto max-w-[1800px] px-4 pt-4 sm:px-6 lg:px-8">
            {isCreator ? (
              <ThemeDraftBuilder
                slug={slug}
                allowedThemes={draft.allowedThemes ?? []}
                uniqueThemes={draft.config.uniqueThemes ?? true}
                onChanged={() => void fetchDraft()}
              />
            ) : (
              draft.allowedThemes && (
                <ThemeLobbyPanel
                  slug={slug}
                  allowedThemes={draft.allowedThemes}
                  themeSelection={draft.config.themeSelection ?? "player_pick"}
                  onClaimed={() => void fetchDraft()}
                />
              )
            )}
          </div>
        )}
        <DraftManageView
          draft={draft}
          slug={slug}
          isCreator={isCreator}
          isParticipant={isParticipant}
          onStart={handleStart}
          onCancel={handleCancel}
          onUpdate={handleUpdate}
          onJoin={handleJoin}
          onAddBot={handleAddBot}
          isDev={process.env.NODE_ENV !== "production"}
        />
      </div>
    );
  }

  if (draft.status === "active") {
    return (
      <div>
        {/* Full-width sticky timer — visible at ALL screen sizes, centered */}
        <div className="sticky top-14 z-40 border-b border-border bg-bg-deep/95 backdrop-blur-sm px-4 py-3">
          <div className="mx-auto max-w-[1800px]">
            {isThemeDraft && (() => {
              const inExtra = themeInExtra;
              const current = inExtra ? Math.min(draftedCount - themeMainTotal, themeExtraTotal) : Math.min(draftedCount, themeMainTotal);
              const target = inExtra ? themeExtraTotal : themeMainTotal;
              const pct = target > 0 ? Math.min(100, Math.round((current / target) * 100)) : 0;
              return (
                <div className="mb-2 flex items-center gap-3 text-sm">
                  <span
                    className={`shrink-0 rounded-full px-2.5 py-0.5 text-xs font-semibold ${inExtra ? "bg-accent-gold/15 text-accent-gold" : "bg-accent-primary/15 text-accent-primary"}`}
                  >
                    {inExtra ? "Extra Deck" : "Main Deck"}
                  </span>
                  <span className="shrink-0 tabular-nums text-text-secondary">
                    <span className="font-medium text-text-primary">{current}</span> / {target}
                  </span>
                  <div className="h-1 max-w-[14rem] flex-1 overflow-hidden rounded-full bg-bg-elevated">
                    <div
                      className={`h-full rounded-full transition-[width] duration-500 ${inExtra ? "bg-accent-gold" : "bg-accent-primary"}`}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                  {!inExtra && themeExtraTotal > 0 && (
                    <span className="hidden shrink-0 text-xs text-text-secondary sm:inline">
                      then Extra {themeExtraTotal}
                    </span>
                  )}
                </div>
              );
            })()}
            <TimerBar className="rounded-none border-0 bg-transparent p-0" totalDraftCards={totalDraftCards} />
          </div>
        </div>

        <div className="mx-auto max-w-[1800px] p-4 sm:p-6 lg:p-8">
          <div className="mb-6 sm:hidden">
            <SeatList />
          </div>

          <div className="grid gap-8 xl:grid-cols-[15rem_minmax(0,1fr)_clamp(22rem,18rem+12vw,32rem)]">
            {/* Left aside — SeatList only (TimerBar moved to sticky top) */}
            <aside className="hidden flex-col gap-4 xl:flex">
              <SeatList />
            </aside>

            <section className="min-w-0">
              <div className="mb-6">
                {draft.config.setNames && draft.config.setNames.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-2">
                    {draft.config.setNames.map((setName) => (
                      <span
                        key={setName}
                        className="rounded-full border border-accent-primary/25 bg-accent-primary/10 px-2.5 py-0.5 text-xs font-semibold uppercase tracking-wide text-accent-primary"
                      >
                        {setName}
                      </span>
                    ))}
                  </div>
                )}

                <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-border/50 pt-3 text-sm text-text-secondary">
                  {isThemeDraft ? (
                    <span className="font-medium text-text-primary">
                      {themeInExtra ? "Extra Deck" : "Main Deck"} pick
                    </span>
                  ) : (
                    <span className="font-medium text-text-primary">
                      Pack {draft.packRound ?? draft.currentPackRound ?? 1}, Pick{" "}
                      {draft.pickStep ?? draft.currentPickStep ?? 1}
                    </span>
                  )}
                  <span>
                    <span className="tabular-nums text-text-primary">{draft.currentPack?.length ?? 0}</span>{" "}
                    {isThemeDraft ? "choices" : "cards"} this pick
                  </span>
                  <span>
                    <span className="tabular-nums text-text-primary">{draft.playerCount}</span> players
                  </span>
                  <span>
                    <span className="tabular-nums text-text-primary">
                      {draft.pickSeconds ?? draft.config.pickSeconds ?? 60}s
                    </span>{" "}
                    timer
                  </span>
                </div>
              </div>
              <CardGrid />
            </section>

            {/* sm–xl intermediate aside — TimerBar removed, SeatList + PoolPanel kept */}
            <aside className="hidden w-full shrink-0 flex-col gap-4 sm:flex xl:hidden">
              <SeatList />
              <PoolPanel />
            </aside>

            <aside className="hidden xl:block">
              <PoolPanel />
            </aside>
          </div>

          <DraftCardPreview />

          <div className="fixed bottom-0 left-0 right-0 z-40 border-t border-border bg-bg-deep/95 backdrop-blur-sm p-4 sm:hidden">
            <PoolPanel />
          </div>

          <div className="h-20 sm:hidden" />
        </div>
      </div>
    );
  }

  return (
    <div>
      <DraftSummaryView
        draft={draft}
        slug={slug}
        isParticipant={isParticipant}
        isCreator={isCreator}
        onExportYdk={handleExportYdk}
        onDelete={handleDelete}
        myPool={draft.myPool}
      />
    </div>
  );
}
