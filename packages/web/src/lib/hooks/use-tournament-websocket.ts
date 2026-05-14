"use client";

import { useEffect, useRef } from "react";
import { io, Socket } from "socket.io-client";

const WS_URL =
  process.env.NEXT_PUBLIC_WS_URL ||
  (typeof window !== "undefined" ? window.location.origin : "http://localhost:3001");

interface UseTournamentWebsocketOptions {
  onParticipantJoined?: (data: { playerId: number; displayName: string }) => void;
  onParticipantLeft?: (data: { playerId: number }) => void;
  onStarted?: () => void;
  onCancelled?: () => void;
}

export function useTournamentWebsocket(slug: string, options: UseTournamentWebsocketOptions = {}) {
  const socketRef = useRef<Socket | null>(null);
  const optionsRef = useRef(options);
  optionsRef.current = options;

  useEffect(() => {
    if (!slug) return;

    const socket = io(WS_URL, { autoConnect: true });
    socketRef.current = socket;

    socket.on("connect", () => {
      socket.emit("tournament:join", { slug });
    });

    socket.on("tournament:participant-joined", (payload: { playerId: number; displayName: string }) => {
      optionsRef.current.onParticipantJoined?.(payload);
    });

    socket.on("tournament:participant-left", (payload: { playerId: number }) => {
      optionsRef.current.onParticipantLeft?.(payload);
    });

    socket.on("tournament:started", () => {
      optionsRef.current.onStarted?.();
    });

    socket.on("tournament:cancelled", () => {
      optionsRef.current.onCancelled?.();
    });

    socket.on("connect_error", (err) => {
      // eslint-disable-next-line no-console
      console.warn("Tournament WS connect error:", err.message);
    });

    return () => {
      socket.disconnect();
      socketRef.current = null;
    };
  }, [slug]);

  return socketRef;
}
