import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { installMultiScripts } from "../src/multi-scripts.js";
import { downloadReleasedCardData, restrictPrereleaseScripts } from "./released-card-data.js";
import { smokePrereleaseScripts } from "./prerelease-script-smoke.js";
import { applyPrereleaseSmokeResult } from "./prerelease-script-exclusions.js";
import { installCardScriptPatches } from "./card-script-patches.js";

export const sources = {
  corePackage: "ocgcore-wasm@0.1.2",
  scripts: "f593bb7514a2fda449dc645450dc301328e5a64d",
  database: "a71a1d9ed1182d0e096a479bd15a57d374fd09f9",
  strings: "54a6e2395c532648ff762540e9615319fac4f51b",
  databaseFormat: "official-releases-prerelease-v4",
  // Immutable support boundary; abbreviated so the weekly pin rewrite never advances it.
  prereleaseHistoryStart: "fdf92aea3103",
};
const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
// integrity.multiScripts (the Lua overlay of duels with more than two seats) is not part of bundleVersion: the host pins
// it for those duels only (pinnedEngineVersion), so an overlay edit never touches a 1v1 duel or its replay.
// cardsMerged verifies the output bytes; cards identifies inputs without SQLite version/layout changes.
// Core builders, CI assembly and manual E2E preparation compute the same value.
const bundleVersionOf = (sources: Record<string, unknown>, integrity: Record<string, string>) => {
  const { multiScripts: _overlay, cardsMerged: _merged, ...engine } = integrity;
  return hash(JSON.stringify({ sources, integrity: engine }));
};

type Manifest = {
  sources: Record<string, unknown>;
  integrity: Record<string, string>;
  bundleVersion: string;
};

async function download(url: string, request: typeof fetch): Promise<Buffer> {
  const response = await request(url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`Resource download failed (${response.status}): ${url}`);
  return Buffer.from(await response.arrayBuffer());
}

async function readManifest(path: string): Promise<Manifest | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as Manifest;
  } catch {
    return null;
  }
}

async function catalogIsCurrent(directory: string, manifest: Manifest | null): Promise<boolean> {
  if (!manifest) return false;
  if (manifest.sources.corePackage !== sources.corePackage) return false;
  if (manifest.sources.scripts !== sources.scripts) return false;
  if (manifest.sources.database !== sources.database) return false;
  if (manifest.sources.strings !== sources.strings) return false;
  if (manifest.sources.databaseFormat !== sources.databaseFormat) return false;
  if (!Array.isArray(manifest.sources.databaseFiles) || manifest.sources.databaseFiles[0] !== "cards.cdb") return false;
  try {
    const cards = await readFile(join(directory, "cards.cdb"));
    const stringsFile = await readFile(join(directory, "strings.conf"));
    if (hash(cards) !== manifest.integrity.cardsMerged) return false;
    const remapBytes = await readFile(join(directory, "card-remaps.json"));
    if (hash(remapBytes) !== manifest.integrity.cardRemaps) return false;
    if (JSON.parse(remapBytes.toString("utf8")).overrideSource !== await readFile(new URL("../card-remap-overrides.json", import.meta.url), "utf8")) return false;
    if (hash(stringsFile) !== manifest.integrity.strings) return false;
  } catch {
    return false;
  }
  return existsSync(join(directory, "card-scripts"));
}

export async function prepareData(
  directory = resolve(process.env.DUEL_DATA_DIR ?? fileURLToPath(new URL("../../../data/duel-engine/", import.meta.url))),
  request: typeof fetch = fetch,
) {
  directory = resolve(directory);
  if (existsSync(join(directory, "bot.sqlite"))) {
    throw new Error(`refusing to prepare engine resources in ${directory} because it contains bot.sqlite`);
  }
  await mkdir(directory, { recursive: true });
  const previous = await readManifest(join(directory, "manifest.json"));
  // The Lua overlay of duels with more than two seats ships as <data>/multi-scripts. It is not part of card-scripts
  // (this script replaces that folder), and it changes with the repo, so it is installed on every run.
  const multiScriptsHash = installMultiScripts(directory);
  if (previous && await catalogIsCurrent(directory, previous)) {
    const cardScriptPatches = installCardScriptPatches(join(directory, "card-scripts"));
    const { cardScriptPatches: _oldPatches, ...baseIntegrity } = previous.integrity;
    const integrity: Record<string, string> = {};
    // Match fresh preparation (and builders that append core entries afterward):
    // JSON insertion order is part of the existing bundleVersion format.
    for (const [key, value] of Object.entries(baseIntegrity)) {
      integrity[key] = value;
      if (key === "wrapper") integrity.cardScriptPatches = cardScriptPatches;
    }
    integrity.cardScriptPatches ??= cardScriptPatches;
    integrity.multiScripts = multiScriptsHash;
    const bundleVersion = bundleVersionOf(previous.sources, integrity);
    if (previous.integrity.multiScripts !== multiScriptsHash || previous.integrity.cardScriptPatches !== cardScriptPatches || previous.bundleVersion !== bundleVersion) {
      previous.integrity = integrity;
      previous.bundleVersion = bundleVersion;
      await writeFile(join(directory, "manifest.json"), JSON.stringify(previous, null, 2) + "\n");
    }
    return { directory, skipped: true, ...previous };
  }

  const luaPath = join(directory, "card-scripts", "domain.lua");
  const savedLua = existsSync(luaPath) ? await readFile(luaPath) : null;
  // The Domain Lua of the legacy 1v1 engine (built by legacy-1v1/scripts/build-domain-core.sh) is kept the same way.
  const legacyLuaPath = join(directory, "card-scripts", "domain.legacy.lua");
  const savedLegacyLua = existsSync(legacyLuaPath) ? await readFile(legacyLuaPath) : null;
  const temporary = await mkdtemp(join(tmpdir(), "yugidraft-resources-"));
  try {
    const [database, strings, scripts] = await Promise.all([
      downloadReleasedCardData(sources.database, temporary, request, { historyStart: sources.prereleaseHistoryStart }),
      download(`https://raw.githubusercontent.com/ProjectIgnis/Distribution/${sources.strings}/config/strings.conf`, request),
      download(`https://codeload.github.com/ProjectIgnis/CardScripts/tar.gz/${sources.scripts}`, request),
    ]);
    const archive = join(temporary, "scripts.tar.gz");
    await writeFile(archive, scripts);
    const scriptStaging = join(temporary, "card-scripts");
    await mkdir(scriptStaging, { recursive: true });
    execFileSync("tar", ["-xzf", archive, "--strip-components=1", "-C", scriptStaging]);
    restrictPrereleaseScripts(scriptStaging, database.scriptCodes);
    for (const drop of database.drops) console.log(`[prerelease] Drop ${drop.code} ${drop.name} (${drop.file}): ${drop.reason}${drop.keptCode ? ` → ${drop.keptCode}` : ""}`);
    for (const card of database.unmatched) console.log(`[prerelease] ${card.code} ${card.name}: unmatched graduation, needs review`);
    const cardScriptPatches = installCardScriptPatches(scriptStaging);
    await writeFile(join(temporary, "strings.conf"), strings);
    const smoke = await smokePrereleaseScripts(temporary, [...database.prereleaseCodes]);
    await applyPrereleaseSmokeResult(database, smoke);
    restrictPrereleaseScripts(scriptStaging, database.scriptCodes);
    const findings = JSON.parse(database.remapBytes).scriptSmoke;
    console.log(`[prerelease] Script smoke: checked ${smoke.checked}, excluded ${findings.excluded.length}`);
    for (const card of findings.excluded) console.log(`[prerelease] ${card.code} ${card.name} (${card.file}): excluded: script error — ${card.errors.join("; ")}`);
    const cards = database.bytes;
    if (savedLua) await writeFile(join(scriptStaging, "domain.lua"), savedLua);
    if (savedLegacyLua) await writeFile(join(scriptStaging, "domain.legacy.lua"), savedLegacyLua);
    const scriptDirectory = join(directory, "card-scripts");
    await rm(scriptDirectory, { recursive: true, force: true });
    await cp(scriptStaging, scriptDirectory, { recursive: true });
    await Promise.all([
      writeFile(join(directory, "cards.cdb"), cards),
      writeFile(join(directory, "card-remaps.json"), database.remapBytes),
      writeFile(join(directory, "strings.conf"), strings),
    ]);
    const wasm = await readFile(fileURLToPath(import.meta.resolve("ocgcore-wasm/lib/ocgcore.sync.wasm")));
    const wrapper = await readFile(fileURLToPath(import.meta.resolve("ocgcore-wasm")));
    const integrity: Record<string, string> = {
      cards: hash(database.inputHashes.join("\n")),
      cardsMerged: hash(cards),
      cardRemaps: hash(database.remapBytes),
      strings: hash(strings),
      scripts: hash(scripts),
      wasm: hash(wasm),
      wrapper: hash(wrapper),
      multiScripts: multiScriptsHash,
      cardScriptPatches,
    };
    const mergedSources: Record<string, unknown> = { ...sources, databaseFiles: database.files };
    const domainWasmPath = join(directory, "ocgcore.domain.wasm");
    const domainLuaPath = join(directory, "card-scripts", "domain.lua");
    if (previous?.sources.domainCore && existsSync(domainWasmPath) && existsSync(domainLuaPath)) {
      mergedSources.domainCore = previous.sources.domainCore;
      integrity.domainWasm = hash(await readFile(domainWasmPath));
      integrity.domainLua = hash(await readFile(domainLuaPath));
      if (previous.integrity.domainPatch) integrity.domainPatch = previous.integrity.domainPatch;
    }
    const legacyWasmPath = join(directory, "ocgcore.domain.legacy.wasm");
    if (previous?.sources.domainCoreLegacy && existsSync(legacyWasmPath) && existsSync(legacyLuaPath)) {
      mergedSources.domainCoreLegacy = previous.sources.domainCoreLegacy;
      integrity.domainLegacyWasm = hash(await readFile(legacyWasmPath));
      integrity.domainLegacyLua = hash(await readFile(legacyLuaPath));
      if (previous.integrity.domainLegacyPatch) integrity.domainLegacyPatch = previous.integrity.domainLegacyPatch;
    }
    const standardWasmPath = join(directory, "ocgcore.standard.wasm");
    if (previous?.sources.standardCore && existsSync(standardWasmPath)) {
      mergedSources.standardCore = previous.sources.standardCore;
      integrity.standardWasm = hash(await readFile(standardWasmPath));
    }
    const manifest = { sources: mergedSources, integrity, bundleVersion: bundleVersionOf(mergedSources, integrity) };
    await writeFile(join(directory, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
    return { directory, skipped: false, ...manifest };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  console.log(JSON.stringify(await prepareData(), null, 2));
}
