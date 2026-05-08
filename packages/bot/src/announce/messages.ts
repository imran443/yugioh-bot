const DEFAULT_WEB_URL = "http://localhost:3000";

function webBaseUrl(webUrl?: string): string {
  return (webUrl?.trim() || process.env.WEB_URL?.trim() || DEFAULT_WEB_URL).replace(/\/+$/, "");
}

export function draftCreatedAnnouncement(input: { name: string; webSlug: string; webUrl?: string }): string {
  return `Signups are open for **${input.name}**. Pick cards: ${webBaseUrl(input.webUrl)}/draft/${input.webSlug}`;
}

export function tournamentCreatedAnnouncement(input: { name: string; format: string; webSlug: string; webUrl?: string }): string {
  return `Signups are open for **${input.name}** (${input.format}). Manage: ${webBaseUrl(input.webUrl)}/tournament/${input.webSlug}`;
}

export function tournamentStartedAnnouncement(input: { name: string; webSlug: string; webUrl?: string }): string {
  return `**${input.name}** has started. Bracket: ${webBaseUrl(input.webUrl)}/tournament/${input.webSlug}`;
}
