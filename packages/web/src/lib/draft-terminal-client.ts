/**
 * Browser side of POST /api/drafts/[slug]/cancel (docs/api/draft-host-end.md). The page and the draft room
 * both send through this, so every error reads the same: plain words, and what was (not) changed.
 */

/** The answer of a failed request. `refresh` is true when the draft is not what the page shows, so the page should read it again. */
export class DraftTerminalError extends Error {
  constructor(message: string, readonly status: number | null, readonly code: string | null) {
    super(message);
    this.name = "DraftTerminalError";
  }

  get refresh(): boolean {
    return this.code === "DRAFT_ALREADY_FINISHED";
  }
}

export function draftCancelMessage(status: number, code: string | null, serverText: string | null): string {
  if (status === 401) return "Your session ended. Sign in again, then try again.";
  if (status === 403) return "Only the host or an owner can cancel this draft.";
  if (status === 404) return "This draft was not found. It may have been deleted.";
  if (status === 409) {
    if (code === "DRAFT_ALREADY_FINISHED") return "This draft is already finished or cancelled. Nothing was changed.";
    if (code === "DRAFT_HAS_TOURNAMENT") return "This draft is linked to a tournament, so it cannot be cancelled.";
  }
  if (status === 503) return "The service is not available right now. Nothing was changed. Try again in a moment.";
  if (status >= 500) return "The draft could not be cancelled. Try again.";
  return serverText || "Failed to cancel the draft.";
}

export async function requestDraftCancel(slug: string): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`/api/drafts/${encodeURIComponent(slug)}/cancel`, { method: "POST" });
  } catch {
    throw new DraftTerminalError("Could not reach the server. Check your connection and try again.", null, null);
  }
  if (res.ok) return;
  const body = (await res.json().catch(() => null)) as { error?: unknown; code?: unknown } | null;
  const code = typeof body?.code === "string" ? body.code : null;
  const text = typeof body?.error === "string" ? body.error : null;
  throw new DraftTerminalError(draftCancelMessage(res.status, code, text), res.status, code);
}
