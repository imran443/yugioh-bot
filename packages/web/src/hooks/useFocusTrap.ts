import * as React from "react";

export function useFocusTrap(
  containerRef: React.RefObject<HTMLElement | null>,
  enabled: boolean
) {
  React.useEffect(() => {
    if (!enabled || !containerRef.current) return;

    const container = containerRef.current;
    const selector =
      'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), details, [tabindex]:not([tabindex="-1"])';

    const getFocusable = () =>
      Array.from(container.querySelectorAll<HTMLElement>(selector)).filter(
        (el) =>
          !el.hasAttribute("disabled") &&
          !el.getAttribute("aria-hidden") &&
          el.tabIndex >= 0
      );

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;

      const focusable = getFocusable();
      if (focusable.length === 0) return;

      const first = focusable[0];
      const last = focusable[focusable.length - 1];

      if (e.shiftKey) {
        if (document.activeElement === first) {
          e.preventDefault();
          last.focus();
        }
      } else {
        if (document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [enabled, containerRef]);
}
