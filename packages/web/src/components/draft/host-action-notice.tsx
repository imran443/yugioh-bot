"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import styles from "./host-action-notice.module.css";

// Neutral words: the host or an app owner can cancel a draft, and the notice does not say which.
const TITLE = "The draft was cancelled";
const DETAIL = "The draft is void. No picks were kept. Start a new draft to play again.";

/**
 * Tells a player that the draft was cancelled. It sits over the page, also over the draft room, which is why it is
 * a portal: the room locks the rest of the page, but a node added later is not locked. It stays until it is closed,
 * so it is still there when the room has handed over to the summary.
 */
export function HostActionNotice({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted || !open) return null;
  return createPortal(
    <div className={styles.notice} data-action="cancelled" role="status" aria-live="polite">
      <div className={styles.text}>
        <b>{TITLE}</b>
        <span>{DETAIL}</span>
      </div>
      <div className={styles.acts}>
        <Link href="/drafts" className={styles.link}>All drafts</Link>
        <button type="button" className={styles.close} onClick={onClose}>Dismiss</button>
      </div>
    </div>,
    document.body,
  );
}
