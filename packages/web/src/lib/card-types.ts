export interface CardSummary {
  id: number;
  name: string;
  type: string;
  frameType: string;
  attribute?: string;
  level?: number;
  effectText: string;
  atk?: number;
  def?: number;
  imageUrl: string;
  imageUrlSmall: string;
  qty?: number;
}

export function isMonster(type: string): boolean {
  return type.trim().toLowerCase().includes("monster");
}

export function isSpell(type: string): boolean {
  return type.trim().toLowerCase().includes("spell card");
}

export function isTrap(type: string): boolean {
  return type.trim().toLowerCase().includes("trap card");
}

export function isEffectMonster(card: Pick<CardSummary, "type" | "frameType">): boolean {
  const frameType = card.frameType.trim().toLowerCase();
  return isMonster(card.type) && (frameType === "effect" || card.type.toLowerCase().includes("effect monster"));
}

export function isNormalMonster(card: Pick<CardSummary, "type" | "frameType">): boolean {
  const frameType = card.frameType.trim().toLowerCase();
  return isMonster(card.type) && (frameType === "normal" || card.type.toLowerCase().includes("normal monster"));
}

// Fusion / Synchro / XYZ / Link monsters (incl. their Pendulum variants) live in
// the Extra Deck. Mirrors the shared catalog's isExtraDeckFrame classification.
const EXTRA_DECK_FRAMES = ["fusion", "synchro", "xyz", "link"];

export function isExtraDeckMonster(card: Pick<CardSummary, "type" | "frameType">): boolean {
  const frameType = card.frameType.trim().toLowerCase();
  const type = card.type.toLowerCase();
  return (
    EXTRA_DECK_FRAMES.some((f) => frameType === f || frameType.startsWith(`${f}_`)) ||
    type.includes("fusion monster") ||
    type.includes("synchro monster") ||
    type.includes("xyz monster") ||
    type.includes("link monster")
  );
}

export function getTypeBadgeClass(type: string): string {
  return isMonster(type)
    ? "bg-accent-primary/10 text-accent-primary"
    : isSpell(type)
      ? "bg-accent-gold/10 text-accent-gold"
      : "bg-accent-cta/10 text-accent-cta";
}

export function getTypeLabel(type: string): string {
  return isMonster(type) ? "Monster" : isSpell(type) ? "Spell" : isTrap(type) ? "Trap" : "Other";
}

export type TributeTier = "none" | "one" | "two";

// null = not a leveled monster (spells/traps, or no level), so it only ever
// matches the "Any" tribute selection.
export function tributeTierForLevel(level: number | null | undefined): TributeTier | null {
  if (level == null) return null;
  if (level <= 4) return "none";
  if (level <= 6) return "one";
  return "two";
}
