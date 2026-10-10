"use client";

import { useEffect, useRef } from "react";
import { io, Socket } from "socket.io-client";
import { useDraftStore } from "@/lib/stores/draft-store";
import { useTalkStore } from "@/lib/stores/talk-store";

const WS_URL =
  process.env.NEXT_PUBLIC_WS_URL ||
  (typeof window !== "undefined" ? window.location.origin : "http://localhost:3001");

interface UseDraftWebsocketOptions {
  onStatusChange?: (status: "active" | "cancelled" | "completed") => void;
  /**
   * The host or an owner cancelled the draft. Only the `draft:status` event says so: a draft that finishes by itself
   * arrives as `draft:complete` or `draft:status` "completed", which does not call this.
   */
  onHostStopped?: (status: "cancelled") => void;
  onResync?: () => void;
  onSeatsChange?: () => void;
}

export function useDraftWebsocket(slug: string, options: UseDraftWebsocketOptions = {}) {
  const socketRef = useRef<Socket | null>(null);
  const setFromServer = useDraftStore((s) => s.setFromServer);
  const optionsRef = useRef(options);
  optionsRef.current = options;

  useEffect(() => {
    if (!slug) return;

    const socket = io(WS_URL, { autoConnect: true });
    socketRef.current = socket;
    let disposed = false;
    let requestId = 0;
    let tokenRequest: AbortController | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let retryDelay = 1000;

    function clearJoinRetry() {
      if (retryTimer === null) return;
      clearTimeout(retryTimer);
      retryTimer = null;
    }

    function scheduleJoinRetry(currentRequest: number) {
      if (disposed || !socket.connected || currentRequest !== requestId) return;
      clearJoinRetry();
      retryTimer = setTimeout(() => {
        retryTimer = null;
        void joinDraftRoom();
      }, retryDelay);
      retryDelay = Math.min(retryDelay * 2, 15000);
    }

    async function joinDraftRoom() {
      clearJoinRetry();
      const currentRequest = ++requestId;
      tokenRequest?.abort();
      tokenRequest = new AbortController();
      try {
        const response = await fetch(`/api/drafts/${encodeURIComponent(slug)}/connection`, {
          cache: "no-store", signal: tokenRequest.signal,
        });
        if (!response.ok) {
          if (response.status !== 403 && response.status !== 404) scheduleJoinRetry(currentRequest);
          return;
        }
        const data = await response.json() as { token: string; userId: number };
        if (disposed || !socket.connected || currentRequest !== requestId) return;
        socket.emit("draft:join", { slug, token: data.token, userId: data.userId }, (result?: { error?: string }) => {
          if (disposed || !socket.connected || currentRequest !== requestId) return;
          if (result?.error !== undefined) {
            scheduleJoinRetry(currentRequest);
            return;
          }
          clearJoinRetry();
          retryDelay = 1000;
          optionsRef.current.onResync?.();
        });
      } catch (error) {
        if (!disposed && socket.connected && currentRequest === requestId && !(error instanceof Error && error.name === "AbortError")) {
          console.warn("Draft live feed is unavailable. Retrying.");
          scheduleJoinRetry(currentRequest);
        }
      }
    }

    socket.on("connect", () => {
      void joinDraftRoom();
    });

    socket.on("disconnect", () => {
      ++requestId;
      clearJoinRetry();
      retryDelay = 1000;
      tokenRequest?.abort();
    });

    socket.on("draft:subscription-expired", (payload: { slug: string }) => {
      if (payload.slug !== slug) return;
      optionsRef.current.onResync?.();
      void joinDraftRoom();
    });

    socket.on("draft:status", (payload: { status: "active" | "cancelled" | "completed" }) => {
      if (payload.status === "completed") {
        setFromServer({ completed: true, isMyTurn: false });
      }
      if (payload.status === "cancelled") optionsRef.current.onHostStopped?.(payload.status);
      optionsRef.current.onStatusChange?.(payload.status);
    });

    socket.on(
      "draft:pick",
      (payload: { playerId: number; packRound: number; pickStep: number }) => {
        const state = useDraftStore.getState();
        if (state.packRound !== payload.packRound || state.pickStep !== payload.pickStep) return;
        setFromServer({
          seats: state.seats.map((s) =>
            s.playerId === payload.playerId ? { ...s, hasPicked: true } : s,
          ),
        });
      },
    );

    socket.on("draft:resync", (_payload: { packRound: number; pickStep: number }) => {
      optionsRef.current.onResync?.();
    });

    socket.on("draft:complete", () => {
      setFromServer({ completed: true, isMyTurn: false });
      optionsRef.current.onStatusChange?.("completed");
    });

    // Table talk: a fixed line from a seat. The store checks the id and drops anything else.
    socket.on("draft:talk", (payload: { playerId: number; line: string }) => {
      useTalkStore.getState().hear(payload?.playerId, payload?.line);
    });

    socket.on("draft:seats", () => {
      optionsRef.current.onSeatsChange?.();
    });

    // A hidden tab can miss events and its timers slow down. Read the draft again when the tab comes back.
    const onVisible = () => {
      if (disposed || document.visibilityState === "hidden") return;
      optionsRef.current.onResync?.();
      if (socket.connected) void joinDraftRoom();
    };
    document.addEventListener("visibilitychange", onVisible);

    socket.on("connect_error", (err) => {
      // eslint-disable-next-line no-console
      console.warn("Draft WS connect error:", err.message);
    });

    return () => {
      disposed = true;
      document.removeEventListener("visibilitychange", onVisible);
      ++requestId;
      clearJoinRetry();
      tokenRequest?.abort();
      socket.disconnect();
      socketRef.current = null;
    };
  }, [slug, setFromServer]);

  return socketRef;
}
