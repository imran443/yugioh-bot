"use client";

import { useEffect, useRef } from "react";
import { io, Socket } from "socket.io-client";
import { useDraftStore } from "@/lib/stores/draft-store";

const WS_URL =
  process.env.NEXT_PUBLIC_WS_URL ||
  (typeof window !== "undefined" ? window.location.origin : "http://localhost:3001");

interface DraftStateEvent {
  slug: string;
  packRound: number;
  pickStep: number;
  currentPack: Array<{
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
  myPool: Array<{
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
  seats: Array<{
    seatIndex: number;
    playerId: number;
    displayName: string;
    hasPicked: boolean;
    isCurrentPlayer: boolean;
  }>;
  timerSeconds: number;
  isMyTurn: boolean;
  completed: boolean;
  pickSeconds: number;
}

interface DraftPickEvent {
  playerId: number;
  draftCardId: number;
}

interface DraftRotateEvent {
  currentPack: DraftStateEvent["currentPack"];
  currentHolderSeatIndex: number;
}

interface DraftTimerEvent {
  timerSeconds: number;
}

interface DraftCompleteEvent {
  seats: DraftStateEvent["seats"];
}

export function useDraftWebsocket(slug: string) {
  const socketRef = useRef<Socket | null>(null);
  const setFromServer = useDraftStore((s) => s.setFromServer);

  useEffect(() => {
    if (!slug) return;

    const socket = io(WS_URL, {
      autoConnect: true,
    });
    socketRef.current = socket;

    socket.on("connect", () => {
      socket.emit("draft:join", { slug });
    });

    socket.on(
      "draft:state",
      (payload: DraftStateEvent) => {
        setFromServer({
          slug: payload.slug,
          packRound: payload.packRound,
          pickStep: payload.pickStep,
          currentPack: payload.currentPack,
          myPool: payload.myPool,
          seats: payload.seats,
          timerSeconds: payload.timerSeconds,
          isMyTurn: payload.isMyTurn,
          completed: payload.completed,
          pickSeconds: payload.pickSeconds,
        });
      }
    );

    socket.on("draft:pick", (payload: DraftPickEvent) => {
      setFromServer({
        seats: useDraftStore.getState().seats.map((s) =>
          s.playerId === payload.playerId ? { ...s, hasPicked: true } : s
        ),
      });
    });

    socket.on("draft:rotate", (payload: DraftRotateEvent) => {
      setFromServer({
        currentPack: payload.currentPack,
        pickStep: useDraftStore.getState().pickStep + 1,
        seats: useDraftStore.getState().seats.map((s) => ({
          ...s,
          hasPicked: false,
        })),
      });
    });

    socket.on("draft:timer", (payload: DraftTimerEvent) => {
      setFromServer({ timerSeconds: payload.timerSeconds });
    });

    socket.on("draft:complete", (payload: DraftCompleteEvent) => {
      setFromServer({
        completed: true,
        seats: payload.seats,
        isMyTurn: false,
      });
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
