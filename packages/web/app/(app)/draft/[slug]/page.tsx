"use client";

import { parseUserId } from "@/lib/user-id";
import { signInHref } from "@/lib/draft-invite";

import { useEffect, useRef, useState, useCallback, type ReactNode } from "react";
import { useParams, useRouter } from "next/navigation";
import type { DraftDetailResponse } from "@yugidraft/shared/types";
import { DangerConfirm } from "@/components/draft/danger-confirm";
import { DraftFrame } from "@/components/draft/draft-frame";
import { DraftInviteGate } from "@/components/draft/invite-gate";
import { LobbyBarSub } from "@/components/draft/visibility/visibility-badge";
import { DraftManageView } from "@/components/draft/draft-manage-view";
import { DraftState } from "@/components/draft/draft-state";
import { HostActionNotice } from "@/components/draft/host-action-notice";
import { DraftTerminalError, requestDraftCancel } from "@/lib/draft-terminal-client";
import { DraftSummaryView } from "@/components/draft/draft-summary-view";
import { DraftRoom } from "@/components/draft/room/draft-room";
import { DraftFinale } from "@/components/draft/room/finale";
import { ThemeTableLobby } from "@/components/draft/theme/theme-table-lobby";
import { useInlineConfirm } from "@/components/draft/use-inline-confirm";
import { useDraftTournament } from "@/components/draft/use-draft-tournament";
import { svButtonClass } from "@/components/sheet";
import { useDraftStore } from "@/lib/stores/draft-store";
import { useDraftWebsocket } from "@/lib/hooks/use-draft-websocket";
import { useDraftCountdown } from "@/lib/hooks/use-draft-countdown";
import { useDraftExpiryResync } from "@/lib/hooks/use-draft-expiry-resync";
import { useLobbyClock } from "@/lib/hooks/use-lobby-clock";
import { usePoolImagePrefetch } from "@/lib/hooks/use-pool-image-prefetch";

const DRAFT_STATUS = {
  active: "active",
  completed: "completed",
} as const;

/**
 * The draft GET body: the shared response (pending drafts carry the lobby snapshot and the roster with ready/claim
 * fields) plus the flags the server adds. The page never reads the environment; it passes these down.
 */
type DraftData = DraftDetailResponse & {
  /** The Discord bot is on. When false the lobby has no Nudge, no Post to Discord and no Discord text. */
  discordEnabled?: boolean;
};

export default function DraftDetailPage() {
  const params = useParams();
  const slug = typeof params.slug === "string" ? params.slug : "";
  // A new address mounts a new body, so the last draft never shows for a frame under the new slug. The invite gate comes
  // first: with `?invite=` it redeems the link before the body reads the draft or asks for a live connection.
  return (
    <DraftInviteGate key={slug} slug={slug}>
      <DraftDetailBody slug={slug} />
    </DraftInviteGate>
  );
}

function DraftDetailBody({ slug }: { slug: string }) {
  const router = useRouter();

  const [draft, setDraft] = useState<DraftData | null>(null);
  const [error, setError] = useState<{ status: number | null } | null>(null);
  const [currentUserId, setCurrentUserId] = useState<number | null>(null);

  // The room is shown while the draft is active; finishing it from the room ends on the finale.
  const [wasInRoom, setWasInRoom] = useState(false);
  const [finaleClosed, setFinaleClosed] = useState(false);
  const [finaleExporting, setFinaleExporting] = useState(false);
  const [finaleExportError, setFinaleExportError] = useState<string | null>(null);

  // The tournament made from this draft, shared with the finale (and the results page).
  const tournament = useDraftTournament(slug, {
    tournamentId: draft?.tournamentId,
    tournamentName: draft?.tournamentName,
    tournamentSlug: draft?.tournamentSlug,
  });

  const setFromServer = useDraftStore((s) => s.setFromServer);
  const storeCompleted = useDraftStore((s) => s.completed);
  // Live drafted count (updates optimistically on each pick), so the theme phase
  // indicator stays in lock-step with the Your Pool / DRAFTED counters.
  const storePool = useDraftStore((s) => s.myPool);

  // News for a player: the draft was cancelled. Not set for the host, who started it.
  const [cancelNotice, setCancelNotice] = useState(false);
  const sentTerminalRef = useRef(false);

  const loadedRef = useRef(false);
  // The newest draft the page holds, for the revision check and for edits that carry the revision they were made on.
  const draftRef = useRef<DraftData | null>(null);
  // Bumped when the address changes: an answer from an older generation is dropped.
  const generationRef = useRef(0);
  const inflightRef = useRef<Promise<void> | null>(null);
  const queuedRef = useRef(false);
  // False once this body unmounts (the address changed): an answer that lands later must not touch the shared store.
  const aliveRef = useRef(true);

  // The shared draft store is global, so a new address clears what the last draft left in it. Nothing of the last
  // draft (its room, its pool) may show under the new one.
  useEffect(() => {
    aliveRef.current = true;
    setFromServer({
      slug,
      packRound: 1,
      pickStep: 1,
      currentPack: [],
      myPool: [],
      seats: [],
      timerSeconds: 0,
      isMyTurn: false,
      completed: false,
      pickSeconds: 60,
    });
    return () => {
      aliveRef.current = false;
    };
  }, [slug, setFromServer]);

  const clearProtectedState = useCallback(() => {
    setFromServer({
      slug,
      packRound: 1,
      pickStep: 1,
      currentPack: [],
      myPool: [],
      seats: [],
      timerSeconds: 0,
      isMyTurn: false,
      completed: false,
      pickSeconds: 60,
    });
    draftRef.current = null;
    setDraft(null);
  }, [setFromServer, slug]);

  const loadDraft = useCallback(async (generation: number) => {
    try {
      const res = await fetch(`/api/drafts/${slug}`);
      if (generation !== generationRef.current || !aliveRef.current) return;
      if (!res.ok) {
        if (res.status === 401) {
          // Sign in again and come back to this exact address.
          router.push(signInHref());
          return;
        }
        // Not found (a missing draft and a private one look the same) or closed to this viewer: nothing of the draft
        // stays in the shared store, so a room that was open a moment ago cannot show through.
        if (res.status === 404 || res.status === 403) clearProtectedState();
        // A server fault on a refresh keeps the room on screen; the next refresh brings it back up to date.
        if (res.status >= 500 && loadedRef.current) return;
        setError({ status: res.status });
        return;
      }
      const data = (await res.json()) as DraftData;
      if (generation !== generationRef.current || !aliveRef.current) return;
      // A lobby read that is older than the one on screen (a slow answer that crossed a newer one) must not undo it.
      const held = draftRef.current;
      if (data.status === "pending" && data.lobby && held?.status === "pending" && held.lobby && data.lobby.revision < held.lobby.revision) {
        return;
      }
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
      draftRef.current = data;
      setDraft(data);
      loadedRef.current = true;
      setError(null);
    } catch {
      if (generation === generationRef.current && aliveRef.current && !loadedRef.current) setError({ status: null });
    }
  }, [setFromServer, slug, router, clearProtectedState]);

  /**
   * Read the draft. Reads never overlap: a call made while one is running waits for it and then runs one more read,
   * so a burst of socket events, polls and button replies makes at most two requests, and the last one is the newest.
   */
  const fetchDraft = useCallback((): Promise<void> => {
    if (inflightRef.current) {
      queuedRef.current = true;
      return inflightRef.current;
    }
    const generation = generationRef.current;
    const run = async () => {
      try {
        do {
          queuedRef.current = false;
          await loadDraft(generation);
        } while (queuedRef.current && generation === generationRef.current);
      } finally {
        if (generation === generationRef.current) inflightRef.current = null;
      }
    };
    const promise = run();
    inflightRef.current = promise;
    return promise;
  }, [loadDraft]);

  // The recovery clock of a pending lobby: it reads again every 10 s, every second during a countdown, and once past
  // the server deadline. The server starts the draft; this page never does.
  useLobbyClock({
    pending: draft?.status === "pending",
    lobby: draft?.status === "pending" ? draft.lobby : null,
    onRefresh: () => void fetchDraft(),
  });

  // Once the draft is not found or closed to this viewer there is nothing to keep live: the feed and the poll stop.
  const liveSlug = error?.status === 404 || error?.status === 403 ? "" : slug;
  useDraftWebsocket(liveSlug, {
    onHostStopped: () => {
      // The host knows already: this tab sent the stop, or another tab of the host did.
      if (sentTerminalRef.current || (currentUserId != null && draftRef.current?.createdByUserId === currentUserId)) return;
      setCancelNotice(true);
    },
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
  useDraftExpiryResync(liveSlug);
  usePoolImagePrefetch(slug, draft?.status === "active");

  useEffect(() => {
    fetch("/api/auth/session")
      .then((r) => r.json())
      .then((s) => {
        setCurrentUserId(parseUserId(s?.user?.id));
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    fetchDraft();
  }, [fetchDraft]);

  useEffect(() => {
    if (draft?.status === DRAFT_STATUS.active) setWasInRoom(true);
  }, [draft?.status]);

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

  // Cancel draft. The socket echoes the change to this tab before the answer arrives, so the tab marks
  // itself first: the host does not get the "the draft was cancelled" news for their own click.
  const handleCancel = async () => {
    sentTerminalRef.current = true;
    try {
      await requestDraftCancel(slug);
    } catch (err) {
      sentTerminalRef.current = false;
      // The draft is not what this page shows (it ended or was cancelled in another tab): show the real state.
      if (err instanceof DraftTerminalError && err.refresh) void fetchDraft();
      throw err;
    }
    await fetchDraft();
  };

  const handleUpdate = async ({ revision: seen, ...data }: { name?: string; config?: unknown; revision?: number }) => {
    // The newest revision known: the page's own read, or the lobby answer the caller saw after its own change (Ready,
    // a seat edit). Without the second, the host's own change makes a false "the lobby changed" answer.
    const held = draftRef.current;
    const pageRevision = held?.status === "pending" ? held.lobby?.revision : undefined;
    const revision = pageRevision === undefined ? seen : seen === undefined ? pageRevision : Math.max(pageRevision, seen);
    const res = await fetch(`/api/drafts/${slug}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(revision === undefined ? data : { ...data, revision }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      if (res.status === 409 && body.code === "STALE_LOBBY") {
        // Someone changed the lobby first. Show the new one and let the host decide again.
        await fetchDraft();
        throw new Error("The lobby changed while you edited. It is up to date now. Check it and save again.");
      }
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
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      const serverError = typeof body?.error === "string" ? body.error.trim() : "";
      throw new Error(serverError || "Failed to export deck", { cause: serverError || undefined });
    }
    return res.text();
  };

  if (error || !draft) {
    return <DraftState slug={slug} error={error} onRetry={() => void fetchDraft()} />;
  }

  const isCreator = currentUserId === draft.createdByUserId;
  // The host, or an owner. The server decides; this only shows or hides the controls.
  const canCancel = isCreator || draft.canCancel === true;
  const isParticipant = draft.isParticipant;

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

  const withNotice = (view: ReactNode) => (
    <>
      {view}
      <HostActionNotice open={cancelNotice} onClose={() => setCancelNotice(false)} />
    </>
  );

  const isThemeDraft = draft.config.mode === "theme";
  const discordEnabled = draft.discordEnabled === true;

  if (draft.status === "pending") {
    if (isThemeDraft) {
      return withNotice(
        <ThemeTablePage
          draft={draft}
          slug={slug}
          isCreator={isCreator}
          canCancel={canCancel}
          isParticipant={isParticipant}
          viewerUserId={currentUserId}
          discordEnabled={discordEnabled}
          onJoin={handleJoin}
          onAddBot={handleAddBot}
          onCancel={handleCancel}
          onChanged={() => void fetchDraft()}
        />,
      );
    }
    return withNotice(
      <DraftManageView
        draft={draft}
        slug={slug}
        isCreator={isCreator}
        canCancel={canCancel}
        isParticipant={isParticipant}
        onStart={handleStart}
        onCancel={handleCancel}
        onUpdate={handleUpdate}
        onJoin={handleJoin}
        onAddBot={handleAddBot}
        onChanged={() => void fetchDraft()}
        botsEnabled={draft.botsEnabled === true}
        discordEnabled={discordEnabled}
      />,
    );
  }

  if (draft.status === "active") {
    const roomConfig = draft.config.mode !== "theme" && draft.boosterProgress
      ? { ...draft.config, cardsPerPlayer: draft.boosterProgress.mainTotal }
      : draft.config;
    return withNotice(
      <DraftRoom
        slug={slug}
        name={draft.name}
        config={roomConfig}
        isParticipant={isParticipant}
        onCancel={canCancel ? handleCancel : undefined}
      />,
    );
  }

  const finalePool = draft.status === DRAFT_STATUS.completed && draft.myPool?.length ? draft.myPool : storePool;
  const showFinale = wasInRoom && !finaleClosed && draft.status === DRAFT_STATUS.completed && isParticipant && finalePool.length > 0;
  const finaleExtra = isThemeDraft ? Math.max(0, finalePool.length - (draft.config.cardsPerPlayer ?? 40)) : 0;
  const downloadYdk = async () => {
    if (finaleExporting) return;
    setFinaleExporting(true);
    setFinaleExportError(null);
    try {
      const ydk = await handleExportYdk();
      const url = URL.createObjectURL(new Blob([ydk], { type: "text/plain" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = `${draft.name.replace(/\s+/g, "_")}.ydk`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (err) {
      const serverError = err instanceof Error && typeof err.cause === "string" ? err.cause : "";
      const detail = serverError ? ` ${serverError}${serverError.endsWith(".") ? "" : "."}` : "";
      setFinaleExportError(`Couldn't export the YDK file.${detail}`);
    } finally {
      setFinaleExporting(false);
    }
  };

  return withNotice(
    <div>
      <DraftSummaryView
        draft={draft}
        slug={slug}
        isParticipant={isParticipant}
        isCreator={isCreator}
        onExportYdk={handleExportYdk}
        onDelete={handleDelete}
        myPool={draft.myPool}
        tournament={tournament}
      />
      {showFinale && (
        <DraftFinale
          slug={slug}
          pool={finalePool}
          theme={isThemeDraft}
          extraCount={finaleExtra}
          canCreateTournament={draft.canCreateTournament === true}
          visibility={draft.visibility}
          tournament={tournament}
          exporting={finaleExporting}
          exportError={finaleExportError}
          onExport={() => void downloadYdk()}
          onClose={() => setFinaleClosed(true)}
        />
      )}
    </div>,
  );
}

type PendingDraft = Extract<DraftData, { status: "pending" }>;

/**
 * The pending theme draft: the Theme Table in the drafts frame. The Table is the body only and has no way to end the
 * draft, so the host gets Cancel draft in the page bar, with the same inline confirm the booster lobby uses.
 */
function ThemeTablePage({
  draft,
  slug,
  isCreator,
  canCancel,
  isParticipant,
  viewerUserId,
  discordEnabled,
  onJoin,
  onAddBot,
  onCancel,
  onChanged,
}: {
  draft: PendingDraft;
  slug: string;
  isCreator: boolean;
  /** The host or an owner: the lobby offers Cancel draft. */
  canCancel: boolean;
  isParticipant: boolean;
  viewerUserId: number | null;
  discordEnabled: boolean;
  onJoin: () => Promise<void>;
  onAddBot: () => Promise<void>;
  onCancel: () => Promise<void>;
  onChanged: () => void;
}) {
  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const confirm = useInlineConfirm(cancelling);

  const cancel = async () => {
    setCancelling(true);
    setCancelError(null);
    try {
      await onCancel();
      confirm.setOpen(false);
    } catch (err) {
      setCancelError(err instanceof Error ? err.message : "Failed to cancel draft");
    } finally {
      setCancelling(false);
    }
  };

  return (
    <DraftFrame
      title="Theme Table"
      sub={<LobbyBarSub name={draft.name} visibility={draft.visibility} />}
      back={{ href: "/drafts", label: "Drafts" }}
      actions={
        canCancel && !confirm.open ? (
          <button ref={confirm.triggerRef} type="button" className={svButtonClass("danger")} onClick={() => confirm.setOpen(true)}>
            Cancel draft
          </button>
        ) : undefined
      }
    >
      {canCancel && confirm.open && (
        <div onKeyDown={confirm.onKeyDown}>
          <DangerConfirm
            title="Cancel this draft?"
            confirmLabel="Yes, cancel"
            busy={cancelling}
            consequence={`It ends for the ${draft.players.length === 1 ? "1 player" : `${draft.players.length} players`} who joined. Nothing has been dealt yet.`}
            onBack={() => confirm.setOpen(false)}
            onConfirm={() => void cancel()}
          />
          {cancelError && <p role="alert">{cancelError}</p>}
        </div>
      )}
      <ThemeTableLobby
        slug={slug}
        draft={draft}
        isCreator={isCreator}
        isParticipant={isParticipant}
        viewerUserId={viewerUserId}
        onJoin={onJoin}
        onAddBot={onAddBot}
        botsEnabled={draft.botsEnabled === true}
        discordEnabled={discordEnabled}
        onChanged={onChanged}
      />
    </DraftFrame>
  );
}
