/** Scheduled card-data updates only. Core, Lua, WASM and toolchain pins are never advanced here. */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import Database from "better-sqlite3";
import { smokePrereleaseScripts } from "./prerelease-script-smoke.js";
import { applyPrereleaseSmokeResult } from "./prerelease-script-exclusions.js";
import { installCardScriptPatches } from "./card-script-patches.js";
import { probeEngineData } from "./probe-engine-data.js";
import { withValidation, prereleaseUpdateReport, prereleaseScriptReport, prodScriptErrorReport } from "./engine-data-report.js";
import { cardUpdate, renderCardUpdate, renderReleasedSets, withPreviewExclusions, withCardUpdate } from "./engine-data-card-report.js";
import { listIndex, reconcile, scanText } from "./scan-multiplayer-scripts.js";
import { discoverReleasedDatabases, downloadReleasedCardData, restrictPrereleaseScripts } from "./released-card-data.js";
import { compareLoadedData, loadedScriptTree, readCardRows, renderRelevantChanges } from "./engine-data-relevance.js";
import { CardRemapValidationError } from "./prerelease-graduations.js";

export type Pins = { scripts: string; database: string; strings: string };
const repositories: Record<keyof Pins, string> = { scripts: "CardScripts", database: "BabelCDB", strings: "Distribution" };
const keys = Object.keys(repositories) as (keyof Pins)[];
const packagePath = "packages/duel-server";
const preparePath = `${packagePath}/scripts/prepare-data.ts`;
const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const sha256 = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const official = (path: string) => /^official\/c\d+\.lua$/.test(path);
const codeOf = (path: string) => Number(/c(\d+)\.lua$/.exec(path)?.[1]);
const sorted = (paths: string[]) => paths.sort((a, b) => codeOf(a) - codeOf(b));
const markdown = (value: string) => value.replace(/[\\`*_{}\[\]<>|]/g, "\\$&").replace(/@|#(?=\d)/g, (match) => match === "@" ? "&#64;" : "&#35;").replace(/[\r\n]+/g, " ");

export async function readPins(root: string): Promise<Pins> {
  const text = await readFile(join(root, preparePath), "utf8");
  return Object.fromEntries(keys.map((key) => {
    const value = new RegExp(`["']?\\b${key}\\b["']?\\s*:\\s*["']([a-f0-9]{40})["']`).exec(text)?.[1];
    if (!value) throw new Error(`Missing ${key} pin in ${preparePath}`);
    return [key, value];
  })) as Pins;
}

export function diffScripts(oldTree: Map<string, string>, newTree: Map<string, string>) {
  return {
    added: sorted([...newTree.keys()].filter((p) => official(p) && !oldTree.has(p))),
    changed: sorted([...newTree.keys()].filter((p) => official(p) && oldTree.has(p) && oldTree.get(p) !== newTree.get(p))),
    removed: sorted([...oldTree.keys()].filter((p) => official(p) && !newTree.has(p))),
  };
}

type OverlayCard = { code: number; file: string; name?: string; stockPath?: string; stockSha256?: string };
export function detectOverlayConflicts(cards: OverlayCard[], stock: Map<string, string>) {
  return cards.flatMap((card) => {
    const text = stock.get(card.stockPath ?? `official/${card.file}`);
    const actualSha256 = text === undefined ? null : sha256(text);
    return actualSha256 === card.stockSha256 ? [] : [{ ...card, actualSha256 }];
  });
}

export function findNewRisks(stock: Map<string, string>, paths: string[], listed = new Set(listIndex().keys()), releaseCodes: ReadonlySet<number> = new Set()) {
  return [...new Set(paths)].filter(path => official(path) ||
    (/^pre-release\/c\d+\.lua$/.test(path) && releaseCodes.has(codeOf(path)) && !stock.has(`official/c${codeOf(path)}.lua`)))
    .map((path) => scanText(codeOf(path), stock.get(path)!))
    .filter((card) => card.flagged && !listed.has(card.code));
}

// Keep the cardScripts records used by both deterministic core builds in sync with the bundle.
export const PIN_FILES = [preparePath, `${packagePath}/domain-core/pins.json`, `${packagePath}/legacy-1v1/domain-core/pins.json`] as const;
/** Fail before any writes if a data SHA leaks into another tracked file. */
export async function rewritePins(root: string, old: Pins, next: Pins, dryRun: boolean): Promise<string[]> {
  const replacements = new Map(keys.filter((key) => old[key] !== next[key]).map((key) => [old[key], next[key]]));
  if (!replacements.size) return [];
  const pattern = new RegExp(`\\b(?:${[...replacements.keys()].join("|")})\\b`, "g");
  const paths = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean);
  const changes: { path: string; content: string }[] = [];
  for (const path of paths) {
    const bytes = await readFile(join(root, path));
    if (!(PIN_FILES as readonly string[]).includes(path) && keys.some((key) => bytes.includes(old[key]))) {
      throw new Error(`Refusing to rewrite pin outside allowlist: ${path}`);
    }
    if (bytes.includes(0)) continue;
    const original = bytes.toString("utf8");
    const content = original.replace(pattern, (sha) => replacements.get(sha)!);
    if (original === content) continue;
    changes.push({ path, content });
  }
  if (!dryRun) for (const change of changes) await writeFile(join(root, change.path), change.content);
  return changes.map(({ path }) => path);
}

type Options = {
  root?: string;
  overrides?: Partial<Pins>;
  dryRun?: boolean;
  report?: string;
  request?: typeof fetch;
  token?: string;
  validate?: boolean;
};
type Tree = { truncated: boolean; tree: { path: string; type: string; sha: string }[] };

export function findListedChanges(stock: Map<string, string>, paths: string[], overlays: Set<number>) {
  const listed = listIndex();
  const changed = new Set(paths.filter(official).map(codeOf));
  const scans = [...stock].filter(([path]) => official(path) && listed.has(codeOf(path)))
    .map(([path, source]) => scanText(codeOf(path), source));
  const gaps = new Set(reconcile(scans).formatGap.map((card) => card.code));
  return [...listed].filter(([code]) => (changed.has(code) && !overlays.has(code)) || gaps.has(code))
    .map(([code, entry]) => ({ code, ...entry, changed: changed.has(code), formatGap: gaps.has(code) }));
}

export function githubOutput(result: { changed: boolean; next: Pins; files: string[] }): string {
  return [`changed=${result.changed}`, ...keys.map((key) => `${key}=${result.next[key]}`), `files=${JSON.stringify(result.files)}`, ""].join("\n");
}

export async function runUpdate(options: Options = {}) {
  const root = resolve(options.root ?? repoRoot);
  const reportPath = resolve(root, options.report ?? ".status/engine-data-update.md");
  const overrides = options.overrides ?? {};
  for (const [key, sha] of Object.entries(overrides)) {
    if (!/^[a-fA-F0-9]{40}$/.test(sha)) throw new Error(`--${key} must be a full 40-character hexadecimal commit SHA`);
  }
  const old = await readPins(root);
  const request = options.request ?? fetch;
  const token = options.token ?? process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
  async function download(url: string) {
    const headers: Record<string, string> = { "User-Agent": "yugidraft-engine-data-update" };
    if (new URL(url).hostname === "api.github.com") {
      headers.Accept = "application/vnd.github+json";
      headers["X-GitHub-Api-Version"] = "2022-11-28";
      if (token) headers.Authorization = `Bearer ${token}`;
    }
    const response = await request(url, { headers, signal: AbortSignal.timeout(120_000) });
    if (!response.ok) throw new Error(`Download failed (${response.status}): ${url}`);
    return response;
  }
  const api = async <T>(path: string): Promise<T> => (await download(`https://api.github.com/repos/ProjectIgnis/${path}`)).json() as Promise<T>;
  const next = Object.fromEntries(await Promise.all(keys.map(async (key) => {
    const sha = overrides[key]?.toLowerCase() ?? (await api<{ sha: string }[]>(`${repositories[key]}/commits?per_page=1`))[0]?.sha;
    if (!sha || !/^[a-f0-9]{40}$/.test(sha)) throw new Error(`Invalid upstream ${key} commit`);
    return [key, sha];
  }))) as Pins;
  const changed = keys.some((key) => old[key] !== next[key]);
  const report = ["Needs review: 0 conflicts, 0 risks, 0 shared-script changes, probe errors not run, overlay check exit not run", "", "# Project Ignis engine data update", "", `Mode: ${options.dryRun ? "dry run (pins unchanged)" : "update"}. Rules core, ocgcore-wasm, Lua and Emscripten pins remain unchanged.`, ""];
  async function saveReport() {
    await mkdir(dirname(reportPath), { recursive: true });
    // Append after the existing sections, including the unheaded repository comparison table.
    // Final validation replaces this optional section using the exact prepared candidate bundle.
    await writeFile(reportPath, report.join("\n") + "\n\n" + prodScriptErrorReport(null));
  }
  if (!changed) {
    const empty = { released: [], prerelease: [], remaps: {} };
    report.push(renderCardUpdate(await cardUpdate(empty, empty)), "");
    report.push("no update: all three data pins already match the requested commits.");
    await saveReport();
    console.log("no update");
    return { changed, next, reportPath, files: [] as string[], changedPaths: [] as string[] };
  }
  report.push("## Upstream commits", "", "| Repository | Old → new | Commits ahead |", "| --- | --- | --- |");
  for (const key of keys) {
    const repo = repositories[key];
    const comparison = old[key] === next[key] ? null : await api<{ ahead_by: number; behind_by: number; status: string }>(`${repo}/compare/${old[key]}...${next[key]}?per_page=1`);
    if (comparison && (comparison.status !== "ahead" || comparison.behind_by !== 0)) {
      throw new Error(`Refusing ${key} SHA: candidate is ${comparison.status} (${comparison.behind_by} behind current pin)`);
    }
    report.push(`| ${repo} | [\`${old[key]}\` → \`${next[key]}\`](https://github.com/ProjectIgnis/${repo}/compare/${old[key]}...${next[key]}) | ${comparison ? `${comparison.ahead_by} (${comparison.status}${comparison.behind_by ? `; ${comparison.behind_by} behind` : ""})` : "unchanged"} |`);
  }
  const temporary = await mkdtemp(join(tmpdir(), "engine-data-update-"));
  try {
    const treeAt = async (sha: string) => {
      const tree = await api<Tree>(`CardScripts/git/trees/${sha}?recursive=1`);
      if (tree.truncated) throw new Error("GitHub truncated the script tree; refusing an incomplete report");
      return new Map(tree.tree.filter((entry) => entry.type === "blob").map((entry) => [entry.path, entry.sha]));
    };
    const [oldTree, newTree] = await Promise.all([treeAt(old.scripts), treeAt(next.scripts)]);
    const preparation = await readFile(join(root, preparePath), "utf8");
    const historyStart = /prereleaseHistoryStart:\s*"([a-f0-9]{12,40})"/.exec(preparation)?.[1];
    let oldDataError: string | undefined;
    const [database, oldDatabase] = await Promise.all([
      downloadReleasedCardData(next.database, temporary, download, { historyStart }),
      downloadReleasedCardData(old.database, join(temporary,"old-data"), download, { historyStart }).catch((error: unknown) => {
        if (!(error instanceof CardRemapValidationError)) throw error;
        oldDataError = error.message;
        return null;
      }),
    ]);
    const stringsAt = async (sha: string) => Buffer.from(await (await download(`https://raw.githubusercontent.com/ProjectIgnis/Distribution/${sha}/config/strings.conf`)).arrayBuffer());
    const nextStrings = await stringsAt(next.strings);
    const oldStrings = old.strings === next.strings ? nextStrings : await stringsAt(old.strings);
    const candidateScripts = loadedScriptTree(newTree, database.scriptCodes, database.rushCodes);
    const previousScripts = loadedScriptTree(oldTree, oldDatabase?.scriptCodes ?? database.scriptCodes, oldDatabase?.rushCodes ?? database.rushCodes);
    const relevance = compareLoadedData({ cards: oldDatabase ? readCardRows(oldDatabase.path) : null, scripts: previousScripts,
      strings: sha256(oldStrings), remaps: oldDatabase?.remaps ?? null },
      { cards: readCardRows(database.path), scripts: candidateScripts, strings: sha256(nextStrings), remaps: database.remaps });
    if (!relevance.relevant) {
      report.splice(report.indexOf("## Upstream commits"), 0, renderRelevantChanges(relevance, []), "");
      await saveReport();
      console.log("no update: upstream changes do not affect loaded engine data");
      return { changed: false, next, reportPath, files: [] as string[], changedPaths: [] as string[], relevance };
    }
    let cardChanges = await cardUpdate(oldDatabase, database, request);
    report.splice(report.indexOf("## Upstream commits"), 0,
      renderRelevantChanges(relevance, cardChanges.added.flatMap(group => group.code ? [group.code] : [])), "",
      renderReleasedSets(cardChanges), "", renderCardUpdate(cardChanges), "");
    const playableCodes = new Set([...(oldDatabase?.scriptCodes ?? []), ...database.scriptCodes]);
    const rushCodes = new Set([...(oldDatabase?.rushCodes ?? []), ...database.rushCodes]);
    const diff = diffScripts(loadedScriptTree(oldTree, playableCodes, rushCodes), loadedScriptTree(newTree, playableCodes, rushCodes));
    const archive = join(temporary, "scripts.tar.gz");
    await writeFile(archive, Buffer.from(await (await download(`https://codeload.github.com/ProjectIgnis/CardScripts/tar.gz/${next.scripts}`)).arrayBuffer()));
    const extracted = join(temporary, "card-scripts");
    await mkdir(extracted);
    execFileSync("tar", ["-xzf", archive, "--strip-components=1", "-C", extracted]);
    const stock = new Map<string, string>();
    for (const path of newTree.keys()) if (path.endsWith(".lua")) stock.set(path, await readFile(join(extracted, path), "utf8"));
    const oldDatabases = oldDatabase?.files ?? await discoverReleasedDatabases(old.database, download);
    const releases = database.files.filter(path => path.startsWith("release-"));
    const loadedCodes = new Set([...database.releaseCodes, ...database.prereleaseCodes]);
    report.push("", "## Released databases", "", `Loaded in order: ${database.files.map(path => `\`${path}\``).join(", ")}.`,
      `Release rows: ${database.releaseCodes.size} passcodes (including alternate artwork).`,
      `Added release databases: ${releases.filter(path => !oldDatabases.includes(path)).map(path => `\`${path}\``).join(", ") || "None"}.`,
      `Removed release databases: ${oldDatabases.filter(path => path.startsWith("release-") && !releases.includes(path)).map(path => `\`${path}\``).join(", ") || "None"}.`,
      "The candidate is rebuilt from its base, prerelease and release files; expansions merged upstream into cards.cdb are not carried forward.");
    if (oldDataError) report.push("", "## Previous card-data comparison", "", `Finding: ${markdown(oldDataError)}. The old snapshot could not be reconciled; this finding does not block the candidate update.`);
    report.push("", prereleaseUpdateReport(oldDatabase?.prerelease ?? null, database, oldDatabase?.released));
    restrictPrereleaseScripts(extracted, database.scriptCodes);
    const releasePaths = [...loadedCodes].flatMap(code => {
      const officialPath = `official/c${code}.lua`;
      const prereleasePath = `pre-release/c${code}.lua`;
      return stock.has(officialPath) ? [officialPath] : stock.has(prereleasePath) ? [prereleasePath] : [];
    });
    const names = new Map<number, string>();
    const db = new Database(database.path, { readonly: true });
    try {
      for (const row of db.prepare("SELECT id, name FROM texts").all() as { id: number; name: string }[]) names.set(row.id, row.name);
    } finally { db.close(); }
    const cardLine = (path: string) => {
      const name = names.get(codeOf(path));
      return `- [\`${path}\`](https://github.com/ProjectIgnis/CardScripts/blob/${next.scripts}/${path})${name ? ` — ${markdown(name)}` : " — name unavailable in cards.cdb"}`;
    };
    for (const [title, paths] of [["New official card scripts", diff.added], ["Changed official scripts", diff.changed], ["Removed official scripts", diff.removed]] as const) {
      report.push("", `## ${title} (${paths.length})`, "", ...(paths.length ? paths.map((path) => title.startsWith("Removed") ? `- \`${path}\`` : cardLine(path)) : ["None."]));
    }
    const manifest = JSON.parse(await readFile(join(root, packagePath, "domain-core/multi-scripts/MANIFEST.json"), "utf8")) as { cards: OverlayCard[] };
    const conflicts = detectOverlayConflicts(manifest.cards, stock);
    report.push("", `## Overlay conflicts (${conflicts.length})`, "", "Compared every MANIFEST stockSha256 against candidate stock scripts. A human/Codex must update affected overlay files and review their baseline hashes; this job does not regenerate them.", "",
      ...(conflicts.length ? conflicts.map((card) => `- \`${card.file}\` ${markdown(names.get(card.code) ?? card.name ?? "")} — stock \`${card.stockSha256 ?? "unrecorded"}\` → \`${card.actualSha256 ?? "removed"}\``) : ["None."]));
    const patches = JSON.parse(await readFile(join(root, packagePath, "card-script-patches/MANIFEST.json"), "utf8")) as Array<{ stockPath: string; stockSha256: string }>;
    const patchConflicts = detectOverlayConflicts(patches.map(patch => ({
      ...patch, code: codeOf(patch.stockPath), file: patch.stockPath.split("/").pop()!,
    })), stock);
    report.push("", "## Card script patches", "",
      ...(patchConflicts.length ? [
        "**patch needs review**: candidate preparation and publication are blocked; all current data pins unchanged. The deployed stock files and reviewed patches remain in service until a human reviews the upstream change. No patch or baseline hash is changed automatically.", "",
        ...patchConflicts.map(patch => `- \`${patch.stockPath}\` — **patch needs review**; expected \`${patch.stockSha256}\`; ${patch.actualSha256 ? `actual \`${patch.actualSha256}\`` : "removed"}`),
      ] : ["All shared card-script patch stock hashes match the candidate."]));
    const risks = findNewRisks(stock, [...diff.added, ...diff.changed, ...releasePaths], undefined, loadedCodes);
    report.push("", `## New multiplayer risks (${risks.length})`, "", "scan-multiplayer-scripts: new/changed or released cards flagged F or ambiguous O, absent from MULTIPLAYER_FORBIDDEN / MULTIPLAYER_CARD_RULES.", "",
      ...(risks.length ? risks.map((card) => `- \`c${card.code}.lua\` ${markdown(names.get(card.code) ?? card.name)} — **${card.cls}**, ${card.rules.map((rule) => `\`${rule}\``).join(", ")}`) : ["None."]));
    const shared = relevance.changedScripts.filter(path => !official(path) && oldTree.get(path) !== newTree.get(path));
    report.push("", `## Changed shared scripts (${shared.length})`, "",
      ...(shared.length ? shared.map((path) => `- \`${path}\` (${!newTree.has(path) ? "removed" : !oldTree.has(path) ? "added" : "changed"})`) : ["None."]));
    if (shared.some((path) => /(?:^|\/)(?:.*utility.*|proc_.*|constant|cards_specific_functions)\.lua$/.test(path))) {
      report.push("", "**Review `mp-utility.lua`** against these shared helper/constant changes, including multiplayer assumptions and overrides.");
    }
    const listed = findListedChanges(stock, [...diff.added, ...diff.changed, ...diff.removed], new Set(manifest.cards.map((card) => card.code)));
    report.push("", `## Changed listed cards (${listed.length})`, "", "Changed listed scripts without an overlay, plus formatGap cards (including unchanged scripts whose current scan finds a gap).", "",
      ...(listed.length ? listed.map((card) => `- \`c${card.code}.lua\` ${markdown(names.get(card.code) ?? card.name)} — ${card.list}${card.changed ? "; script changed" : ""}${card.formatGap ? "; **formatGap: review Tag coverage**" : ""}`) : ["None."]));
    // Database-only updates can release cards whose script already existed at the old scripts pin.
    // Probe those scripts too, and omit pre-release card scripts removed from the prepared bundle.
    const allowed = (path: string) => !/^pre-release\/c\d+\.lua$/.test(path) ||
      (database.scriptCodes.has(codeOf(path)) && !stock.has(`official/c${codeOf(path)}.lua`));
    const changedPaths = [...new Set([...candidateScripts.keys()].filter(path => newTree.get(path) !== oldTree.get(path)).concat(releasePaths))].filter(allowed);
    report[0] = `Needs review: ${conflicts.length + patchConflicts.length} conflicts, ${risks.length} risks, ${shared.length} shared-script changes, probe errors not run, overlay check exit not run`;
    report.push("", "## Core compatibility", "", "Pending installed npm ocgcore-wasm@0.1.2 probe against candidate data.");
    if (patchConflicts.length) {
      report.unshift(`BLOCKING: ${patchConflicts.length} patch needs review; current pins and bundle retained.`, "");
      await saveReport();
      // The workflow publishes this report to its failure summary and artifact.
      // Stop before rewriting pins, so duel:prepare cannot apply an unreviewed suffix.
      throw new Error(`patch needs review: ${patchConflicts.map(patch => patch.stockPath).join(", ")}. Current pins unchanged. Report: ${reportPath}`);
    }
    if (options.validate !== false) {
      // Match prepare-data: reviewed shared patches are part of the effective
      // scripts being gated, after stock conflicts have already blocked the run.
      installCardScriptPatches(extracted, join(root, packagePath, "card-script-patches"));
      await writeFile(join(temporary, "strings.conf"), nextStrings);
      try {
        await applyPrereleaseSmokeResult(database, await smokePrereleaseScripts(temporary, [...database.prereleaseCodes]));
        const smoke = JSON.parse(database.remapBytes).scriptSmoke;
        cardChanges = withPreviewExclusions(cardChanges, smoke.excluded.map((card: { code: number }) => card.code));
        report.splice(0, report.length, withCardUpdate(report.join("\n"), cardChanges));
        restrictPrereleaseScripts(extracted, database.scriptCodes);
        report.push("", prereleaseScriptReport(smoke));
      } catch (error) {
        report.push("", "## Prerelease script safety", "", `BLOCKING: ${markdown(String(error))}. Current pins retained.`);
        await saveReport(); throw error;
      }
    } else report.push("", "## Prerelease script safety", "", "Pending required prepare-time smoke check of every prerelease card; final validation reads the prepared bundle's exclusions.");
    const files = await rewritePins(root, old, next, true);
    report.push("", "## Synchronized files", "", ...files.map((path) => `- \`${path}\``));
    report.push("", "## Deployment", "", "**Live-duel warning:** a data pin bump changes bundleVersion. On recovery after deploy, an active duel whose bundleVersion differs is interrupted. Drain active duels and merge at a quiet time. The deploy preflight may refuse until duels finish. **Replay-loss warning:** every data bump also makes replays of all earlier duels with a different bundleVersion unavailable; host replay recovery refuses the mismatch. The owner must account for this when deciding update cadence.");
    report.push("", "## Golden hashes", "", "**Reviewer action in this PR:** re-record golden hashes with `run-nduel.sh --record` against the candidate bundle, review the diff, then run `run-nduel.sh --check`. Data pins change the cards.cdb/scripts inputs. Automated CI dispatch uses `nightly=false`; this does not waive golden re-recording before merge.");
    if (options.validate !== false) {
      const probe = await probeEngineData(temporary, changedPaths);
      let overlayExit = 0;
      let overlayLog = "";
      try {
        overlayLog = execFileSync(process.execPath, ["--import", "tsx", join(root, packagePath, "scripts/generate-multi-scripts.ts"), "--check"],
          { cwd: root, env: { ...process.env, DUEL_DATA_DIR: temporary }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 120_000 });
      } catch (error) {
        const failure = error as { status?: number; stdout?: string; stderr?: string; message?: string };
        overlayExit = failure.status || 1;
        overlayLog = `${failure.stdout ?? ""}${failure.stderr ?? failure.message ?? "Overlay check failed"}`;
      }
      report.splice(0, report.length, withValidation(report.join("\n"), probe, overlayExit, overlayLog));
    }
    await saveReport();
    if (!options.dryRun) await rewritePins(root, old, next, false);
    console.log(`${options.dryRun ? "dry run" : "update"}: ${diff.added.length} new, ${diff.changed.length} changed, ${diff.removed.length} removed official scripts; ${conflicts.length} overlay conflicts; ${risks.length} new multiplayer risks. Report: ${reportPath}`);
    return { changed, next, reportPath, files, changedPaths, cardChanges, relevance };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function main() {
  const { values } = parseArgs({ options: { scripts: { type: "string" }, database: { type: "string" }, strings: { type: "string" }, "dry-run": { type: "boolean", default: false }, report: { type: "string" }, metadata: { type: "string" }, "defer-validation": { type: "boolean", default: false } } });
  const overrides = Object.fromEntries(keys.filter((key) => values[key] !== undefined).map((key) => [key, values[key]]));
  const result = await runUpdate({ overrides, dryRun: values["dry-run"], report: values.report, validate: !values["defer-validation"] });
  if (values.metadata) {
    const metadataPath = resolve(values.metadata);
    await mkdir(dirname(metadataPath), { recursive: true });
    await writeFile(metadataPath, JSON.stringify({ ...result, baseSha: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim() }, null, 2) + "\n");
  }
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, githubOutput(result));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
}
