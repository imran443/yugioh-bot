import { useEffect } from "react";

// Warms the browser image cache for every card in a draft's pool so that when
// a new pack is shown its images are cache hits (no blank-frame flicker).
// Fetches the pool once per slug; failures are non-fatal (best-effort).
export function usePoolImagePrefetch(slug: string, enabled: boolean): void {
  useEffect(() => {
    if (!enabled || !slug || typeof window === "undefined") return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/drafts/${slug}/pool`);
        if (!res.ok) return;
        const data = (await res.json()) as { cards: Array<{ imageUrl: string; imageUrlSmall: string }> };
        if (cancelled) return;
        for (const c of data.cards) {
          const img = new window.Image();
          img.decoding = "async";
          img.src = c.imageUrlSmall || c.imageUrl;
        }
      } catch {
        // best-effort prefetch; ignore
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [slug, enabled]);
}
