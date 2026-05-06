"use client";

import { useEffect } from "react";
import { useDraftStore } from "@/lib/stores/draft-store";

export function useDraftCountdown() {
  const timerSeconds = useDraftStore((s) => s.timerSeconds);
  const completed = useDraftStore((s) => s.completed);
  const tick = useDraftStore((s) => s.tick);

  useEffect(() => {
    if (completed || timerSeconds <= 0) {
      return;
    }

    const timeout = window.setTimeout(() => {
      tick();
    }, 1000);

    return () => {
      window.clearTimeout(timeout);
    };
  }, [completed, timerSeconds, tick]);
}
