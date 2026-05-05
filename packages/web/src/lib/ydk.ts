export interface YdkCard {
  id: number;
  frameType: string;
}

const EXTRA_DECK_FRAME_TYPES = new Set([
  "fusion",
  "synchro",
  "xyz",
  "link",
  "fusion_pendulum",
  "synchro_pendulum",
  "xyz_pendulum",
]);

function isExtraDeckCard(frameType: string): boolean {
  return EXTRA_DECK_FRAME_TYPES.has(frameType.toLowerCase());
}

export function generateYdk(cards: YdkCard[]): string {
  const main: number[] = [];
  const extra: number[] = [];

  for (const card of cards) {
    if (isExtraDeckCard(card.frameType)) {
      extra.push(card.id);
    } else {
      main.push(card.id);
    }
  }

  const lines: string[] = [];
  lines.push("#main");
  for (const id of main) {
    lines.push(String(id));
  }
  lines.push("#extra");
  for (const id of extra) {
    lines.push(String(id));
  }
  lines.push("#side");

  return lines.join("\n") + "\n";
}

export function downloadYdk(cards: YdkCard[], filename: string): void {
  const content = generateYdk(cards);
  const blob = new Blob([content], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
