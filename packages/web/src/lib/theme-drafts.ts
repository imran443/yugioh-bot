import type { DraftConfig } from "@yugidraft/shared/types";

/** Read at request time on the server. APIs pass the capability to the browser. */
export function themeDraftsEnabled(): boolean {
  const value = process.env.THEME_DRAFTS;
  return value === "1" || value === "true" || value === "on";
}

/** Closing new theme work must not stop a stored theme lobby or active game. */
export function themeDraftSetupError(existing?: { config: DraftConfig; status: string }): string | undefined {
  if (themeDraftsEnabled()) return;
  if (existing?.config.mode === "theme" && (existing.status === "pending" || existing.status === "active")) return;
  return "Theme drafts are not open yet.";
}
