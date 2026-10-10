import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { readOnlyCardScriptSource } from "../../src/card-script-source.js";
import { downloadReleasedCardData } from "../released-card-data.js";
import { installCardScriptPatches } from "../card-script-patches.js";

export interface SmokePins { scripts: string; database: string; strings: string }
export interface SmokeSnapshot { cards: Map<number, { row: string; script: string; type?: number }>; helpers: string }
export interface SmokeShard { index: number; count: number }
const root = fileURLToPath(new URL("../../../..", import.meta.url));
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const stable = (value: unknown) => JSON.stringify(value, (_key, v) => typeof v === "bigint" ? v.toString() : v);

/** One-based CI matrix shards; membership depends only on passcode and shard count. */
export function shardSmokeCodes(codes: number[], shard?: SmokeShard): number[] {
  if (!shard) return codes;
  if (!Number.isSafeInteger(shard.index) || !Number.isSafeInteger(shard.count) || shard.index < 1 || shard.index > shard.count || shard.count > 0xffffffff)
    throw new Error("Invalid shard; use i/N with 1 <= i <= N");
  return codes.filter(code => Number.parseInt(sha(`new-card-smoke-shard-v1:${code}`).slice(0, 8), 16) % shard.count === shard.index - 1);
}

export function changedSmokeCodes(before: SmokeSnapshot, after: SmokeSnapshot): number[] {
  const changed = new Set([...after.cards].filter(([code, card]) => {
    const old = before.cards.get(code);
    return !old || card.row !== old.row || card.script !== old.script;
  }).map(([code]) => code));
  if (before.helpers !== after.helpers) {
    const buckets = new Map<number, number[]>();
    for (const [code, card] of after.cards) if (!changed.has(code)) {
      const type = card.type ?? 0;
      const group = [0x4000000, 0x800000, 0x2000, 0x40, 0x80, 0x1000000, 0x80000, 0x40000, 0x20000, 0x10000, 4, 2, 0x20, 1].find(bit => type & bit) ?? 0;
      const codes = buckets.get(group) ?? []; codes.push(code); buckets.set(group, codes);
    }
    const rank = (code: number) => sha(`new-card-smoke-helper-sample-v1:20261010:${code}`);
    const groups = [...buckets].sort(([a], [b]) => a - b).map(([, codes]) => codes.sort((a, b) => rank(a).localeCompare(rank(b)) || a - b));
    for (let i = 0, sampled = 0; sampled < 150 && groups.some(group => i < group.length); i++)
      for (const group of groups) if (group[i] != null && sampled < 150) { changed.add(group[i]!); sampled++; }
  }
  return [...changed].sort((a, b) => a - b);
}

export function snapshotSmokeBundle(directory: string): SmokeSnapshot {
  const source = readOnlyCardScriptSource(directory), db = new Database(join(directory, "cards.cdb"), { readonly: true });
  db.defaultSafeIntegers(true);
  try {
    const cards: SmokeSnapshot["cards"] = new Map();
    const rows = db.prepare("SELECT d.*,t.* FROM datas d JOIN texts t USING(id) ORDER BY d.id").all() as Record<string, unknown>[];
    for (const row of rows) {
      const code = Number(row.id);
      if (Number(row.type) & 0x4000) continue;
      cards.set(code, { row: sha(stable(row)), script: sha(source.readScript(`c${code}.lua`) ?? ""), type: Number(row.type) });
    }
    const helpers = [...source.scriptNames?.() ?? []].filter(name => !/^c\d+\.lua$/.test(name.split("/").at(-1)!))
      .filter(name => !/^(?:domain(?:\.legacy)?\.lua)$/.test(name)).sort().map(name => [name, source.readScript(name)]);
    return { cards, helpers: sha(stable(helpers)) };
  } finally { db.close(); source.close(); }
}

export function pinsFromText(text: string): SmokePins {
  return Object.fromEntries(["scripts", "database", "strings"].map(key => {
    const pin = new RegExp(`\\b${key}\\b["']?\\s*:\\s*["']([a-f0-9]{40})["']`).exec(text)?.[1];
    if (!pin) throw new Error(`Missing immutable ${key} pin`);
    return [key, pin];
  })) as unknown as SmokePins;
}

/** A pin is a repository Git ref or a JSON file containing the three pins (or manifest.sources). */
export function readSmokePins(ref: string): SmokePins {
  if (existsSync(ref)) {
    const parsed = JSON.parse(readFileSync(ref, "utf8"));
    return pinsFromText(stable(parsed.sources ?? parsed));
  }
  return pinsFromText(execFileSync("git", ["show", `${ref}:packages/duel-server/scripts/prepare-data.ts`], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
}

const samePins = (a: SmokePins, b: SmokePins) => ["scripts", "database", "strings"].every(k => a[k as keyof SmokePins] === b[k as keyof SmokePins]);
export async function changedSmokePins(before: SmokePins, after: SmokePins, directory: string, request: typeof fetch = fetch): Promise<number[]> {
  const manifest = JSON.parse(readFileSync(join(directory, "manifest.json"), "utf8"));
  if (!samePins(after, manifest.sources)) throw new Error("--to-pin does not match the prepared DUEL_DATA_DIR manifest; prepare the candidate first");
  if (samePins(before, after)) return [];
  const temporary = await mkdtemp(join(tmpdir(), "new-card-smoke-comparison-"));
  try {
    const downloaded = await Promise.allSettled([
      downloadReleasedCardData(before.database, temporary, request, { historyStart: before.database }),
      request(`https://codeload.github.com/ProjectIgnis/CardScripts/tar.gz/${before.scripts}`, { signal: AbortSignal.timeout(120000) }),
    ]);
    const [databaseResult, scriptResult] = downloaded;
    if (databaseResult.status === "rejected") throw databaseResult.reason;
    if (scriptResult.status === "rejected") throw scriptResult.reason;
    const database = databaseResult.value, response = scriptResult.value;
    if (!response.ok) throw new Error(`CardScripts download failed: HTTP ${response.status}`);
    const archive = join(temporary, "scripts.tar.gz"); await writeFile(archive, Buffer.from(await response.arrayBuffer()));
    const scripts = join(temporary, "card-scripts"); await mkdir(scripts);
    execFileSync("tar", ["-xzf", archive, "--strip-components=1", "-C", scripts]);
    // Keep recipe patches consistent with the prepared candidate. An old baseline mismatch selects conservatively.
    try { installCardScriptPatches(scripts); } catch { /* The source bytes remain available for a conservative comparison. */ }
    await writeFile(join(temporary, "cards.cdb"), database.bytes);
    return changedSmokeCodes(snapshotSmokeBundle(temporary), snapshotSmokeBundle(directory));
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

/** Product membership is CDB provenance, not the archetype setcode stored in datas.setcode. */
export async function smokeSetCodes(set: string, directory: string, request: typeof fetch = fetch): Promise<number[]> {
  if (!/^[A-Z0-9]+$/i.test(set)) throw new Error("set must be an alphanumeric product code");
  const manifest = JSON.parse(readFileSync(join(directory, "manifest.json"), "utf8"));
  const pattern = new RegExp(`^(?:release|prerelease)-${set.toLowerCase()}(?:-en)?\\.cdb$`, "i");
  const files = (manifest.sources.databaseFiles as string[]).filter(f => pattern.test(f));
  if (!files.length) throw new Error(`No source CDB for set ${set}`);
  const scratch = await mkdtemp(join(tmpdir(), "new-card-smoke-set-"));
  let installed: Database.Database | undefined;
  try {
    installed = new Database(join(directory, "cards.cdb"), { readonly: true });
    const find = installed.prepare("SELECT type FROM datas WHERE id=?"); const codes = new Set<number>();
    for (const file of files) {
      const response = await request(`https://raw.githubusercontent.com/ProjectIgnis/BabelCDB/${manifest.sources.database}/${file}`, { signal: AbortSignal.timeout(120000) });
      if (!response.ok) throw new Error(`Set CDB download failed: ${file}: HTTP ${response.status}`);
      const path = join(scratch, file); await writeFile(path, Buffer.from(await response.arrayBuffer()));
      const db = new Database(path, { readonly: true });
      try {
        for (const row of db.prepare("SELECT id,type FROM datas ORDER BY id").all() as { id: number; type: number }[]) {
          if (row.type & 0x4000) continue;
          if (!find.get(row.id)) throw new Error(`Set ${set} passcode ${row.id} is absent from the prepared bundle (check preparation exclusions)`);
          codes.add(row.id);
        }
      } finally { db.close(); }
    }
    return [...codes].sort((a, b) => a - b);
  } finally { installed?.close(); await rm(scratch, { recursive: true, force: true }); }
}

export function parseSmokeArgs(args: string[]) {
  const { values } = parseArgs({ args, options: {
    cards: { type: "string" }, set: { type: "string" }, "from-pin": { type: "string" }, "to-pin": { type: "string" },
    "from-bundle": { type: "string" }, "to-bundle": { type: "string" }, "data-dir": { type: "string" },
    jobs: { type: "string" }, seed: { type: "string" }, timeout: { type: "string" }, "max-steps": { type: "string" }, "max-turns": { type: "string" },
    output: { type: "string" }, case: { type: "string" }, shard: { type: "string" }, "multi-cards": { type: "string" }, "multi-angelechy": { type: "boolean" }, help: { type: "boolean" },
  } });
  const list = (raw: string | undefined) => raw?.split(/[\s,]+/).filter(Boolean).map(s => {
    const n = Number(s); if (!/^\d+$/.test(s) || !Number.isSafeInteger(n) || n < 1 || n > 0xffffffff) throw new Error(`Invalid passcode ${s}`); return n;
  });
  const number = (name: "jobs" | "seed" | "timeout" | "max-steps" | "max-turns", fallback?: number) => {
    const raw = values[name]; if (raw === undefined) return fallback;
    const n = Number(raw); if (!Number.isSafeInteger(n) || n < (name === "seed" ? 0 : 1) || (name === "jobs" && n > 8)
      || (name === "seed" && n > 0xffffffff) || (name === "timeout" && n > 0x7fffffff)) throw new Error(`Invalid ${name}`); return n;
  };
  const modes = [values.cards !== undefined, values.set !== undefined, !!(values["from-pin"] || values["to-pin"]), !!values["from-bundle"]].filter(Boolean).length;
  if (modes > 1) throw new Error("Choose one input mode: cards, set, pins, or bundles");
  if (!!values["from-pin"] !== !!values["to-pin"]) throw new Error("Use both --from-pin and --to-pin");
  const cards = list(values.cards); if (cards && !cards.length) throw new Error("cards needs at least one passcode");
  let shard: SmokeShard | undefined;
  if (values.shard) {
    const match = /^(\d+)\/(\d+)$/.exec(values.shard);
    if (!match) throw new Error("Invalid shard; use i/N");
    shard = { index: Number(match[1]), count: Number(match[2]) };
    shardSmokeCodes([], shard);
  }
  if (values.case && (!cards || cards.length !== 1 || !/^(?:normal|domain)\/(?:1v1|ffa3|ffa4)\/(?:hand|field|set|grave|banished|deck|extra|pendulum|spell-zone|spell-support)(?:\/branch-\d+)?$/.test(values.case))) throw new Error("--case needs one --cards passcode and a valid case ID");
  return { ...values, cards, shard, multiCards: list(values["multi-cards"]), jobs: number("jobs", 4)!, seed: number("seed"), timeoutMs: number("timeout"),
    maxSteps: number("max-steps"), maxTurns: number("max-turns") };
}
