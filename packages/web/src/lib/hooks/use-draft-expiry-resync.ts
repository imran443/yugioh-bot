"use client";

import { useEffect } from "react";
import { useDraftStore } from "@/lib/stores/draft-store";

export function useDraftExpiryResync(slug: string) {
  const packRound = useDraftStore((s) => s.packRound);
  const pickStep = useDraftStore((s) => s.pickStep);
  const timerSeconds = useDraftStore((s) => s.timerSeconds);
  const isMyTurn = useDraftStore((s) => s.isMyTurn);
  const completed = useDraftStore((s) => s.completed);
  const setFromServer = useDraftStore((s) => s.setFromServer);

  useEffect(() => {
    if (!slug || completed || timerSeconds > 0 || !isMyTurn) {
      return;
    }

    let cancelled = false;

    const syncDraftState = () => {
      void fetch(`/api/drafts/${slug}`)
        .then((response) => {
          if (!response.ok) {
            throw new Error(`Failed to refetch draft state: ${response.status}`);
          }

          return response.json();
        })
        .then((data) => {
          if (cancelled) {
            return;
          }

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
        })
        .catch((error) => {
          console.warn("Draft expiry resync failed:", error);
        });
    };

    syncDraftState();
    const intervalId = window.setInterval(syncDraftState, 1000);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [completed, isMyTurn, packRound, pickStep, setFromServer, slug, timerSeconds]);
}
