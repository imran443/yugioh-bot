import { fork, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { seatCountFor, type DuelFormat } from "@yugidraft/shared/duels";
import { loadCardDatabase } from "../../src/cards.js";
import { makeSmokeCases, type SmokeCard, type SmokeCase } from "./new-card-smoke-board.js";
import { companionOptions } from "./new-card-smoke-companions.js";
import { smokeEffectCoverage, smokeExpectedEffects } from "./new-card-smoke-effects.js";
export { smokeIsSetCard } from "./new-card-smoke-companions.js";
import { runSmokeCase, type SmokeCaseResult, type SmokeLimits } from "./new-card-smoke-runner.js";

export interface SmokeCardResult extends SmokeCard { name: string; status: "PASS" | "WARN" | "FAIL"; reason: string; seed: number; cases: SmokeCaseResult[] }
export interface SmokeReport { cards: SmokeCardResult[]; durationMs: number; jobs: number; peakWorkers?: number; timeoutRetries?: number; bundleVersion: string; sources?: unknown; incomplete?: boolean; incompleteCodes?: number[];
  configuration?: { caseTimeoutMs: number; cardTimeoutMsPerFormat: number; suiteTimeoutMs: number; baseSeed?: number; caseId?: string; multiCards: number[];
    formats: Array<{ format: DuelFormat; maxSteps: number; maxTurns: number }>; invocation?: string[]; shard?: { index: number; count: number } } }
export interface PoolOptions { jobs?: number; timeoutMs?: number; cardTimeoutMs?: number; suiteTimeoutMs?: number; seed?: number; formats?: DuelFormat[];
  /** Extra formats apply only to these passcodes (for example the seven Angelechy cards). */
  multiCards?: number[]; caseId?: string; limits?: SmokeLimits; onCard?: (card: SmokeCardResult) => void }
type Message = { kind: "ready" } | { kind: "active"; test: Pick<SmokeCase, "id" | "seed"> } | { kind: "case"; result: SmokeCaseResult } | { kind: "done" } | { kind: "fatal"; error: string };
const smokeGroup = (test: SmokeCaseResult) => test.id.split("/").slice(0, 2).join("/");

export function smokeRetrySeed(code: number, start: number, used: Set<number>, index = -1, modes = 0): number {
  let seed = start >>> 0;
  while (used.has(seed) || (index >= 0 && modes > 0 && ((seed ^ code) >>> 0) % modes !== index % modes)) seed = (seed + 1) >>> 0;
  return seed;
}

export function smokeMissingEffect(results: SmokeCaseResult[], test: SmokeCaseResult, description = "", retries = new Map<string, number>()): string | undefined {
  const expected = smokeExpectedEffects(results, description);
  const activated = new Set(results.filter(r => smokeGroup(r) === smokeGroup(test)).flatMap(r => r.activated));
  const inventory = expected.size ? [...expected.values()].filter(e => e.parent !== "card-text").map(e => e.id) : test.offered;
  return inventory.find(key => !activated.has(key) && (retries.get(`${smokeGroup(test)}:${key}`) ?? 0) < 2);
}

export function smokeRetryParent(results: SmokeCaseResult[], description = "", retries = new Map<string, number>()): SmokeCaseResult | undefined {
  const candidates = results.filter(r => !r.failure && smokeMissingEffect(results, r, description, retries));
  return candidates.find(r => (r.expected ?? []).some(e => e.id === smokeMissingEffect(results, r, description, retries))) ?? candidates[0];
}

export function summarizeCard(card: SmokeCard, cases: SmokeCaseResult[], seed = cases[0]?.seed ?? card.code): SmokeCardResult {
  const failures = cases.filter(c => c.failure);
  const { expected, warnings: printedWarnings } = smokeEffectCoverage(cases, card.description);
  const effectText = (card.type & (2 | 4 | 0x20 | 0x1000000)) !== 0 && card.description.trim().length > 0;
  const group = (test: SmokeCaseResult) => test.id.split("/").slice(0, 2).join("/");
  const missing = [...new Set(cases.flatMap(test => {
    const activated = new Set(cases.filter(c => group(c) === group(test)).flatMap(c => c.activated));
    return test.offered.filter(effect => !expected.size && !activated.has(effect)).map(effect => `${group(test)}: ${effect}`);
  }))];
  const groups = [...new Set(cases.map(group))];
  const coverage = groups.map(g => {
    const ran = new Set(cases.filter(c => group(c) === g).flatMap(c => c.activated));
    const never = [...expected.values()].filter(e => !ran.has(e.id));
    return { group: g, count: expected.size - never.length, never };
  });
  const never = coverage.flatMap(c => c.never.map(e => `${c.group}: ${e.label} [${e.id}]`));
  const unknown = effectText && !expected.size;
  const status = !cases.length || failures.length ? "FAIL" : unknown || never.length || missing.length || printedWarnings.length ? "WARN" : "PASS";
  const progress = `${Math.min(...coverage.map(c => c.count), expected.size)} of ${expected.size} effects ran in every core/format`;
  const reason = !cases.length ? "No engine cases completed" : failures.length ? failures.map(c => `${c.id} [seed ${c.seed}]: ${c.failure}`).join("; ")
    : never.length ? `${progress}; effects that never ran: ${never.join(", ")}`
      : unknown ? "Effect inventory unavailable; cannot certify all effects ran"
      : missing.length ? `${progress}; offered effects not attempted: ${missing.join(", ")}`
      : printedWarnings.length ? progress
      : `${progress}; ${cases.length} engine cases checked; ${cases.filter(c => c.replayed).length} replay checks`;
  return { ...card, name: card.name ?? String(card.code), status,
    reason: !failures.length && cases.length && printedWarnings.length ? `${reason}; ${printedWarnings.join("; ")}` : reason, seed, cases };
}

const cell = (value: unknown) => String(value).replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/[\r\n]+/g, " ").replace(/</g, "&lt;").replace(/>/g, "&gt;");
export function renderSmokeMarkdown(report: SmokeReport): string {
  const count = (status: SmokeCardResult["status"]) => report.cards.filter(c => c.status === status).length;
  return ["# New card engine smoke results", "", `Cards: ${report.cards.length}. PASS: ${count("PASS")}. WARN: ${count("WARN")}. FAIL: ${count("FAIL")}.`,
    `Run time: ${(report.durationMs / 1000).toFixed(2)} seconds. Worker limit: ${report.jobs}.`, `Bundle: ${report.bundleVersion}.`, "",
    ...(report.incomplete ? [`INCOMPLETE: time budget reached; ${report.incompleteCodes?.length ?? 0} cards unfinished (${report.incompleteCodes?.join(", ")}). Exit ${count("FAIL") ? 1 : 3}.`, ""] : []),
    ...(report.configuration ? [`Configuration: \`${JSON.stringify(report.configuration)}\`.`, "",
      "Replay one case using its case ID and seed from JSON: `--cards PASSCODE --case normal/1v1/hand --seed CASE_SEED` with the same data bundle and limits.", ""] : []),
    "Each case uses a short pinned-core duel and replays every accepted answer. PASS requires every registered activated effect and every declared selection branch to complete on a resolved chain in each core/format. Negated or interrupted tries do not count. Uncovered effects remain WARN with their names. Passive effects and card rulings need separate scenario tests. Conservation is checked after pending summon placement; the core cannot query materials in transit.", "",
    "| Passcode | Card | Pool | Status | Reason | Replay seed |", "| --- | --- | --- | --- | --- | --- |",
    ...report.cards.map(c => `| ${c.code} | ${cell(c.name)} | ${c.prerelease ? "pre-release" : "released"} | ${c.status} | ${cell(c.reason)} | ${c.seed} |`), ""].join("\n");
}


export function smokeCasesForCard(code: number, directory: string, formats: DuelFormat[], seed?: number): SmokeCase[] {
  const cards = loadCardDatabase(directory), card = cards.get(code)!, data = cards.cardData(code)!;
  return makeSmokeCases({ ...card, type: data.type }, { seed, formats, ...companionOptions(code, directory) });
}

/** Persistent, bounded process pool. Parent watchdogs can interrupt synchronous WASM/Lua loops. */
export async function runSmokePool(codes: number[], directory: string, options: PoolOptions = {}): Promise<SmokeReport> {
  directory = resolve(directory);
  const jobs = options.jobs ?? 4;
  if (!Number.isSafeInteger(jobs) || jobs < 1 || jobs > 8) throw new Error("jobs must be an integer from 1 to 8");
  for (const [name, value] of Object.entries({ timeoutMs: options.timeoutMs ?? 30000, cardTimeoutMs: options.cardTimeoutMs ?? 60000, suiteTimeoutMs: options.suiteTimeoutMs ?? 540000 }))
    if (!Number.isSafeInteger(value) || value < 1 || value > 0x7fffffff || (name === "cardTimeoutMs" && value > Math.floor(0x7fffffff / 3))) throw new Error(`${name} exceeds the supported timer range`);
  for (const [name, value] of Object.entries(options.limits ?? {})) if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) throw new Error(`${name} must be a positive integer`);
  codes = [...new Set(codes)];
  const cards = loadCardDatabase(directory);
  const metadata = codes.map(code => {
    const card = cards.get(code), data = cards.cardData(code);
    if (!card || !data) throw new Error(`Unknown passcode ${code}`);
    return { code, name: card.name, type: data.type, description: card.description, prerelease: card.prerelease };
  });
  const started = performance.now();
  const manifest = JSON.parse(readFileSync(join(directory, "manifest.json"), "utf8"));
  const results: SmokeCardResult[] = new Array(codes.length);
  const caseResults = codes.map(() => [] as SmokeCaseResult[]);
  type Task = { index: number; resume?: Pick<SmokeCase, "id" | "seed"> };
  const deferred: Task[] = [];
  const retried = new Set<string>();
  const incompleteCodes = new Set<number>();
  const children = new Set<ChildProcess>();
  const stopping: Promise<void>[] = [];
  const stop = (worker: ChildProcess) => {
    if (worker.exitCode === null && worker.signalCode === null) {
      stopping.push(new Promise<void>(resolveExit => worker.once("exit", () => resolveExit())));
      worker.kill("SIGKILL");
    }
    children.delete(worker);
  };
  let peakWorkers = 0, timeoutRetries = 0;
  const deadline = started + (options.suiteTimeoutMs ?? 540000);
  const batch = async (tasks: Task[], concurrency: number) => {
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, async () => {
      let child: ChildProcess | undefined;
      try {
        while (next < tasks.length) {
          const task = tasks[next++]!, index = task.index, card = metadata[index]!;
          const cases = caseResults[index]!;
          let postponed = false;
          if (performance.now() >= deadline) {
            if (task.resume) cases.push({ ...task.resume, steps: 0, offered: [], activated: [], replayed: false,
              failure: "case timeout not confirmed" });
            incompleteCodes.add(card.code); continue;
          }
          if (!child) {
            child = fork(fileURLToPath(new URL("../new-card-smoke-worker.ts", import.meta.url)), [], { execArgv: ["--import", "tsx"],
              stdio: ["ignore", "ignore", "pipe", "ipc"], env: { ...process.env, DUEL_DATA_DIR: directory } });
            children.add(child); peakWorkers = Math.max(peakWorkers, children.size);
          }
          const worker = child;
          let budgetExpired: string | undefined;
          const formats: DuelFormat[] = options.multiCards?.includes(card.code) ? options.formats ?? ["1v1", "ffa3", "ffa4"] : ["1v1"];
          let diagnostics = "";
          const completed = await new Promise<boolean>(resolveCard => {
            let active: Pick<SmokeCase, "id" | "seed"> = { id: "worker-startup", seed: options.seed ?? card.code };
            let settled = false;
            let caseTimer: ReturnType<typeof setTimeout>;
            const incomplete = (reason: string) => {
              budgetExpired = reason; incompleteCodes.add(card.code);
              if (task.resume && !cases.some(c => c.id === task.resume!.id && c.seed === task.resume!.seed))
                cases.push({ ...task.resume, steps: 0, offered: [], activated: [], replayed: false, timeoutRetried: true,
                  failure: "case timeout not confirmed" });
              finish(false);
            };
            const cardTimer = setTimeout(() => incomplete("card time limit reached"), (options.cardTimeoutMs ?? 60000) * formats.length);
            const suiteTimer = setTimeout(() => incomplete("suite time limit reached"), Math.max(1, deadline - performance.now()));
            const stderr = (chunk: Buffer) => { diagnostics = (diagnostics + chunk.toString()).slice(-2000); };
            const finish = (healthy: boolean) => {
              if (settled) return; settled = true;
              clearTimeout(caseTimer); clearTimeout(cardTimer); clearTimeout(suiteTimer);
              worker.off("message", message); worker.off("exit", exit); worker.off("error", error); worker.stderr?.off("data", stderr);
              if (!healthy) { stop(worker); child = undefined; }
              resolveCard(healthy);
            };
            const fail = (failure: string) => {
              if (settled) return;
              cases.push({ ...active, steps: 0, offered: [], activated: [], replayed: false,
                timeoutRetried: retried.has(`${index}:${active.id}:${active.seed}`) || undefined,
                failure: failure + (diagnostics ? `: ${diagnostics.trim()}` : "") }); finish(false);
            };
            const timeout = () => {
              const key = `${index}:${active.id}:${active.seed}`;
              if (retried.has(key)) { fail("engine stall: case time limit reached after isolated retry"); return; }
              retried.add(key); deferred.push({ index, resume: { ...active } }); postponed = true; finish(false);
            };
            const exit = (code: number | null, signal: string | null) => fail(`host worker exception: exit ${signal ?? code}`);
            const error = (e: Error) => fail(`host worker exception: ${e.message}`);
            const message = (m: Message) => {
              if (settled) return;
              if (m.kind === "active") { active = m.test; clearTimeout(caseTimer); caseTimer = setTimeout(timeout, options.timeoutMs ?? 30000); }
              else if (m.kind === "case") {
                if (task.resume?.id === m.result.id && task.resume.seed === m.result.seed) m.result.timeoutRetried = true;
                cases.push(m.result); clearTimeout(caseTimer);
              }
              else if (m.kind === "done") finish(true);
              else if (m.kind === "fatal") fail(`host exception: ${m.error}`);
            };
            worker.on("message", message); worker.once("exit", exit); worker.once("error", error); worker.stderr?.on("data", stderr);
            if (task.resume) timeoutRetries++;
            worker.send({ code: card.code, directory, formats, seed: options.seed, caseId: options.caseId, limits: options.limits,
              resume: task.resume ? { test: task.resume, results: cases } : undefined }, e => { if (e) error(e); });
          });
          if (!postponed && (!budgetExpired || cases.length)) {
            results[index] = summarizeCard(card, cases, options.seed ?? card.code);
            if (budgetExpired && results[index]!.status !== "FAIL") { results[index]!.status = "WARN"; results[index]!.reason = `Incomplete: ${budgetExpired}; ${results[index]!.reason}`; }
            options.onCard?.(results[index]!);
          }
          if (!completed) child = undefined;
        }
      } finally { if (child) stop(child); }
    }));
    await Promise.all(stopping);
  };
  try {
    await batch(codes.map((_code, index) => ({ index })), jobs);
    // Every normal worker has stopped: confirmations and any remaining setups run alone.
    await batch(deferred, 1);
  } finally { for (const child of children) stop(child); await Promise.all(stopping); }
  codes.forEach((_code, index) => {
    if (!results[index] && caseResults[index]!.length) {
      results[index] = summarizeCard(metadata[index]!, caseResults[index]!, options.seed ?? metadata[index]!.code);
      if (results[index]!.status !== "FAIL") { results[index]!.status = "WARN"; results[index]!.reason = `Incomplete: suite time limit reached; ${results[index]!.reason}`; }
      incompleteCodes.add(metadata[index]!.code);
      options.onCard?.(results[index]!);
    }
  });
  codes.forEach((code, index) => { if (!results[index]) incompleteCodes.add(code); });
  return { cards: results.filter(Boolean), incomplete: incompleteCodes.size > 0, incompleteCodes: [...incompleteCodes].sort((a, b) => a - b), durationMs: performance.now() - started, jobs, peakWorkers, timeoutRetries, bundleVersion: manifest.bundleVersion, sources: manifest.sources,
    configuration: { caseTimeoutMs: options.timeoutMs ?? 30000, cardTimeoutMsPerFormat: options.cardTimeoutMs ?? 60000,
      suiteTimeoutMs: options.suiteTimeoutMs ?? 540000, baseSeed: options.seed, caseId: options.caseId, multiCards: options.multiCards ?? [],
      formats: (options.multiCards?.length ? options.formats ?? ["1v1", "ffa3", "ffa4"] : ["1v1"] as DuelFormat[]).map(format => ({ format,
        maxSteps: options.limits?.maxSteps ?? 120 * seatCountFor(format), maxTurns: options.limits?.maxTurns ?? seatCountFor(format) + 1 })) } };
}

export async function smokeWorkerCard(request: { code: number; directory: string; formats: DuelFormat[]; seed?: number; caseId?: string; limits?: SmokeLimits;
  resume?: { test: Pick<SmokeCase, "id" | "seed">; results: SmokeCaseResult[] } }): Promise<void> {
  let cases = smokeCasesForCard(request.code, request.directory, request.formats, request.seed);
  if (request.caseId) {
    const base = request.caseId.replace(/\/branch-\d+$/, "");
    cases = cases.filter(test => test.id === base).map(test => ({ ...test, id: request.caseId!, seed: request.seed ?? test.seed }));
    if (!cases.length) throw new Error(`Unknown case ${request.caseId} for ${request.code}`);
  }
  const results: SmokeCaseResult[] = [...request.resume?.results ?? []];
  const run = async (test: SmokeCase) => {
    process.send?.({ kind: "active", test: { id: test.id, seed: test.seed } } satisfies Message);
    const result = await runSmokeCase(test, request.directory, request.limits);
    results.push(result);
    process.send?.({ kind: "case", result } satisfies Message);
  };
  if (request.resume) {
    const test = request.resume.test, base = cases.find(c => c.id === test.id || c.id === test.id.replace(/\/branch-\d+$/, ""));
    if (!base) throw new Error(`Unknown recovery case ${test.id}`);
    await run({ ...base, ...test });
    if (results.at(-1)?.failure) { process.send?.({ kind: "done" } satisfies Message); return; }
  }
  for (const test of cases) if (!results.some(r => r.id === test.id)) await run(test);
  // Mutually exclusive operation modes need separate duels. Replay uncovered modes on their original setup.
  const retries = new Map<string, number>();
  const description = loadCardDatabase(request.directory).get(request.code)!.description;
  for (let retry = results.filter(r => /\/branch-\d+$/.test(r.id)).length; !request.caseId && retry < 8 * request.formats.length; retry++) {
    const group = smokeGroup;
    const uncovered = (test: SmokeCaseResult) => smokeMissingEffect(results, test, description, retries);
    const parent = smokeRetryParent(results, description, retries);
    if (!parent) break;
    const missing = uncovered(parent)!;
    const retryKey = `${group(parent)}:${missing}`; retries.set(retryKey, (retries.get(retryKey) ?? 0) + 1);
    const expected = smokeExpectedEffects(results, description);
    const modes = [...expected.values()].filter(e => e.parent && e.parent === expected.get(missing)?.parent);
    const index = modes.findIndex(e => e.id === missing);
    const setups = cases.filter(test => test.id.startsWith(group(parent)));
    const original = setups.findIndex(test => parent.id.startsWith(test.id));
    const base = index >= 0 ? setups[original]! : setups[(original + 1 + retry) % setups.length]!;
    const used = new Set(results.filter(r => r.id.replace(/\/branch-\d+$/, "") === base.id).map(r => r.seed));
    const seed = smokeRetrySeed(request.code, (parent.seed + 1) >>> 0, used, index, modes.length);
    await run({ ...base, id: `${base.id}/branch-${retry + 1}`, seed });
  }
  process.send?.({ kind: "done" } satisfies Message);
}
