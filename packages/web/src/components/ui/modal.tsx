import * as React from "react";
import { X } from "lucide-react";
import { useFocusTrap } from "@/hooks/useFocusTrap";
import { cn } from "@/lib/utils";

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: React.ReactNode;
  className?: string;
}

export function Modal({ open, onClose, title, children, className }: ModalProps) {
  const panelRef = React.useRef<HTMLDivElement>(null);
  const closeButtonRef = React.useRef<HTMLButtonElement>(null);
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
      const timer = setTimeout(() => setMounted(false), 200);
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

  if (!mounted) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      role="dialog"
      aria-modal="true"
      aria-labelledby={title ? "modal-title" : undefined}
    >
      {/* Overlay */}
      <div
        className={cn(
          "absolute inset-0 bg-bg-deep/80 backdrop-blur-sm",
          "motion-safe:transition-opacity motion-safe:duration-200",
          visible ? "opacity-100" : "opacity-0"
        )}
        aria-hidden="true"
        onClick={onClose}
      />

      {/* Panel */}
      <div
        ref={panelRef}
        className={cn(
          "relative z-10 w-full max-w-lg rounded-lg bg-surface p-6 shadow-card",
          "motion-safe:transition-all motion-safe:duration-200",
          visible ? "opacity-100 scale-100" : "opacity-0 scale-95",
          className
        )}
      >
        <div className="flex items-start justify-between gap-4">
          {title && (
            <h2
              id="modal-title"
              className="text-lg font-semibold text-text-primary font-body"
            >
              {title}
            </h2>
          )}
          <button
            ref={closeButtonRef}
            onClick={onClose}
            className="ml-auto inline-flex h-8 w-8 items-center justify-center rounded-lg text-text-secondary motion-safe:transition-colors hover:bg-bg-elevated hover:text-text-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-primary"
            aria-label="Close modal"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="mt-4">{children}</div>
      </div>
    </div>
  );
}
