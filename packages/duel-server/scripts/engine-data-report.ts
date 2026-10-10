import { readFile } from "node:fs/promises";
import { SCRIPT_ENGINE_KINDS, type ScriptEngineKind } from "../src/card-script-hash.js";
import type { ProdScriptErrorSnapshot } from "../src/prod-script-errors.js";
import { boundCardUpdate } from "./engine-data-card-report.js";

/** Bound GitHub-rendered copies; the artifact always retains the complete report. */
export function boundedReport(report: string, runUrl: string, maxBytes: number): string {
  if (Buffer.byteLength(report) <= maxBytes) return report;
  const warnings = report.match(/\n## Deployment\n[\s\S]*?(?=\n## |$)/)?.[0] ?? "";
  const golden = report.match(/\n## Golden hashes\n[\s\S]*?(?=\n## |$)/)?.[0] ?? "";
  const artwork = report.match(/\n## Artwork script safety\n[\s\S]*?(?=\n## |$)/)?.[0] ?? "";
  const patches = report.match(/\n## Card script patches\n[\s\S]*?(?=\n## |$)/)?.[0] ?? "";
  const smoke = report.match(/\n## Prerelease script safety\n[\s\S]*?(?=\n## |$)/)?.[0] ?? "";
  const notice = `\n\n_Report truncated. Full report: [run summary](${runUrl}#summary) and [engine-data-update-report artifact](${runUrl}#artifacts)._\n`;
  const prefix = (value: string, budget: number) => {
    const bytes = Buffer.from(value);
    let end = Math.max(0, Math.min(bytes.length, budget));
    while (end > 0 && end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
    return bytes.subarray(0, end).toString("utf8");
  };
  const prod = report.match(/\n## Script errors in prod \(last 7 days\)\n[\s\S]*?(?=\n## |$)/)?.[0] ?? "";
  const relevance = report.match(/\n## Relevance gate\n[\s\S]*?(?=\n## |$)/)?.[0] ?? "";
  const releasedSets = report.match(/\n## Released TCG sets still in pre-release CDBs\n[\s\S]*?(?=\n## |$)/)?.[0] ?? "";
  const sections = [warnings, golden, artwork, patches, smoke, prod, relevance, releasedSets].filter(Boolean);
  const sectionLimit = Math.floor(Math.max(0, maxBytes - Buffer.byteLength(notice)) / (2 * Math.max(1, sections.length)));
  const limited = sections.map(section => {
    if (Buffer.byteLength(section) <= sectionLimit) return section;
    const suffix = "\n_Findings truncated; see the full report artifact._\n";
    return prefix(section, Math.max(0, sectionLimit - Buffer.byteLength(suffix))) + prefix(suffix, sectionLimit);
  });
  const footer = prefix(notice + limited.join(""), maxBytes);
  const prefixBudget = maxBytes - Buffer.byteLength(footer);
  const cards = /\n## New cards in this update\n[\s\S]*?(?=\n## |$)/.exec(report);
  if (cards) {
    // Reserve room for later findings; never byte-cut a set's details/image HTML.
    const available = Math.max(0, prefixBudget - Buffer.byteLength(report.slice(0, cards.index)));
    report = report.replace(cards[0], () => "\n" + boundCardUpdate(cards[0].slice(1), runUrl, Math.floor(available / 2)));
  }
  return prefix(report, prefixBudget) + footer;
}

type Probe = { artworkScriptScanError?: string; artworkScriptFallbacks?: Array<{ passcode: number; main: number; requested?: number }>; errors: string[]; scriptsChecked: number; apiSymbolsChecked: number; globalsChecked: number; cardsChecked: number };
const safe = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/@|#(?=\d)/g, (match) => match === "@" ? "&#64;" : "&#35;").replace(/`/g, "\\`").replace(/[\r\n]+/g, " ");

/** Accept only the fixed export shape; bad, missing or oversized snapshots are optional data. */
export async function readProdScriptErrors(path: string): Promise<ProdScriptErrorSnapshot | null> {
  try {
    const bytes = await readFile(path);
    if (bytes.length > 65536) return null;
    const value = JSON.parse(bytes.toString("utf8"));
    if (value.available !== true || !Array.isArray(value.cards) || value.cards.length > 100) return null;
    const integer = (n: unknown) => Number.isSafeInteger(n) && (n as number) >= 0;
    if (value.cards.some((card: any) => !integer(card.code) || card.code === 0 || card.code > 0xffffffff ||
      typeof card.name !== "string" || card.name.length > 200 || !integer(card.distinctDuels) || !integer(card.errorCount) ||
      card.distinctDuels > card.errorCount || typeof card.autoBlocked !== "boolean" || (card.engineKind !== undefined && !SCRIPT_ENGINE_KINDS.includes(card.engineKind)) ||
      (card.helperScripts !== undefined && (!Array.isArray(card.helperScripts) || card.helperScripts.length > 64 ||
        card.helperScripts.some((name: unknown) => typeof name !== "string" || !/^[A-Za-z0-9_.-]{1,128}\.lua$/.test(name) || /^c\d+\.lua$/.test(name)))) ||
      (card.scriptHash !== null && (typeof card.scriptHash !== "string" || !/^[a-f0-9]{64}$/.test(card.scriptHash))))) return null;
    return { available: true, cards: value.cards.map((card: any) => ({ code: card.code, name: card.name,
      distinctDuels: card.distinctDuels, errorCount: card.errorCount, autoBlocked: card.autoBlocked, scriptHash: card.scriptHash,
      ...(card.engineKind ? { engineKind: card.engineKind } : {}), ...(card.helperScripts ? { helperScripts: card.helperScripts } : {}) })), truncated: value.truncated === true };
  } catch { return null; }
}

export function prodScriptErrorReport(snapshot: ProdScriptErrorSnapshot | null, candidateHash?: (code: number, kind?: ScriptEngineKind, helperScripts?: readonly string[]) => string | null): string {
  const heading = "## Script errors in prod (last 7 days)";
  if (!snapshot?.available) return `${heading}\n\nprod error data unavailable\n`;
  const lines = [heading, "", "Top 20 cards by sampled error count, plus active auto blocks (including cards with no recent errors). Counts retain the 20-sample per-duel/card telemetry cap. Manual blocks remain in force after an auto block lifts.", "",
    "| Code | Card | Distinct duels | Errors | Auto blocked | Script changed in this update |",
    "| --- | --- | ---: | ---: | --- | --- |"];
  let omitted = snapshot.truncated ?? false;
  // Prioritize auto blocks when a very large snapshot would exceed the rendered section cap.
  for (const card of [...snapshot.cards].sort((a, b) => Number(b.autoBlocked) - Number(a.autoBlocked) || b.errorCount - a.errorCount || a.code - b.code)) {
    const changed = candidateHash ? candidateHash(card.code, card.engineKind, card.helperScripts) !== card.scriptHash : null;
    const status = changed === null ? "Comparison unavailable" : changed ? `Yes${card.autoBlocked ? " — auto block will lift" : ""}` : "No";
    const name = safe(card.name).replace(/[\\*_{}\[\]|]/g, "\\$&");
    const line = `| ${card.code} | ${name}${card.engineKind && card.engineKind !== "all" ? ` (${card.engineKind})` : ""} | ${card.distinctDuels} | ${card.errorCount} | ${card.autoBlocked ? "Yes" : "No"} | ${status} |`;
    if (Buffer.byteLength([...lines, line].join("\n")) > 11800) { omitted = true; break; }
    lines.push(line);
  }
  if (!snapshot.cards.length) lines.push("", omitted ? "No matching cards found within the capped scan." : "No script errors or active auto blocks found.");
  if (omitted) lines.push("", "Prod card list truncated by the export or section size cap.");
  return lines.join("\n") + "\n";
}
export function withValidation(report: string, probe: Probe, overlayExit: number | "not run", overlayLog?: string): string {
  const section = ["## Core compatibility", "",
    "Best effort: installed **npm ocgcore-wasm@0.1.2**, the oldest live/default production Standard 1v1 core. Candidate constant.lua, utility.lua and changed Lua are loaded; generated assertions check Duel./Card./Effect./Group. names and uppercase globals. New/changed official cards are inserted into a deck to exercise initial_effect. Findings are advisory, not a compatibility guarantee or full effect playthrough.", "",
    `Checked ${probe.scriptsChecked} scripts, ${probe.apiSymbolsChecked} API names, ${probe.globalsChecked} globals and ${probe.cardsChecked} cards. Probe errors: ${probe.errors.length}.`, "",
    ...(probe.errors.length ? probe.errors.map((error) => `- ${safe(error)}`) : ["No probe errors found."]), "",
  ].join("\n");
  let result = report.replace(/probe errors [^,\n]+, overlay check exit [^\n]+/, `probe errors ${probe.errors.length}, overlay check exit ${overlayExit}`)
    .replace(/## Core compatibility\n[\s\S]*?(?=\n## |$)/, section);
  if (overlayLog !== undefined) {
    result += `\n## Overlay generator check\n\nExit code: ${overlayExit} (0 = passed; otherwise human review required).\n\n${overlayLog.split(/\r?\n/).map((line) => `    ${line}`).join("\n")}\n\nThis check does not replace stock-hash conflict review.\n`;
  }
  const fallbacks = probe.artworkScriptFallbacks ?? [];
  result += "\n## Artwork script safety\n\n";
  if (probe.artworkScriptScanError) {
    result = `BLOCKING: artwork script safety scan failed.\n${result}`;
    result += `BLOCKING: scan failed: ${safe(probe.artworkScriptScanError)}\n`;
  } else if (fallbacks.length) {
    const blocking = `BLOCKING: ${fallbacks.length} artwork script fallback(s).`;
    result = `${blocking}\n${result}`;
    result += `${blocking} The core keeps the alternate self_code, so GetID() differs from the main script's context. Supply and validate explicit artwork scripts before publishing this bundle.\n\n`;
    result += fallbacks.map(({ passcode, main, requested = passcode }) => `- c${requested}.lua → c${main}.lua${requested === passcode ? "" : ` (card ${passcode})`}`).join("\n") + "\n";
  } else result += "No artwork script fallbacks found.\n";
  return result;
}

type PreviewIdentity = import("./prerelease-history.js").CardIdentity;
/** Card-level review survives filename deletion and temporary-to-official ID changes. */
export function prereleaseUpdateReport(previous: PreviewIdentity[] | null, next: {
  prerelease: PreviewIdentity[]; released: PreviewIdentity[]; remaps: Record<string, number>;
  drops: Array<PreviewIdentity & { file: string; reason: string; keptCode?: number }>;
  unmatched?: import("./prerelease-graduations.js").UnmatchedGraduation[];
}, previousReleased: PreviewIdentity[] = []): string {
  const dropLines = [`Dropped prerelease rows (${next.drops.length})`, "",
    ...(next.drops.length ? next.drops.map(card => `- ${card.code}${card.keptCode ? ` → ${card.keptCode}` : ""} ${safe(card.name)} (${safe(card.file)}): ${safe(card.reason)}`) : ["None."]), ""];
  const reviewLines = ["Unmatched graduations, needs review", "",
    ...((next.unmatched?.length ?? 0) ? next.unmatched!.map(card => `- ${card.code} ${safe(card.name)} — unmatched graduation, needs review${card.candidates.length ? `; candidates: ${card.candidates.join(", ")}` : ""}`) : ["None."]), ""];
  if (previous === null) return ["## Prerelease cards", "",
    "The previous snapshot is ambiguous. Additions, removals and graduations could not be determined; candidate preparation and validation continue.", "", ...dropLines, ...reviewLines].join("\n");
  const key = (card: PreviewIdentity) => `${card.name.trim().toLowerCase()}\0${card.type}`;
  const official = new Map(next.released.filter(card => !card.alias && (card.type & 0x4000) === 0).map(card => [key(card), card]));
  const releasedIds = new Set(next.released.map(card => card.code));
  const oldIds = new Set(previous.map(card => card.code)), newIds = new Set(next.prerelease.map(card => card.code));
  const added = next.prerelease.filter(card => !oldIds.has(card.code));
  const gone = previous.filter(card => !newIds.has(card.code));
  const isGraduated = (card: PreviewIdentity) => releasedIds.has(card.code) || releasedIds.has(next.remaps[card.code]!) ||
    (!card.alias && (card.type & 0x4000) === 0 && official.has(key(card)));
  const graduated = gone.filter(isGraduated);
  const removed = gone.filter(card => !isGraduated(card));
  const unmapped = gone.filter(card => !releasedIds.has(card.code) && next.remaps[card.code] === undefined);
  const previousReleasedIds = new Set(previousReleased.map(card => card.code));
  const newReleased = [...official.values()].filter(card => !previousReleasedIds.has(card.code));
  const stats = ["type", "atk", "def", "level", "attribute"] as const;
  const missingLines = unmapped.length ? unmapped.map(card => {
    const matches = card.alias || (card.type & 0x4000) !== 0 ? [] : newReleased.filter(candidate =>
      stats.every(field => typeof card[field] === "number" && candidate[field] === card[field]));
    return `- ${card.code} ${safe(card.name)}${matches.length ? ` — unmatched graduation, needs review; possible new released matches (same type/ATK/DEF/level/attribute): ${matches.map(candidate => `${candidate.code} ${safe(candidate.name)}`).join(", ")}` : ""}`;
  }) : ["None."];
  const lines = (cards: PreviewIdentity[], target = false) => cards.length ? cards.map(card =>
    `- ${card.code}${target ? ` → ${next.remaps[card.code] ?? (releasedIds.has(card.code) ? card.code : official.get(key(card))!.code)}` : ""} ${safe(card.name)}`) : ["None."];
  return ["## Prerelease cards", "", `Added prerelease cards (${added.length})`, "", ...lines(added), "",
    `Removed prerelease cards (${removed.length})`, "", ...lines(removed), "",
    `Graduated prerelease cards (${graduated.length})`, "", ...lines(graduated,true), "",
    `Removed preview codes with no remap (${unmapped.length})`, "", ...missingLines, "", ...dropLines, ...reviewLines,
    "The bundle retains historical remaps. Disappeared codes without a remap remain saved and are reported as unknown/illegal. Only unique same-bump stats and exact self-name-normalized text matches are inferred for renamed/type-changed cards. Uncertain suggestions require human review and a validated override.", ""].join("\n");
}

export interface PrereleaseScriptSafety {
  checked: number;
  excluded: Array<{ code: number; name: string; file: string; errors: string[] }>;
  suppressedRemaps: Array<{ old: number; target: number }>;
}
export function prereleaseScriptReport(smoke: PrereleaseScriptSafety): string {
  return ["## Prerelease script safety", "",
    `Prepare-time smoke: registered ${smoke.checked} prerelease cards on npm ocgcore-wasm@0.1.2; excluded ${smoke.excluded.length}. Released cards are never excluded by this check.`, "",
    ...(smoke.excluded.length ? smoke.excluded.map(card => `- ${card.code} ${safe(card.name)} (${safe(card.file)}): excluded: script error — ${card.errors.map(safe).join("; ")}`) : ["No prerelease script errors found."]), "",
    ...(smoke.suppressedRemaps.length ? ["Remap destinations excluded; these saved source codes remain unknown:", "", ...smoke.suppressedRemaps.map(remap => `- ${remap.old} → ${remap.target}`), ""] : []),
    "Registration checks script loading and initial_effect only. Later effect callbacks remain outside this smoke check.", ""].join("\n");
}
export function withPrereleaseSmoke(report: string, smoke: PrereleaseScriptSafety): string {
  const section = prereleaseScriptReport(smoke);
  return report.includes("## Prerelease script safety\n") ? report.replace(/## Prerelease script safety\n[\s\S]*?(?=\n## |$)/, section) : `${report}\n${section}`;
}
