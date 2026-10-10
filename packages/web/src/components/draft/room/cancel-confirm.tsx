"use client";

import { useEffect, useId, useRef, useState } from "react";

export const CANCEL_ICON = (
  <svg viewBox="0 0 20 20" aria-hidden="true">
    <circle cx="10" cy="10" r="7.25" fill="none" stroke="currentColor" strokeWidth="1.5" />
    <path d="m7.2 7.2 5.6 5.6m0-5.6-5.6 5.6" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
  </svg>
);

/** The word the host types before a cancel goes through. */
export const CANCEL_WORD = "cancel";

const COPY = {
  title: "Cancel this draft?",
  body: "The draft is void. It stops at once for everyone. Nobody keeps any cards, and every pick and pack is thrown away. The players must start a new draft. This cannot be undone.",
  confirm: "Cancel draft",
  busy: "Cancelling…",
  back: "Keep drafting",
};

/**
 * The confirm for Cancel draft. It is a modal inside the room layer, so Tab stays on it. Cancel is destructive: it is
 * red, and the button stays off until the host types the word. While the request runs both buttons are off, and a lock
 * that is not state stops a second click in the same frame from sending a second request.
 */
export function CancelConfirm({
  open,
  onConfirm,
  onClose,
}: {
  /** False closes the dialog. */
  open: boolean;
  onConfirm: () => Promise<void>;
  onClose: () => void;
}) {
  // Mounted only while open, so each open starts clean: no old error, no old typed word.
  return open ? <ConfirmBody onConfirm={onConfirm} onClose={onClose} /> : null;
}

function ConfirmBody({ onConfirm, onClose }: { onConfirm: () => Promise<void>; onClose: () => void }) {
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sending = useRef(false);
  const backRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const headingId = useId();
  const errorId = useId();

  useEffect(() => {
    backRef.current?.focus();
  }, []);

  const armed = typed.trim().toLowerCase() === CANCEL_WORD;

  const confirm = async () => {
    if (sending.current || !armed) return;
    sending.current = true;
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong. Try again.");
    } finally {
      sending.current = false;
      setBusy(false);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      if (!busy) onClose();
      return;
    }
    // Tab stays inside the dialog.
    if (e.key !== "Tab" || !panelRef.current) return;
    const items = Array.from(panelRef.current.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled)"));
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  return (
    <div className="hc-scrim" onKeyDown={onKeyDown}>
      <div
        ref={panelRef}
        className="hc"
        data-tone="danger"
        data-host-confirm="cancel"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={headingId}
      >
        <h2 id={headingId}>{COPY.title}</h2>
        <p>{COPY.body}</p>
        <label className="hc-type">
          <span>Type <b>{CANCEL_WORD}</b> to confirm</span>
          <input
            type="text"
            value={typed}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            disabled={busy}
            aria-describedby={error ? errorId : undefined}
            onChange={(e) => setTyped(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void confirm();
              }
            }}
          />
        </label>
        {error ? (
          <p className="hc-error" id={errorId} role="alert">
            {error}
          </p>
        ) : null}
        <div className="hc-acts">
          <button ref={backRef} type="button" className="hc-btn" data-kind="ghost" disabled={busy} onClick={onClose}>
            {COPY.back}
          </button>
          <button
            type="button"
            className="hc-btn"
            data-kind="danger"
            disabled={busy || !armed}
            aria-busy={busy || undefined}
            onClick={() => void confirm()}
          >
            {busy ? COPY.busy : COPY.confirm}
          </button>
        </div>
      </div>
    </div>
  );
}
