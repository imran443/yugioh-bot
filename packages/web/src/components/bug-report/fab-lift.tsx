"use client";

import { useEffect, useRef, useSyncExternalStore, type ComponentPropsWithoutRef } from "react";

/**
 * A page bar that sticks to the bottom of the screen (the draft action block on a phone, the tournament action bar)
 * would sit under the floating Report bug button. Such a bar registers itself here (`BugFabLift`), and the button
 * lifts above it by the amount the bar rises over the button's corner.
 */
const FAB_BOTTOM = 12;
const FAB_HEIGHT = 36;
const GAP = 8;

const lifts = new Map<HTMLElement, number>();
const listeners = new Set<() => void>();
let total = 0;

function publish() {
  const next = Math.max(0, ...lifts.values());
  if (next === total) return;
  total = next;
  listeners.forEach((listener) => listener());
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

/** How far the button rises, in px. 0 while no bottom bar is on screen; the server render says 0 too. */
export function useBugFabLift(): number {
  return useSyncExternalStore(subscribe, () => total, () => 0);
}

/** The lift one bar asks for: 0 unless it is stuck or fixed and reaches into the button's corner. */
export function liftFor(rect: { top: number; bottom: number; height: number }, position: string, viewportHeight: number): number {
  if (position !== "sticky" && position !== "fixed") return 0;
  if (rect.height <= 0 || rect.bottom < viewportHeight - FAB_BOTTOM - FAB_HEIGHT) return 0;
  return Math.max(0, Math.ceil(viewportHeight - rect.top + GAP - FAB_BOTTOM));
}

/**
 * The height the bar rect and the fixed button are laid out against: the layout viewport. Not `visualViewport.height`,
 * which shrinks with the phone keyboard or a pinch zoom while the rect and the button do not move with it.
 */
function layoutViewportHeight(): number {
  return document.documentElement.clientHeight || window.innerHeight;
}

/** A div that keeps the Report bug button above it while it sticks to the bottom of the screen. */
export function BugFabLift(props: ComponentPropsWithoutRef<"div">) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const viewport = layoutViewportHeight();
      lifts.set(el, liftFor(el.getBoundingClientRect(), getComputedStyle(el).position, viewport));
      publish();
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    measure();
    window.addEventListener("scroll", schedule, { passive: true, capture: true });
    window.addEventListener("resize", schedule);
    // The keyboard and pinch zoom move the visual viewport (and the bar's stuck state) without a window resize or scroll.
    const visual = window.visualViewport;
    visual?.addEventListener("resize", schedule);
    visual?.addEventListener("scroll", schedule);
    // Page content growing or shrinking sticks or unsticks the bar with no scroll event, so watch the content too.
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
    observer?.observe(el);
    if (el.parentElement) observer?.observe(el.parentElement);
    observer?.observe(document.body);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener("scroll", schedule, true);
      window.removeEventListener("resize", schedule);
      visual?.removeEventListener("resize", schedule);
      visual?.removeEventListener("scroll", schedule);
      observer?.disconnect();
      lifts.delete(el);
      publish();
    };
  }, []);
  return <div ref={ref} {...props} />;
}
