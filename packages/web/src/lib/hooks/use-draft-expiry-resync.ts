"use client";

import { useEffect, useRef } from "react";
import { useDraftStore } from "@/lib/stores/draft-store";

export function useDraftExpiryResync(slug: string) {
  const timerSeconds = useDraftStore((s) => s.timerSeconds);
  const completed = useDraftStore((s) => s.completed);
  const setFromServer = useDraftStore((s) => s.setFromServer);
  const hasSyncedRef = useRef(false);

  useEffect(() => {
    if (!slug || completed || timerSeconds > 0) {
      hasSyncedRef.current = false;
      return;
    }

    if (hasSyncedRef.current) {
      return;
    }

    hasSyncedRef.current = true;

    void fetch(`/api/drafts/${slug}`)
      .then((response) => {
        if (!response.ok) {
          throw new Error(`Failed to refetch draft state: ${response.status}`);
        }

        return response.json();
      })
      .then((data) => {
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
        hasSyncedRef.current = false;
      });
  }, [completed, setFromServer, slug, timerSeconds]);
}
