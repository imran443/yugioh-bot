"use client";

import { useEffect } from "react";
import { useDraftStore } from "@/lib/stores/draft-store";

export function useDraftExpiryResync(slug: string) {
  const completed = useDraftStore((s) => s.completed);
  const setFromServer = useDraftStore((s) => s.setFromServer);

  useEffect(() => {
    // Reconcile against server truth for the whole active draft, not just after the
    // timer hits 0. The pack only refreshes via a single fire-and-forget `resync`
    // broadcast emitted by the lone step-completing request; if that broadcast is
    // lost (dropped internal HTTP relay, Socket.IO reconnect, backgrounded tab, or
    // the step-completing pick threw SQLITE_BUSY before emitting it) the client would
    // otherwise stay frozen on the stale pack until the next timer expiry. A steady
    // low-cost poll guarantees convergence regardless of broadcast delivery.
    if (!slug || completed) {
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
  }, [completed, setFromServer, slug]);
}
