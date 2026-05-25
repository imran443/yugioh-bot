export interface RecentEntry {
  kind: string;
  tournament_name: string | null;
}

export function recentActivityLabel(entry: RecentEntry): string {
  if (entry.kind === "placement") {
    return entry.tournament_name ?? "Tournament placement";
  }
  return entry.tournament_name ? `Match win · ${entry.tournament_name}` : "Match win · Casual";
}
