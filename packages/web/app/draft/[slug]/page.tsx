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
  config: {
    packSize?: number;
    packsPerPlayer?: number;
    pickSeconds?: number;
    setNames?: string[];
  };
  players: DraftPlayer[];
  playerCount: number;
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
      setDraft(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load draft");
    } finally {
      setLoading(false);
    }
  }, [slug, router]);

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
      <main className="min-h-screen bg-bg-deep text-text-primary">
        <div className="mx-auto max-w-4xl p-6">
          <div className="flex items-center justify-center py-20">
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-accent-primary border-t-transparent" />
          </div>
        </div>
      </main>
    );
  }

  if (error || !draft) {
    return (
      <main className="min-h-screen bg-bg-deep text-text-primary">
        <div className="mx-auto max-w-4xl p-6">
          <div className="rounded-lg border border-accent-cta/20 bg-accent-cta/10 p-6 text-accent-cta">
            {error ?? "Draft not found"}
          </div>
        </div>
      </main>
    );
  }

  const isCreator = currentUserId === draft.createdByUserId;
  const isParticipant = draft.players.some(
    (p) => String(p.playerId) === currentUserId
  );

  if (draft.status === "pending") {
    return (
      <main className="min-h-screen bg-bg-deep text-text-primary">
        <DraftManageView
          draft={draft}
          isCreator={isCreator}
          onStart={handleStart}
          onCancel={handleCancel}
          onUpdate={handleUpdate}
        />
      </main>
    );
  }

  if (draft.status === "active") {
    return (
      <main className="min-h-screen bg-bg-deep text-text-primary">
        <div className="sticky top-0 z-40 border-b border-border bg-bg-deep/95 backdrop-blur-sm px-4 py-3 sm:hidden">
          <TimerBar />
        </div>

        <div className="mx-auto max-w-[1600px] p-4 sm:p-6 lg:p-8">
          <div className="mb-6 sm:hidden">
            <SeatList />
          </div>

          <div className="flex flex-col gap-6 sm:flex-row sm:gap-8 lg:gap-8">
            <aside className="hidden w-64 shrink-0 flex-col gap-4 lg:flex">
              <TimerBar />
              <SeatList />
            </aside>

            <section className="min-w-0 flex-1">
              <div className="mb-4 flex items-center justify-between">
                <h1 className="font-display text-xl text-text-primary sm:text-2xl">
                  {draft.name}
                </h1>
              </div>
              <CardGrid />
            </section>

            <aside className="hidden w-full shrink-0 flex-col gap-4 sm:flex sm:w-64 lg:hidden">
              <TimerBar />
              <SeatList />
              <PoolPanel />
            </aside>

            <aside className="hidden w-64 shrink-0 lg:block">
              <PoolPanel />
            </aside>
          </div>

          <div className="fixed bottom-0 left-0 right-0 z-40 border-t border-border bg-bg-deep/95 backdrop-blur-sm p-4 sm:hidden">
            <PoolPanel />
          </div>

          <div className="h-20 sm:hidden" />
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-bg-deep text-text-primary">
      <DraftSummaryView
        draft={draft}
        isParticipant={isParticipant}
        onExportYdk={handleExportYdk}
      />
    </main>
  );
}