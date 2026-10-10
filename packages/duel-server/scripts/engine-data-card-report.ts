import { PROJECT_IGNIS_IMAGE_URL, trustedCardImageUrl } from "@yugidraft/shared/services";
import type { CardIdentity } from "./prerelease-history.js";

type SourceCard = CardIdentity & { file: string };
export interface CardSnapshot {
  released: SourceCard[];
  prerelease: SourceCard[];
  remaps: Record<string, number>;
}
interface Dates { tcg_date?: string; ocg_date?: string }
interface Product extends Dates { set_name: string; set_code: string }
interface ApiCard {
  id: number;
  card_sets?: Product[];
  card_images?: Array<{ id: number; image_url?: string }>;
  misc_info?: Array<Dates & { beta_id?: number }>;
}
interface ReportCard {
  code: number; name: string; prerelease: boolean; image: string;
  tcgDate?: string; ocgDate?: string;
}
interface CardGroup {
  name: string; code?: string; tcgDate?: string; ocgDate?: string;
  cards: ReportCard[];
}
interface ReleasedSetPreview {
  code: string; name: string; tcgDate: string; cards: number[]; files: string[];
}
export interface CardUpdate {
  comparisonAvailable: boolean;
  metadataUnavailable: boolean;
  added: CardGroup[];
  removed: ReportCard[];
  graduated: Array<ReportCard & { oldCode: number; oldName: string }>;
  /** Previous rows still in the candidate preview pool, before script smoke. */
  retainedPreviews?: ReportCard[];
  /** Advisory upstream status, independent of additions or prepare-time exclusions. */
  releasedSets?: ReleasedSetPreview[];
  releasedSetMetadataUnavailable?: boolean;
}
const byName = (a: ReportCard, b: ReportCard) => a.name.localeCompare(b.name, "en") || a.code - b.code;
const productCode = (code: string) => code.split("-")[0]!.toUpperCase();
const date = (value?: string) => typeof value === "string" && /^[1-9]\d{3}-\d{2}-\d{2}$/.test(value) &&
  Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value ? value : undefined;
const sourceCode = (file: string) => /^(?:release|prerelease)-(.+?)(?:-en)?\.cdb$/i.exec(file)?.[1]?.toUpperCase();
const identity = (card: SourceCard) => `${card.name.trim().toLowerCase()}\0${card.type}`;
function reportCard(card: SourceCard, prerelease: boolean, info?: ApiCard): ReportCard {
  const misc = Array.isArray(info?.misc_info) ? info.misc_info.find(value => value && typeof value === "object") : undefined;
  const image = Array.isArray(info?.card_images) ? info.card_images.find(image => image?.id === card.code)?.image_url : undefined;
  return { code: card.code, name: card.name, prerelease,
    image: prerelease && card.code >= 100_000_000 ? `${PROJECT_IGNIS_IMAGE_URL}/${card.code}.jpg`
      : trustedCardImageUrl(image, `https://images.ygoprodeck.com/images/cards/${card.code}.jpg`),
    tcgDate: date(misc?.tcg_date), ocgDate: date(misc?.ocg_date) };
}

/** CDB rows determine membership/names. Public catalogs only enrich the display;
 * two bounded requests avoid per-card rate limits and unknown-ID batch failures. */
export async function cardUpdate(previous: CardSnapshot | null, next: CardSnapshot, request: typeof fetch = fetch,
  today = new Date().toISOString().slice(0, 10)): Promise<CardUpdate> {
  const changes: CardUpdate = { comparisonAvailable: previous !== null, metadataUnavailable: false, added: [], removed: [], graduated: [],
    releasedSets: [], releasedSetMetadataUnavailable: false };
  previous ??= { released: [], prerelease: [], remaps: {} };
  const oldCards = [...previous.released, ...previous.prerelease];
  const nextCards = [...next.released, ...next.prerelease];
  const oldPreviewCodes = new Set(previous.prerelease.map(card => card.code)), previewCodes = new Set(next.prerelease.map(card => card.code));
  const retainedPreviews = oldCards.filter(card => previewCodes.has(card.code));
  const oldCodes = new Set(oldCards.map(card => card.code)), nextCodes = new Set(nextCards.map(card => card.code));
  const released = new Map(next.released.map(card => [card.code, card]));
  const mainReleased = new Map(next.released.filter(card => !card.alias && !(card.type & 0x4000)).map(card => [identity(card), card]));
  const graduations = previous.prerelease.flatMap(card => {
    const target = released.get(card.code) ?? released.get(next.remaps[card.code]!) ??
      (!card.alias && !(card.type & 0x4000) ? mainReleased.get(identity(card)) : undefined);
    return target && !next.prerelease.some(candidate => candidate.code === card.code) ? [{ old: card, target }] : [];
  });
  const graduatedCodes = new Set(graduations.map(card => card.old.code));
  const added = nextCards.filter(card => !oldCodes.has(card.code));
  const removed = oldCards.filter(card => !nextCodes.has(card.code) && !graduatedCodes.has(card.code));
  if (!added.length && !removed.length && !graduations.length && !next.prerelease.length) {
    changes.retainedPreviews = retainedPreviews.map(card => reportCard(card, oldPreviewCodes.has(card.code)));
    return changes;
  }

  async function json(endpoint: string): Promise<unknown> {
    const response = await request(`https://db.ygoprodeck.com/api/v7/${endpoint}`, { signal: AbortSignal.timeout(15_000) });
    if (!response.ok) { await response.body?.cancel(); throw new Error(`Metadata HTTP ${response.status}`); }
    return response.json();
  }
  const [setsResult, cardsResult] = await Promise.allSettled([json("cardsets.php"), json("cardinfo.php?misc=yes")]);
  const sets = new Map<string, Product>(), cards = new Map<number, ApiCard>();
  if (setsResult.status === "fulfilled" && Array.isArray(setsResult.value)) {
    for (const set of setsResult.value) {
      if (set && typeof set.set_code === "string" && typeof set.set_name === "string") sets.set(productCode(set.set_code), set);
      else { changes.metadataUnavailable = true; changes.releasedSetMetadataUnavailable = true; }
    }
  } else { changes.metadataUnavailable = true; changes.releasedSetMetadataUnavailable = true; }
  const data = cardsResult.status === "fulfilled" ? (cardsResult.value as { data?: unknown } | null)?.data : undefined;
  if (Array.isArray(data)) {
    for (const entry of data) {
      if (!entry || !Number.isSafeInteger(entry.id)) { changes.metadataUnavailable = true; continue; }
      cards.set(entry.id, entry);
      if (Array.isArray(entry.card_images)) for (const image of entry.card_images) if (image && Number.isSafeInteger(image.id)) cards.set(image.id, entry);
    }
    // Explicit API beta IDs are metadata aliases only, never passcode remaps.
    for (const entry of data) if (entry && Array.isArray(entry.misc_info)) for (const misc of entry.misc_info) {
      if (misc && Number.isSafeInteger(misc.beta_id) && !cards.has(misc.beta_id)) cards.set(misc.beta_id, entry);
    }
  } else changes.metadataUnavailable = true;

  // Merge-selected previews have no released counterpart. Check again so callers
  // with unreconciled snapshots cannot report a graduated card as waiting.
  const releasedCodes = new Set(next.released.map(card => card.code));
  const pendingSets = new Map<string, ReleasedSetPreview>();
  for (const card of next.prerelease) {
    if (releasedCodes.has(card.code) || (!card.alias && !(card.type & 0x4000) && mainReleased.has(identity(card)))) continue;
    const source = sourceCode(card.file);
    const printings = cards.get(card.code)?.card_sets;
    const codes = source && source !== "OTHERS" && source !== "CARDS" ? [source]
      : Array.isArray(printings) ? printings.filter(set => typeof set?.set_code === "string").map(set => productCode(set.set_code)) : [];
    if (!codes.length && !Array.isArray(data)) changes.releasedSetMetadataUnavailable = true;
    for (const code of new Set(codes)) {
      const product = sets.get(code), tcgDate = date(product?.tcg_date);
      if (!product || !tcgDate || tcgDate > today) continue;
      const group = pendingSets.get(code) ?? { code, name: product.set_name, tcgDate, cards: [], files: [] };
      if (!group.cards.includes(card.code)) group.cards.push(card.code);
      if (!group.files.includes(card.file)) group.files.push(card.file);
      pendingSets.set(code, group);
    }
  }
  changes.releasedSets = [...pendingSets.values()].sort((a, b) => a.code.localeCompare(b.code, "en"));
  for (const group of changes.releasedSets) { group.cards.sort((a, b) => a - b); group.files.sort(); }
  if (!changes.comparisonAvailable) return changes;

  const enrich = (card: SourceCard, prerelease: boolean) => reportCard(card, prerelease, cards.get(card.code));
  const groups = new Map<string, CardGroup>();
  for (const card of added) {
    const info = cards.get(card.code);
    const printings = Array.isArray(info?.card_sets) ? info.card_sets.filter(set => set && typeof set.set_code === "string" && typeof set.set_name === "string") : [];
    let code = sourceCode(card.file);
    // Generic preview files are not product codes. Use the first known printing
    // (earliest catalog date) for base/generic rows, without duplicating reprints.
    if (code === "OTHERS" || code === "CARDS") code = undefined;
    const first = [...printings].sort((a, b) => (date(sets.get(productCode(a.set_code))?.tcg_date) ?? "9999")
      .localeCompare(date(sets.get(productCode(b.set_code))?.tcg_date) ?? "9999"))[0];
    code ??= first ? productCode(first.set_code) : undefined;
    const product = code ? sets.get(code) : undefined;
    const printing = printings.find(set => productCode(set.set_code) === code);
    const prerelease = previewCodes.has(card.code);
    const name = product?.set_name ?? printing?.set_name ?? (code ? `Set ${code}` : prerelease ? "Other pre-release cards" : "Unknown product set");
    const key = code ?? name;
    const group = groups.get(key) ?? { code, name, tcgDate: date(product?.tcg_date), ocgDate: date(product?.ocg_date), cards: [] };
    group.cards.push(enrich(card, prerelease)); groups.set(key, group);
  }
  changes.added = [...groups.values()].sort((a, b) => (a.code ?? a.name).localeCompare(b.code ?? b.name, "en"));
  for (const group of changes.added) group.cards.sort(byName);
  changes.retainedPreviews = retainedPreviews.map(card => enrich(card, oldPreviewCodes.has(card.code)));
  changes.removed = removed.map(card => enrich(card, oldPreviewCodes.has(card.code))).sort((a, b) => a.code - b.code);
  changes.graduated = graduations.map(({ old, target }) => ({ ...enrich(target, false), oldCode: old.code, oldName: old.name })).sort((a, b) => a.oldCode - b.oldCode);
  return changes;
}

/** Deferred validation uses its exact smoke exclusions, with no second lookup. */
export function withPreviewExclusions(changes: CardUpdate, excluded: number[]): CardUpdate {
  const codes = new Set(excluded);
  const removed = new Map(changes.removed.map(card => [card.code, card]));
  for (const card of changes.retainedPreviews ?? []) if (codes.has(card.code) && !removed.has(card.code)) removed.set(card.code, card);
  return { ...changes, added: changes.added.map(group => ({ ...group, cards: group.cards.filter(card => !card.prerelease || !codes.has(card.code)) })).filter(group => group.cards.length),
    removed: [...removed.values()].sort((a, b) => a.code - b.code) };
}
const safe = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/@|#(?=\d)/g, match => match === "@" ? "&#64;" : "&#35;").replace(/[\\`*_{}\[\]|]/g, "\\$&").replace(/[\r\n]+/g, " ");
const attribute = (value: string) => value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
// GitHub renders summary contents as HTML text; Markdown backslashes are literal.
const summaryText = (value: string) => attribute(value).replace(/[@#\\`*_{}\[\]|]/g,
  character => `&#${character.charCodeAt(0)};`).replace(/[\r\n]+/g, " ");
export function renderReleasedSets(changes: CardUpdate): string {
  const lines = ["## Released TCG sets still in pre-release CDBs", "",
    "Product release dates use YGOPRODeck cardsets.php tcg_date through today (UTC). These cards still wait for Ignis to move them into released CDB rows; this note does not trigger a bump by itself.", ""];
  if (changes.releasedSetMetadataUnavailable) lines.push("Released-set metadata unavailable (best effort); this list may be incomplete.", "");
  const sets = changes.releasedSets ?? [];
  if (!sets.length && !changes.releasedSetMetadataUnavailable) lines.push("No released TCG sets found with cards only in upstream pre-release CDBs.", "");
  for (const set of sets) lines.push(`- ${safe(set.name)} (${safe(set.code)}) — TCG release: ${set.tcgDate}; ${set.cards.length} cards — ${set.files.map(file => `\`${safe(file)}\``).join(", ")}`);
  return lines.join("\n") + "\n";
}
function cardLine(card: ReportCard, old?: { oldCode: number; oldName: string }): string {
  const dates = [card.tcgDate ? `TCG first release: ${card.tcgDate}` : "", card.ocgDate ? `OCG first release: ${card.ocgDate}` : ""].filter(Boolean);
  return `- <img src="${attribute(card.image)}" width=80 alt="Card ${card.code}"> ${safe(card.name)} — \`${old ? `${old.oldCode} → ${card.code}` : card.code}\`${card.prerelease ? " — **pre-release**" : ""}${old && old.oldName !== card.name ? ` (previously ${safe(old.oldName)})` : ""}${dates.length ? ` — ${dates.join("; ")}` : ""}`;
}
export function renderCardUpdate(changes: CardUpdate): string {
  const lines = ["## New cards in this update", ""];
  if (!changes.comparisonAvailable) return [...lines, "The previous snapshot is unavailable. Card additions, removals and graduations could not be determined.", ""].join("\n");
  const count = changes.added.reduce((total, group) => total + group.cards.length, 0);
  lines.push(`Added cards: ${count}. Removed cards: ${changes.removed.length}. Graduated pre-release cards: ${changes.graduated.length}.`, "");
  if (changes.metadataUnavailable) lines.push("YGOPRODeck metadata unavailable (best effort); names and source set codes come from the CDB. Unknown release dates are omitted.", "");
  if (!count) lines.push("No new cards.", "");
  for (const group of changes.added) {
    const label = group.code && group.name !== `Set ${group.code}` ? `${group.name} (${group.code})` : group.name;
    const dates = [group.tcgDate ? `TCG release: ${group.tcgDate}` : "", group.ocgDate ? `OCG release: ${group.ocgDate}` : ""].filter(Boolean);
    lines.push("<details>", `<summary>${summaryText(label)} — ${group.cards.length} cards</summary>`, "",
      dates.length ? dates.join("; ") + "." : "Product release date unknown.", "", ...group.cards.map(card => cardLine(card)), "", "</details>", "");
  }
  lines.push(`### Removed cards (${changes.removed.length})`, "", ...(changes.removed.length ? changes.removed.map(card => cardLine(card)) : ["None."]), "",
    `### Graduated pre-release cards (${changes.graduated.length})`, "", ...(changes.graduated.length ? changes.graduated.map(card => cardLine(card, card)) : ["None."]), "");
  return lines.join("\n");
}
export function withCardUpdate(report: string, changes: CardUpdate): string {
  return report.replace(/## New cards in this update\n[\s\S]*?(?=\n## |$)/, () => renderCardUpdate(changes));
}

/** Remove whole rows, then empty set blocks, preserving valid details/images. */
export function boundCardUpdate(section: string, runUrl: string, budget: number): string {
  if (Buffer.byteLength(section) <= budget) return section;
  const rows = section.split("\n").filter(line => line.startsWith("- <img ")).length;
  const notice = (omitted: number) => `\n[${omitted} more, see the report artifact](${runUrl}#artifacts).\n`;
  const render = (keep: number) => {
    let seen = 0;
    const trimmed = section.split("\n").filter(line => !line.startsWith("- <img ") || ++seen <= keep).join("\n")
      .replace(/<details>\n[\s\S]*?<\/details>\n?/g, block => block.includes("- <img ") ? block : "");
    return trimmed + notice(rows - keep);
  };
  let low = 0, high = rows;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(render(middle)) <= budget) low = middle; else high = middle - 1;
  }
  const result = render(low);
  return Buffer.byteLength(result) <= budget ? result : `## New cards in this update\n${notice(rows)}`;
}
