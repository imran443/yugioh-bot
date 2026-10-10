import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadCardDatabase } from "../src/cards.js";
import { changedSmokeCodes, changedSmokePins, parseSmokeArgs, readSmokePins, smokeSetCodes, snapshotSmokeBundle, shardSmokeCodes } from "./lib/new-card-smoke-data.js";
import { renderSmokeMarkdown, runSmokePool, type SmokeReport } from "./lib/new-card-smoke-pool.js";

export const smokeExitCode = (report: SmokeReport): number => report.cards.some(card => card.status === "FAIL") ? 1 : report.incomplete ? 3 : 0;

export async function newCardSmokeMain(args = process.argv.slice(2)): Promise<number> {
  const options = parseSmokeArgs(args);
  if (options.help) {
    console.log(`New card engine smoke (Node 22)
  --cards 123,456 | --set BETB | --from-pin A --to-pin B | --from-bundle OLD --to-bundle NEW
  Pins: repository Git refs or JSON files with scripts/database/strings (or manifest.sources).
  Default: origin/main pins compared with the prepared DUEL_DATA_DIR.
  --data-dir DIR (or DUEL_DATA_DIR) --output PATH_PREFIX --jobs 1..8 (default 4)
  --seed N --timeout MS --max-steps N --max-turns N --multi-cards CODES --multi-angelechy
  --shard i/N (one-based passcode hash shard); case timeout defaults to 30000 ms.
  --cards CODE --case CASE_ID --seed CASE_SEED replays one exact setup (including FFA).
  Outputs PATH_PREFIX.json and PATH_PREFIX.md; exits 1 for FAIL, 0 for PASS/WARN, 2 for input/download errors, 3 for incomplete only.`);
    return 0;
  }
  const root = fileURLToPath(new URL("../../..", import.meta.url));
  const directory = resolve(options["to-bundle"] ?? options["data-dir"] ?? process.env.DUEL_DATA_DIR ?? join(root, "data/duel-engine-next"));
  const started = performance.now();
  // Selection downloads share the nine-minute suite budget. No workers exist during this watchdog.
  const selection = new AbortController();
  const selectionTimer = setTimeout(() => selection.abort(new Error("Card selection exceeded the suite time limit")), 540000);
  const request: typeof fetch = (url, init) => fetch(url, { ...init, signal: AbortSignal.any([selection.signal, ...(init?.signal ? [init.signal] : [])]) });
  let codes: number[];
  try {
    if (options.cards) codes = options.cards;
    else if (options.set) codes = await smokeSetCodes(options.set, directory, request);
    else if (options["from-bundle"]) codes = changedSmokeCodes(snapshotSmokeBundle(resolve(options["from-bundle"])), snapshotSmokeBundle(directory));
    else {
      const manifest = JSON.parse(readFileSync(join(directory, "manifest.json"), "utf8"));
      codes = await changedSmokePins(readSmokePins(options["from-pin"] ?? "origin/main"), options["to-pin"] ? readSmokePins(options["to-pin"]) : manifest.sources, directory, request);
    }
  } finally { clearTimeout(selectionTimer); }
  codes = shardSmokeCodes(codes, options.shard);
  const cards = loadCardDatabase(directory);
  const multiCards = options.case?.includes("/ffa") ? codes : options.multiCards ?? (options["multi-angelechy"] ? codes.filter(code => cards.get(code)?.name.startsWith("Angelechy")) : []);
  const report = await runSmokePool(codes, directory, { jobs: options.jobs, seed: options.seed, timeoutMs: options.timeoutMs,
    suiteTimeoutMs: Math.max(1, Math.floor(540000 - (performance.now() - started))), caseId: options.case,
    limits: { maxSteps: options.maxSteps, maxTurns: options.maxTurns }, multiCards,
    onCard: card => process.stderr.write(`${card.code} ${card.status} ${card.name}\n`) });
  report.durationMs = performance.now() - started;
  report.configuration!.invocation = args;
  report.configuration!.shard = options.shard;
  const prefix = resolve(options.output ?? join(root, ".status/new-card-smoke")); await mkdir(dirname(prefix), { recursive: true });
  await writeFile(`${prefix}.json`, JSON.stringify(report, null, 2) + "\n");
  const markdown = renderSmokeMarkdown(report); await writeFile(`${prefix}.md`, markdown);
  process.stdout.write(markdown);
  return smokeExitCode(report);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { process.exitCode = await newCardSmokeMain(); }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 2; }
}
