"use client";

import { useEffect } from "react";
import { useDraftStore } from "@/lib/stores/draft-store";

export function useDraftExpiryResync(slug: string) {
  const packRound = useDraftStore((s) => s.packRound);
  const pickStep = useDraftStore((s) => s.pickStep);
  const timerSeconds = useDraftStore((s) => s.timerSeconds);
  const completed = useDraftStore((s) => s.completed);
  const setFromServer = useDraftStore((s) => s.setFromServer);

  useEffect(() => {
    // Poll whenever the timer hits 0 on an active draft — including for players who have
    // already picked this step, because the bot auto-picks remaining players and the pack
    // then advances. Without this, already-picked players get stuck until a WS event arrives.
    if (!slug || completed || timerSeconds > 0) {
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
          if (cancelled) return;
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
  }, [completed, packRound, pickStep, setFromServer, slug, timerSeconds]);
}
