"use client";

import { useEffect, useState, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import { DraftManageView } from "@/components/draft/draft-manage-view";
import { DraftSummaryView } from "@/components/draft/draft-summary-view";
import { CardGrid } from "@/components/draft/card-grid";
import { TimerBar } from "@/components/draft/timer-bar";
import { SeatList } from "@/components/draft/seat-list";
import { PoolPanel } from "@/components/draft/pool-panel";
import { useDraftStore } from "@/lib/stores/draft-store";
import { useDraftWebsocket } from "@/lib/hooks/use-draft-websocket";

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
    pickSeconds?: number;
    setNames?: string[];
  };
  players: DraftPlayer[];
  playerCount: number;
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
  useDraftWebsocket(slug);

  useEffect(() => {
    fetch("/api/auth/session")
      .then((r) => r.json())
      .then((s) => {
        if (s?.user?.id) setCurrentUserId(s.user.id);
      })
      .catch(() => {});
  }, []);

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
      if (data.status === "active") {
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

  useEffect(() => {
    fetchDraft();
  }, [fetchDraft]);

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

  const handleJoin = async () => {
    const res = await fetch(`/api/drafts/${slug}/join`, { method: "POST" });
    if (!res.ok) {
      const body = await res.json();
      throw new Error(body.error ?? "Failed to join draft");
    }
    await fetchDraft();
  };

  if (draft.status === "pending") {
    return (
      <div>
        <DraftManageView
          draft={draft}
          isCreator={isCreator}
          isParticipant={isParticipant}
          onStart={handleStart}
          onCancel={handleCancel}
          onUpdate={handleUpdate}
          onJoin={handleJoin}
        />
      </div>
    );
  }

  if (draft.status === "active") {
    return (
      <div>
        <div className="sticky top-0 z-40 border-b border-border bg-bg-deep/95 backdrop-blur-sm px-4 py-3 sm:hidden">
          <TimerBar />
        </div>

        <div className="mx-auto max-w-[1600px] p-4 sm:p-6 lg:p-8">
          <div className="mb-6 sm:hidden">
            <SeatList />
          </div>

          <div className="grid gap-6 xl:grid-cols-[15rem_minmax(0,1fr)_17.5rem]">
            <aside className="hidden flex-col gap-4 xl:flex">
              <TimerBar />
              <SeatList />
            </aside>

            <section className="min-w-0">
              <div className="mb-6">
                <p className="text-xs font-semibold uppercase tracking-[0.24em] text-text-muted">
                  Live Draft Room
                </p>
                <h1 className="mt-1 font-display text-2xl leading-tight text-text-primary sm:text-3xl">
                  {draft.name}
                </h1>

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

                <div className="mt-3 flex flex-wrap items-center gap-3 border-t border-border/50 pt-3 text-sm text-text-secondary">
                  <span className="font-medium text-text-primary">
                    Pack {draft.packRound ?? draft.currentPackRound ?? 1} · Pick {draft.pickStep ?? draft.currentPickStep ?? 1}
                  </span>
                  <span>{draft.currentPack?.length ?? 0} cards in pack</span>
                  <span>{draft.playerCount} players</span>
                  <span>{draft.pickSeconds ?? draft.config.pickSeconds ?? 60}s timer</span>
                </div>
              </div>
              <CardGrid />
            </section>

            <aside className="hidden w-full shrink-0 flex-col gap-4 sm:flex xl:hidden">
              <TimerBar />
              <SeatList />
              <PoolPanel />
            </aside>

            <aside className="hidden xl:block">
              <PoolPanel />
            </aside>
          </div>

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
        isParticipant={isParticipant}
        onExportYdk={handleExportYdk}
      />
    </div>
  );
}
