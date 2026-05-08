"use client";

import { useEffect, useRef } from "react";
import { io, Socket } from "socket.io-client";
import { useDraftStore } from "@/lib/stores/draft-store";

const WS_URL =
  process.env.NEXT_PUBLIC_WS_URL ||
  (typeof window !== "undefined" ? window.location.origin : "http://localhost:3001");

interface UseDraftWebsocketOptions {
  onStatusChange?: (status: "active" | "cancelled" | "completed") => void;
  onResync?: () => void;
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

    socket.on("connect", () => {
      socket.emit("draft:join", { slug });
    });

    socket.on("draft:status", (payload: { status: "active" | "cancelled" | "completed" }) => {
      if (payload.status === "completed") {
        setFromServer({ completed: true, isMyTurn: false });
      }
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

    socket.on("connect_error", (err) => {
      // eslint-disable-next-line no-console
      console.warn("Draft WS connect error:", err.message);
    });

    return () => {
      socket.disconnect();
      socketRef.current = null;
    };
  }, [slug, setFromServer]);

  return socketRef;
}
