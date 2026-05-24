import type { CardSummary } from "@/lib/card-types";

export interface BreakdownEntry {
  label: string;
  count: number;
}

function sortedEntries(counts: Map<string, number>): BreakdownEntry[] {
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([label, count]) => ({ label, count }));
}

export function attributeBreakdown(cards: CardSummary[]): BreakdownEntry[] {
  const counts = new Map<string, number>();
  for (const c of cards) {
    const a = c.attribute;
    if (!a || a === "SPELL" || a === "TRAP") continue;
    counts.set(a, (counts.get(a) ?? 0) + 1);
  }
  return sortedEntries(counts);
}

export function typeBreakdown(cards: CardSummary[]): BreakdownEntry[] {
  const counts = new Map<string, number>();
  for (const c of cards) {
    const t = c.type.trim();
    if (!t) continue;
    counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  return sortedEntries(counts);
}
