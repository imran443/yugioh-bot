import * as React from "react";
import { X } from "lucide-react";
import { useFocusTrap } from "@/hooks/useFocusTrap";
import { cn } from "@/lib/utils";

interface SheetProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: React.ReactNode;
  className?: string;
}

export function Sheet({
  open,
  onClose,
  title,
  children,
  className,
}: SheetProps) {
  const panelRef = React.useRef<HTMLDivElement>(null);
  const closeButtonRef = React.useRef<HTMLButtonElement>(null);
  const touchStartY = React.useRef<number | null>(null);
  const [mounted, setMounted] = React.useState(open);
  const [visible, setVisible] = React.useState(false);
  const rafRef = React.useRef<number | null>(null);
  const previousFocusRef = React.useRef<HTMLElement | null>(null);
  const didCaptureRef = React.useRef(false);

  // Mount/unmount with animation
  React.useEffect(() => {
    if (open) {
      setMounted(true);
      rafRef.current = requestAnimationFrame(() => setVisible(true));
    } else {
      setVisible(false);
    }
    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [open]);

  React.useEffect(() => {
    if (!visible && mounted) {
      const timer = setTimeout(() => setMounted(false), 300);
      return () => clearTimeout(timer);
    }
  }, [visible, mounted]);

  // Lock body scroll
  React.useEffect(() => {
    if (open) {
      const original = document.body.style.overflow;
      document.body.style.overflow = "hidden";
      return () => {
        document.body.style.overflow = original;
      };
    }
  }, [open]);

  // Escape to close
  React.useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [open, onClose]);

  // Capture previous focus
  React.useEffect(() => {
    if (open) {
      if (!didCaptureRef.current) {
        previousFocusRef.current = document.activeElement as HTMLElement | null;
        didCaptureRef.current = true;
      }
    } else {
      didCaptureRef.current = false;
    }
  }, [open]);

  // Restore focus on unmount
  React.useEffect(() => {
    if (!mounted && previousFocusRef.current) {
      previousFocusRef.current.focus();
      previousFocusRef.current = null;
    }
  }, [mounted]);

  // Initial focus
  React.useEffect(() => {
    if (!open) return;
    closeButtonRef.current?.focus();
  }, [open]);

  // Focus trap
  useFocusTrap(panelRef, open);

  const handleTouchStart = (e: React.TouchEvent) => {
    touchStartY.current = e.touches[0].clientY;
  };

  const handleTouchEnd = (e: React.TouchEvent) => {
    if (touchStartY.current == null) return;
    const diff = e.changedTouches[0].clientY - touchStartY.current;
    if (diff > 80) {
      onClose();
    }
    touchStartY.current = null;
  };

  if (!mounted) return null;

  return (
    <div
      className="fixed inset-0 z-50"
      role="dialog"
      aria-modal="true"
      aria-labelledby={title ? "sheet-title" : undefined}
    >
      {/* Overlay */}
      <div
        className={cn(
          "absolute inset-0 bg-bg-deep/80 backdrop-blur-sm",
          "motion-safe:transition-opacity motion-safe:duration-300",
          visible ? "opacity-100" : "opacity-0"
        )}
        aria-hidden="true"
        onClick={onClose}
      />

      {/* Panel */}
      <div
        ref={panelRef}
        className={cn(
          "absolute z-10 bg-surface shadow-card",
          // Mobile: bottom sheet
          "bottom-0 left-0 right-0 rounded-t-lg max-h-[90vh] overflow-y-auto",
          // Desktop: right sheet
          "md:bottom-auto md:left-auto md:right-0 md:top-0 md:h-full md:w-96 md:rounded-l-lg md:rounded-tr-none",
          // Transitions
          "motion-safe:transition-transform motion-safe:duration-300",
          visible
            ? "translate-y-0 md:translate-x-0"
            : "translate-y-full md:translate-x-full",
          className
        )}
        onTouchStart={handleTouchStart}
        onTouchEnd={handleTouchEnd}
      >
        <div className="flex items-start justify-between gap-4 p-6">
          {title && (
            <h2
              id="sheet-title"
              className="text-lg font-semibold text-text-primary font-body"
            >
              {title}
            </h2>
          )}
          <button
            ref={closeButtonRef}
            onClick={onClose}
            className="ml-auto inline-flex h-8 w-8 items-center justify-center rounded-lg text-text-secondary motion-safe:transition-colors hover:bg-bg-elevated hover:text-text-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-primary"
            aria-label="Close sheet"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="px-6 pb-6">{children}</div>
      </div>
    </div>
  );
}
