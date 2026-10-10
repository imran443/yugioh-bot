import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import {
  detectOverlayConflicts, diffScripts, findNewRisks, findListedChanges, readPins, rewritePins, runUpdate, githubOutput,
  type Pins,
} from "../scripts/update-engine-data.js";

import { MULTIPLAYER_FORBIDDEN } from "../src/banlists/multiplayer.js";
import { reconcile, scanText } from "../scripts/scan-multiplayer-scripts.js";
import { withCardUpdate } from "../scripts/engine-data-card-report.js";
import * as smoke from "../scripts/prerelease-script-smoke.js";
import * as probe from "../scripts/probe-engine-data.js";
import * as history from "../scripts/prerelease-history.js";
import * as releasedData from "../scripts/released-card-data.js";
import { CardRemapValidationError } from "../scripts/prerelease-graduations.js";

const oldPins: Pins = { scripts: "a".repeat(40), database: "b".repeat(40), strings: "c".repeat(40) };
const nextPins: Pins = { scripts: "d".repeat(40), database: "e".repeat(40), strings: "f".repeat(40) };
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const temporary: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(temporary.splice(0).map((p) => rm(p, { recursive: true, force: true }))); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "engine-data-test-"));
  temporary.push(root);
  execFileSync("git", ["init", "-q", root]);
  const corePins = JSON.stringify({ ygoproCore: { commit: "1".repeat(40) }, cardScripts: { repository: "https://github.com/ProjectIgnis/CardScripts", commit: oldPins.scripts } });
  const files = {
    "packages/duel-server/scripts/prepare-data.ts": `const sources = ${JSON.stringify({ corePackage: "ocgcore-wasm@0.1.2", ...oldPins })};`,
    "packages/duel-server/domain-core/pins.json": corePins,
    "packages/duel-server/legacy-1v1/domain-core/pins.json": corePins,
    "packages/duel-server/card-script-patches/MANIFEST.json": "[]\n",
  };
  for (const [file, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, file)), { recursive: true });
    await writeFile(join(root, file), content);
  }
  execFileSync("git", ["-C", root, "add", "."]);
  return { root, files };
}

async function loadedDataFixture(change: string) {
  const { root } = await fixture();
  const manifest = join(root, "packages/duel-server/domain-core/multi-scripts/MANIFEST.json");
  await mkdir(dirname(manifest), { recursive: true });
  await writeFile(manifest, '{"cards":[]}');
  const corpus = join(root, "corpus");
  await mkdir(join(corpus, "official"), { recursive: true });
  await writeFile(join(corpus, "official/c1.lua"), "-- playable");
  await writeFile(join(corpus, "utility.lua"), "-- helper");
  const archive = execFileSync("tar", ["-czf", "-", "-C", root, "corpus"]);
  const inputs: Array<Map<string, Buffer>> = [];
  for (const candidate of [false, true]) {
    const databases = new Map<string, Buffer>();
    const makeDatabase = async (file: string, rows: Array<[number, string]>) => {
      const path = join(root, `${candidate}-${file}`), db = new Database(path);
      db.exec("CREATE TABLE datas(id INTEGER PRIMARY KEY,ot INTEGER,alias INTEGER,type INTEGER); CREATE TABLE texts(id INTEGER PRIMARY KEY,name TEXT,desc TEXT)");
      for (const [code, name] of rows) {
        db.prepare("INSERT INTO datas VALUES(?,3,0,33)").run(code);
        db.prepare("INSERT INTO texts VALUES(?,?,'Effect')").run(code, name);
      }
      db.close(); databases.set(file, await readFile(path));
    };
    await makeDatabase("cards.cdb", [[1, "Playable"], ...(change === "ambiguous-old" ? [[2, "Second identity"] as [number, string]] : [])]);
    if (change === "graduation" && !candidate) await makeDatabase("prerelease-betb.cdb", [[100000001, "Graduating card"]]);
    if (["graduation", "new-release"].includes(change) && candidate) await makeDatabase("release-betb.cdb", [[2, "Graduating card"]]);
    if (change === "ambiguous-old" && !candidate) {
      await makeDatabase("prerelease-betb.cdb", [[100000001, "Playable"]]);
      await makeDatabase("prerelease-conflict.cdb", [[100000001, "Second identity"]]);
    }
    if (change === "pending-set") await makeDatabase("prerelease-betb.cdb", [[100000001, "Preview"]]);
    inputs.push(databases);
  }
  if (change === "graduation") {
    const preparation = join(root, "packages/duel-server/scripts/prepare-data.ts");
    await writeFile(preparation, (await readFile(preparation, "utf8")) + `\nconst history = { prereleaseHistoryStart: "${"1".repeat(40)}" };\n`);
    vi.spyOn(history, "prereleaseHistory").mockResolvedValue({
      cards: [{ code: 100000001, name: "Graduating card", type: 33 }], transitions: [],
    });
  }
  const request = vi.fn(async (input: string | URL | Request) => {
    const url = String(input), candidate = Object.values(nextPins).some(sha => url.includes(sha));
    if (url.includes("/commits?")) return Response.json([{ sha: url.includes("CardScripts") ? oldPins.scripts
      : url.includes("BabelCDB") ? oldPins.database : oldPins.strings }]);
    if (url.includes("/compare/")) return Response.json({ ahead_by: 1, behind_by: 0, status: "ahead" });
    if (url.includes("/git/trees/")) return Response.json({ truncated: false, tree: url.includes("BabelCDB")
      ? [...inputs[candidate ? 1 : 0]!.keys()].map(path => ({ path, type: "blob", sha: path }))
      : [{ path: "official/c1.lua", type: "blob", sha: "unchanged" },
        { path: "utility.lua", type: "blob", sha: candidate && change === "utility" ? "changed-helper" : "helper" }] });
    if (url.endsWith(".cdb")) {
      const bytes = inputs[candidate ? 1 : 0]!.get(url.split("/").pop()!);
      if (bytes) return new Response(new Uint8Array(bytes));
    }
    if (url.endsWith("/strings.conf")) return new Response("strings");
    if (url.includes("codeload.github.com")) return new Response(new Uint8Array(archive));
    if (url.includes("ygoprodeck")) return Response.json(url.includes("cardsets.php")
      ? [{ set_name: "Beyond the Brave", set_code: "BETB", tcg_date: "2026-10-08" }] : { data: [] });
    throw new Error(`Unexpected request: ${url}`);
  });
  return { root, request };
}

describe("engine data update", () => {
  it.each(["identical", "utility", "cards", "strings", "remaps", "remap-error", "no-pr"])("compares loaded data with the open PR (%s)", async change => {
    const { root, request: upstream } = await loadedDataFixture(change === "utility" ? "utility" : change === "cards" ? "new-release" : "identical");
    const prHead = "2".repeat(40);
    const prPins = { scripts: "3".repeat(40), database: "4".repeat(40), strings: "5".repeat(40) };
    const request = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.startsWith("https://api.github.com/repos/test/repo/pulls?")) return Response.json(change === "no-pr" ? []
        : [{ head: { sha: prHead } }]);
      if (url.startsWith("https://api.github.com/repos/test/repo/contents/")) {
        expect(new URL(url).searchParams.get("ref")).toBe(prHead);
        return Response.json({ encoding: "base64", content: Buffer.from(`const sources = ${JSON.stringify(prPins)};`).toString("base64") });
      }
      if (change === "strings" && url.endsWith("/strings.conf") && url.includes(nextPins.strings)) return new Response("changed strings");
      let mapped = url;
      for (const key of Object.keys(prPins) as (keyof Pins)[]) mapped = mapped.replaceAll(prPins[key], oldPins[key]);
      return upstream(mapped);
    });
    // Ensure publication is reached even when candidate and PR data match: main's
    // unavailable snapshot opens its gate without affecting the PR comparison.
    const download = releasedData.downloadReleasedCardData;
    vi.spyOn(releasedData, "downloadReleasedCardData").mockImplementation(async (commit, ...args) => {
      if (commit === oldPins.database || (change === "remap-error" && commit === prPins.database)) {
        throw new CardRemapValidationError("Ambiguous prerelease passcode 100000001");
      }
      const data = await download(commit, ...args);
      return change === "remaps" && commit === nextPins.database ? { ...data, remaps: { "100000001": 1 } } : data;
    });
    const result = await runUpdate({ root, overrides: nextPins, request, validate: false, repository: "test/repo" });
    expect(result.changed).toBe(true);
    expect(result.matchingPrHead).toBe(change === "identical" ? prHead : undefined);
  });

  it("continues the update when the open PR comparison API fails", async () => {
    const { root, request: upstream } = await loadedDataFixture("utility");
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const request = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.startsWith("https://api.github.com/repos/test/repo/pulls?")) {
        return Response.json([{ head: { sha: "2".repeat(40) } }]);
      }
      if (url.startsWith("https://api.github.com/repos/test/repo/contents/")) {
        return new Response("Service unavailable", { status: 503 });
      }
      return upstream(input);
    });
    const result = await runUpdate({ root, overrides: nextPins, request, validate: false, repository: "test/repo" });
    expect(result.changed).toBe(true);
    expect(result.matchingPrHead).toBeUndefined();
    expect(await readPins(root)).toEqual(nextPins);
    expect(result.files).toContain("packages/duel-server/scripts/prepare-data.ts");
    expect(warning).toHaveBeenCalledWith(expect.stringContaining("Open PR comparison failed"),
      expect.objectContaining({ message: expect.stringContaining("Download failed (503)") }));
  });

  it.each([false, true])("includes released upstream previews in the job summary when pins moved=%s", async moved => {
    const { root, request } = await loadedDataFixture("pending-set");
    const result = await runUpdate({ root, overrides: moved ? nextPins : oldPins, request, validate: false, report: ".status/report.md" });
    expect(result.changed).toBe(false);
    expect(result.files).toEqual([]);
    expect(await readPins(root)).toEqual(oldPins);
    expect(request.mock.calls.some(([url]) => String(url).includes("codeload"))).toBe(false);
    await writeFile(join(dirname(result.reportPath), "update.json"), JSON.stringify(result));
    const summary = join(root, "summary.md");
    execFileSync(process.execPath, ["--import", "tsx", resolve(import.meta.dirname, "../scripts/validate-engine-data.ts")], {
      cwd: process.cwd(), env: { ...process.env, UPDATE_ARTIFACT_DIR: dirname(result.reportPath),
        DUEL_DATA_DIR: join(root, "absent-bundle"), GITHUB_STEP_SUMMARY: summary,
        GITHUB_REPOSITORY: "test/repo", GITHUB_RUN_ID: "1" },
    });
    expect(await readFile(summary, "utf8")).toContain("Beyond the Brave (BETB)");
    expect(await readFile(summary, "utf8")).toContain("TCG release: 2026-10-08; 1 cards");
  });

  it.each(["invalid-override", "cyclic"])("opens the gate when old remap validation fails (%s)", async failure => {
    const { root, request } = await loadedDataFixture(failure === "invalid-override" ? "graduation" : "identical");
    if (failure === "invalid-override") {
      const download = releasedData.downloadReleasedCardData;
      vi.spyOn(releasedData, "downloadReleasedCardData").mockImplementation((commit, directory, request, options) =>
        download(commit, directory, request, { ...options, overrideBytes: '{"100000001":2}' }));
    } else {
      const preparation = join(root, "packages/duel-server/scripts/prepare-data.ts");
      await writeFile(preparation, (await readFile(preparation, "utf8")) + `\nconst history = { prereleaseHistoryStart: "${"1".repeat(40)}" };\n`);
      const identity = { name: "Historical card", type: 33, atk: 1000, def: 1000, level: 4,
        attribute: 1, race: "1", description: "An effect description long enough to match historical graduations uniquely." };
      vi.spyOn(history, "prereleaseHistory").mockImplementation(async (_start, commit) => ({ cards: [],
        transitions: commit === oldPins.database ? [
          { commit: "first", removed: [{ ...identity, code: 2 }], added: [{ ...identity, code: 3 }] },
          { commit: "second", removed: [{ ...identity, code: 3 }], added: [{ ...identity, code: 2 }] },
        ] : [] }));
    }
    const result = await runUpdate({ root, overrides: nextPins, request, validate: false });
    expect(result.changed).toBe(true);
    expect(result.relevance).toMatchObject({ comparisonAvailable: false, newCards: null, changedCards: null });
    expect(await readPins(root)).toEqual(nextPins);
    expect(await readFile(result.reportPath, "utf8")).toContain(failure === "invalid-override"
      ? "Invalid card remap override 100000001" : "Cyclic historical prerelease passcode");
  });

  it("still rejects unrelated old-snapshot download failures", async () => {
    const { root, request } = await loadedDataFixture("identical");
    const download = releasedData.downloadReleasedCardData;
    vi.spyOn(releasedData, "downloadReleasedCardData").mockImplementation((commit, ...args) => {
      if (commit === oldPins.database) throw new Error("Download failed (500)");
      return download(commit, ...args);
    });
    await expect(runUpdate({ root, overrides: nextPins, request, validate: false })).rejects.toThrow("Download failed (500)");
    expect(await readPins(root)).toEqual(oldPins);
  });

  it.each(["graduation", "new-release", "utility", "ambiguous-old"])("opens the end-to-end gate for %s", async change => {
    const { root, request } = await loadedDataFixture(change);
    const overrides = change === "utility" ? { ...oldPins, scripts: nextPins.scripts } : nextPins;
    const result = await runUpdate({ root, overrides, request, validate: false });
    expect(result.changed).toBe(true);
    expect(await readPins(root)).toEqual(overrides);
    expect(result.files).toContain("packages/duel-server/scripts/prepare-data.ts");
    expect(githubOutput(result)).toContain("changed=true");
    if (change === "graduation") {
      expect(result.relevance).toMatchObject({ newCards: 1, removedCards: 1, remapsChanged: true });
      expect(result.cardChanges?.graduated).toMatchObject([{ oldCode: 100000001, code: 2 }]);
    } else if (change === "new-release") {
      expect(result.relevance).toMatchObject({ newCards: 1, changedCards: 0 });
      expect(await readFile(result.reportPath, "utf8")).toContain("Added release databases: `release-betb.cdb`");
    } else if (change === "utility") {
      expect(result.relevance).toMatchObject({ newCards: 0, changedCards: 0, removedCards: 0,
        changedScripts: ["utility.lua"], stringsChanged: false, remapsChanged: false });
    } else {
      expect(result.relevance).toMatchObject({ comparisonAvailable: false, newCards: null, changedCards: null });
      expect(await readFile(result.reportPath, "utf8")).toContain("Ambiguous prerelease passcode");
    }
  });
  it.each(["irrelevant", "rush-row", "rush-orphan", "card-text", "script", "strings"])("gates moved pins using loaded data (%s)", async change => {
    const { root } = await fixture();
    const manifestPath = join(root, "packages/duel-server/domain-core/multi-scripts/MANIFEST.json");
    await mkdir(dirname(manifestPath), { recursive: true });
    await writeFile(manifestPath, '{"cards":[]}');
    const corpus = join(root, "corpus");
    await mkdir(join(corpus, "official"), { recursive: true });
    await writeFile(join(corpus, "official/c1.lua"), "-- playable");
    await mkdir(join(corpus, "rush"));
    await writeFile(join(corpus, "rush/c999.lua"), "-- rush");
    await writeFile(join(corpus, "official/c999.lua"), "-- rush");
    const archive = execFileSync("tar", ["-czf", "-", "-C", root, "corpus"]);
    const bytes: Buffer[] = [];
    for (const candidate of [false, true]) {
      const path = join(root, `${candidate}.cdb`), db = new Database(path);
      db.exec("CREATE TABLE datas(id INTEGER PRIMARY KEY,ot INTEGER,alias INTEGER,type INTEGER); CREATE TABLE texts(id INTEGER PRIMARY KEY,name TEXT,desc TEXT); INSERT INTO datas VALUES(1,3,0,33),(999,512,0,33); INSERT INTO texts VALUES(1,'Playable','Effect'),(999,'Rush','Effect')");
      if (change === "rush-orphan") {
        db.exec("DELETE FROM texts WHERE id=999");
        if (candidate) db.exec("UPDATE datas SET type=17 WHERE id=999");
      }
      if (candidate && change === "rush-row") db.exec("UPDATE texts SET desc='Rush edit' WHERE id=999");
      if (candidate && change === "card-text") db.exec("UPDATE texts SET desc='Playable edit' WHERE id=1");
      db.close(); bytes.push(await readFile(path));
    }
    const request = vi.fn(async (input: string | URL | Request) => {
      const url = String(input), candidate = Object.values(nextPins).some(sha => url.includes(sha));
      if (url.includes("/compare/")) return Response.json({ ahead_by: 1, behind_by: 0, status: "ahead" });
      if (url.includes("/git/trees/")) return Response.json({ truncated: false, tree: url.includes("BabelCDB") ? [
        { path: "cards.cdb", type: "blob", sha: candidate ? "new-db" : "old-db" },
        { path: "prerelease-rush.cdb", type: "blob", sha: candidate ? "new-rush" : "old-rush" },
        { path: "unused.cdb", type: "blob", sha: candidate ? "new-unused" : "old-unused" },
      ] : [
        { path: "official/c1.lua", type: "blob", sha: candidate && change === "script" ? "fix" : "unchanged" },
        ...(change === "rush-orphan" ? [] : [{ path: "rush/c999.lua", type: "blob", sha: candidate ? "new-rush" : "old-rush" }]),
        { path: "official/c999.lua", type: "blob", sha: candidate ? "new-rush" : "old-rush" },
        { path: "README.md", type: "blob", sha: candidate ? "new-docs" : "old-docs" },
      ] });
      if (url.endsWith("/cards.cdb")) return new Response(new Uint8Array(bytes[candidate ? 1 : 0]!));
      if (url.endsWith("/strings.conf")) return new Response(candidate && change === "strings" ? "changed" : "strings");
      if (url.includes("codeload.github.com")) return new Response(new Uint8Array(archive));
      if (url.includes("ygoprodeck")) return Response.json(url.includes("cardsets.php") ? [] : { data: [] });
      throw new Error(`Unexpected request: ${url}`);
    });
    const result = await runUpdate({ root, overrides: nextPins, request, validate: false, report: ".status/report.md" });
    const relevant = !["irrelevant", "rush-row", "rush-orphan"].includes(change);
    expect(result.changed).toBe(relevant);
    expect(await readPins(root)).toEqual(relevant ? nextPins : oldPins);
    const report = await readFile(result.reportPath, "utf8");
    expect(report).toContain("## Relevance gate");
    if (!relevant) {
      expect(result.files).toEqual([]);
      expect(githubOutput(result)).toContain("changed=false");
      expect(report).toContain("upstream pins moved, but no loaded card rows, scripts, strings or remaps changed");
      expect(request.mock.calls.some(([url]) => String(url).includes("codeload"))).toBe(false);
      await writeFile(join(dirname(result.reportPath), "update.json"), JSON.stringify(result));
      const summaryPath = join(root, "summary.md");
      execFileSync(process.execPath, ["--import", "tsx", resolve(import.meta.dirname, "../scripts/validate-engine-data.ts")], {
        cwd: process.cwd(), env: { ...process.env, UPDATE_ARTIFACT_DIR: dirname(result.reportPath), DUEL_DATA_DIR: join(root, "absent-bundle"),
          GITHUB_STEP_SUMMARY: summaryPath, GITHUB_REPOSITORY: "test/repo", GITHUB_RUN_ID: "1" },
      });
      expect(await readFile(summaryPath, "utf8")).toContain("upstream pins moved, but no loaded card rows, scripts, strings or remaps changed");
    } else {
      expect(report).toContain(`Changed cards: ${change === "card-text" ? 1 : 0}`);
      expect(report).toContain(`Changed scripts: ${change === "script" ? 1 : 0}`);
      expect(report).not.toContain("Changed shared scripts (1)");
    }
  });
  it("scans newly playable release scripts for multiplayer risk while excluding unrelated pre-release cards", () => {
    const stock = new Map([
      ["pre-release/c17242022.lua", "Duel.GetFieldGroup(tp,LOCATION_HAND,LOCATION_HAND)"],
      ["pre-release/c999.lua", "Duel.GetFieldGroup(tp,LOCATION_HAND,LOCATION_HAND)"],
    ]);
    expect(findNewRisks(stock, [...stock.keys()], new Set(), new Set([17242022])).map(card => card.code)).toEqual([17242022]);
  });
  it("diffs full official script lists, including removals, without counting helpers or unofficial cards", () => {
    const old = new Map([["official/c1.lua", "one"], ["official/c2.lua", "two"], ["official/c3.lua", "three"]]);
    const next = new Map([["official/c1.lua", "one"], ["official/c2.lua", "changed"], ["official/c4.lua", "four"], ["utility.lua", "helper"], ["unofficial/c5.lua", "five"]]);
    expect(diffScripts(old, next)).toEqual({ added: ["official/c4.lua"], changed: ["official/c2.lua"], removed: ["official/c3.lua"] });
  });

  it("reports changed, missing, and unrecorded stock hashes, never silently refreshing the manifest", () => {
    const cards = [1, 2, 3, 4].map((code) => ({ code, file: `c${code}.lua`, stockSha256: code === 4 ? undefined : sha256("original") }));
    const before = JSON.stringify(cards);
    expect(detectOverlayConflicts(cards, new Map([["official/c1.lua", "original"], ["official/c2.lua", "edited"], ["official/c4.lua", "new"]]))).toEqual([
      { ...cards[1], actualSha256: sha256("edited") }, { ...cards[2], actualSha256: null }, { ...cards[3], actualSha256: sha256("new") },
    ]);
    expect(JSON.stringify(cards)).toBe(before);
  });

  it("reports removed when only a nonofficial script remains, matching overlay generator hashing", () => {
    const cards = [{ code: 1, file: "c1.lua", stockSha256: sha256("pre-errata") }];
    expect(detectOverlayConflicts(cards, new Map([["pre-errata/c1.lua", "pre-errata"]]))).toEqual([{ ...cards[0], actualSha256: null }]);
  });

  it("checks an explicitly reviewed pre-errata baseline without falling back to another script", () => {
    const card = { code: 5043020, file: "c5043020.lua", stockPath: "pre-errata/c5043020.lua", stockSha256: sha256("original") };
    expect(detectOverlayConflicts([card], new Map([[card.stockPath, "original"]]))).toEqual([]);
    expect(detectOverlayConflicts([card], new Map([[card.stockPath, "changed"]]))).toEqual([{ ...card, actualSha256: sha256("changed") }]);
    expect(detectOverlayConflicts([card], new Map([[`official/${card.file}`, "original"]]))).toEqual([{ ...card, actualSha256: null }]);
  });

  it("synchronizes all three pin files, leaving non-data core pins untouched", async () => {
    const { root, files } = await fixture();
    const rewritten = await rewritePins(root, oldPins, nextPins, false);
    expect(rewritten.sort()).toEqual(Object.keys(files).filter(file => file !== "packages/duel-server/card-script-patches/MANIFEST.json").sort());
    for (const [file, original] of Object.entries(files)) {
      let expected = original;
      for (const key of Object.keys(oldPins) as (keyof Pins)[]) expected = expected.replaceAll(oldPins[key], nextPins[key]);
      expect(await readFile(join(root, file), "utf8")).toBe(expected);
    }
    expect(await readPins(root)).toEqual(nextPins);
  });

  it("discovers every current tracked occurrence without modifying the real repository", async () => {
    const root = resolve(import.meta.dirname, "../../..");
    const pins = await readPins(root);
    const matches = execFileSync("git", ["grep", "-l", "-E", Object.values(pins).join("|")], { cwd: root, encoding: "utf8" }).trim().split("\n");
    expect((await rewritePins(root, pins, nextPins, true)).sort()).toEqual(matches.sort());
  });

  it("dry-run discovers rewrites but writes no pins", async () => {
    const { root, files } = await fixture();
    expect(await rewritePins(root, oldPins, nextPins, true)).toHaveLength(3);
    for (const [file, original] of Object.entries(files)) expect(await readFile(join(root, file), "utf8")).toBe(original);
  });

  it("limits new risks to new/changed flagged scripts not in the existing lists", () => {
    // The existing scanner flags per-player Lua tables as F.
    const source = "s.player_state[tp]=false\n";
    const scripts = new Map([["official/c999999991.lua", source], ["official/c999999992.lua", source], ["official/c999999993.lua", "Duel.Draw(tp,1,REASON_EFFECT)"]]);
    expect(findNewRisks(scripts, ["official/c999999991.lua", "official/c999999993.lua"], new Set())).toMatchObject([{ code: 999999991, cls: "F", flagged: true }]);
    expect(findNewRisks(scripts, ["official/c999999991.lua"], new Set([999999991]))).toEqual([]);
  });

  it("returns no update with mocked API heads and reports current data without modifying pins", async () => {
    const { root, request } = await loadedDataFixture("identical");
    const result = await runUpdate({ root, report: ".status/report.md", request });
    expect(result.changed).toBe(false);
    expect(request.mock.calls.filter(([url]) => String(url).includes("/commits?"))).toHaveLength(3);
    expect(request.mock.calls.some(([url]) => String(url).includes("codeload"))).toBe(false);
    expect(await readPins(root)).toEqual(oldPins);
    expect(await readFile(join(root, ".status/report.md"), "utf8")).toContain("no update");
    expect(await readFile(join(root, ".status/report.md"), "utf8")).toContain("prod error data unavailable");
  });

  it("accepts unchanged overrides and rejects malformed SHAs before any requests", async () => {
    const { root, request } = await loadedDataFixture("identical");
    expect((await runUpdate({ root, overrides: oldPins, request })).changed).toBe(false);
    request.mockClear();
    await expect(runUpdate({ root, overrides: { scripts: "main; echo nope" }, request })).rejects.toThrow(/40.*hex/i);
    expect(request).not.toHaveBeenCalled();
  });

  it.each([
    [true, nextPins, "unchanged", undefined], [false, nextPins, "unchanged", undefined],
    [false, { ...oldPins, database: nextPins.database }, "unchanged", undefined],
    [false, nextPins, "unchanged", "old"], [false, nextPins, "unchanged", "next"],
    [false, nextPins, "changed", undefined], [true, nextPins, "changed", undefined],
    [false, nextPins, "missing", undefined],
    [true, nextPins, "unchanged", undefined, true],
  ] as const)("reports a complete mocked update (dryRun=%s, pins=%j, patch=%s, ambiguous=%s), preserving overlays and core pins", async (dryRun, overrides, patchState, ambiguous, inline: boolean = false) => {
    const { root, files } = await fixture();
    const manifest = { cards: [{ code: 1, file: "c1.lua", name: "Old card", stockSha256: sha256("old") }] };
    const manifestPath = join(root, "packages/duel-server/domain-core/multi-scripts/MANIFEST.json");
    await mkdir(dirname(manifestPath), { recursive: true });
    await writeFile(manifestPath, JSON.stringify(manifest));
    const stock = join(root, "stock/official");
    await mkdir(stock, { recursive: true });
    await writeFile(join(stock, "c1.lua"), "s.state[tp]=true\n");
    await writeFile(join(stock, "c2.lua"), "-- new script\n");
    await writeFile(join(stock, "c3.lua"), "-- old script\n");
    await mkdir(join(stock, "../pre-release"));
    await writeFile(join(stock, "../pre-release/c100000002.lua"), "-- preview script already exists upstream\n");
    await writeFile(join(stock, "../utility.lua"), "-- shared change\n");
    const patchManifestPath = join(root, "packages/duel-server/card-script-patches/MANIFEST.json");
    const patches = [{ stockPath: patchState === "missing" ? "official/c3743515.lua" : "official/c1.lua",
      stockSha256: sha256(patchState === "unchanged" ? "s.state[tp]=true\n" : "old"), suffix: "c1.lua" }];
    await writeFile(patchManifestPath, JSON.stringify(patches));
    const archive = execFileSync("tar", ["-czf", "-", "-C", root, "stock"]);
    const dbPath = join(root, "cards.cdb");
    const db = new Database(dbPath);
    db.exec("CREATE TABLE datas (id INTEGER PRIMARY KEY,ot INTEGER,alias INTEGER,type INTEGER); INSERT INTO datas VALUES (1,3,0,33); CREATE TABLE texts (id INTEGER PRIMARY KEY, name TEXT); INSERT INTO texts VALUES (1, '@reviewer Changed #123 card');");
    db.close();
    const database = await readFile(dbPath);
    const releasePath = join(root, "release-new.cdb");
    const releaseDb = new Database(releasePath);
    releaseDb.exec("CREATE TABLE datas (id INTEGER PRIMARY KEY,ot INTEGER,alias INTEGER,type INTEGER); INSERT INTO datas VALUES (2,3,0,33); CREATE TABLE texts (id INTEGER PRIMARY KEY, name TEXT); INSERT INTO texts VALUES (2, 'New card');");
    releaseDb.close();
    const release = await readFile(releasePath);
    const makePreview = async (file: string, rows: Array<[number,string]>) => {
      const path = join(root,file), db = new Database(path);
      db.exec("CREATE TABLE datas (id INTEGER PRIMARY KEY,ot INTEGER,alias INTEGER,type INTEGER); CREATE TABLE texts (id INTEGER PRIMARY KEY,name TEXT)");
      for (const [code,name] of rows) {
        db.prepare("INSERT INTO datas VALUES(?,3,0,33)").run(code);
        db.prepare("INSERT INTO texts VALUES(?,?)").run(code,name);
      }
      db.close(); return readFile(path);
    };
    const oldRelease = await makePreview("old-release.cdb",[]);
    const oldPreview = await makePreview("old-preview.cdb",[[100000001,"New card"],[100000003,"Withdrawn preview"]]);
    const conflictingPreview = await makePreview("conflicting-preview.cdb",[[100000001,"@reviewer Changed #123 card"]]);
    const nextPreview = await makePreview("next-preview.cdb",[[ambiguous === "next" ? 100000001 : 100000002,"New preview"]]);
    const request = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/compare/")) return Response.json({ ahead_by: 2, behind_by: 0, status: "ahead" });
      if (url.includes("/git/trees/")) {
        if (url.includes("/BabelCDB/")) return Response.json({ truncated: false, tree: [
          { path: "cards.cdb", type: "blob", sha: "base" },
          { path: "prerelease-test.cdb", type: "blob", sha: "preview" },
          ...(ambiguous === (url.includes(oldPins.database) ? "old" : "next") ? [{path:"prerelease-conflict.cdb",type:"blob",sha:"conflict"}] : []),
          { path: url.includes(oldPins.database) ? "release-old.cdb" : "release-new.cdb", type: "blob", sha: "release" },
        ] });
        const old = url.includes(oldPins.scripts);
        return Response.json({ truncated: false, tree: [
          { path: "utility.lua", type: "blob", sha: old ? "old-helper" : "new-helper" },
          { path: "pre-release/c100000002.lua", type: "blob", sha: "unchanged-preview-script" },
          { path: "official/c1.lua", type: "blob", sha: old ? "old" : "changed" },
          { path: overrides.scripts === oldPins.scripts ? "official/c2.lua" : old ? "official/c3.lua" : "official/c2.lua", type: "blob", sha: "other" },
        ] });
      }
      if (url.includes("codeload.github.com")) return new Response(new Uint8Array(archive));
      if (url.endsWith("/cards.cdb")) return new Response(new Uint8Array(database));
      if (url.endsWith("/release-new.cdb")) return new Response(new Uint8Array(release));
      if (url.endsWith("/release-old.cdb")) return new Response(new Uint8Array(oldRelease));
      if (url.endsWith("/prerelease-conflict.cdb")) return new Response(new Uint8Array(conflictingPreview));
      if (url.endsWith("/prerelease-test.cdb")) return new Response(new Uint8Array(url.includes(oldPins.database) ? oldPreview : nextPreview));
      if (url.endsWith("/strings.conf")) return new Response("");
      throw new Error(`Unexpected request: ${url}`);
    });
    if (ambiguous === "next") {
      await expect(runUpdate({root,overrides,dryRun,request,validate:false})).rejects.toThrow(/Ambiguous/);
      expect(await readPins(root)).toEqual(oldPins);
      return;
    }
    if (patchState !== "unchanged") {
      await expect(runUpdate({ root, overrides, dryRun, request, validate: false })).rejects.toThrow(/patch needs review/);
      const report = await readFile(join(root, ".status/engine-data-update.md"), "utf8");
      expect(report).toMatch(/^BLOCKING: 1 patch needs review/);
      expect(report).toContain("## Card script patches");
      expect(report).toContain(patches[0]!.stockPath);
      expect(report).toContain(patchState === "missing" ? "removed" : sha256("s.state[tp]=true\n"));
      expect(report).toContain("pins unchanged");
      expect(await readPins(root)).toEqual(oldPins);
      expect(await readFile(patchManifestPath, "utf8")).toBe(JSON.stringify(patches));
      for (const [file, original] of Object.entries(files)) {
        if (file.endsWith("pins.json")) expect(await readFile(join(root, file), "utf8")).toBe(original);
      }
      return;
    }
    if (inline) {
      await writeFile(join(root,"packages/duel-server/card-script-patches/c1.lua"),"-- reviewed smoke patch\n");
      vi.spyOn(smoke,"smokePrereleaseScripts").mockImplementation(async directory => {
        expect(await readFile(join(directory,"card-scripts/official/c1.lua"),"utf8")).toContain("-- reviewed smoke patch");
        return { checked: 1, excluded: [] };
      });
      vi.spyOn(probe,"probeEngineData").mockResolvedValue({errors:[],scriptsChecked:0,apiSymbolsChecked:0,globalsChecked:0,cardsChecked:0});
    }
    const result = await runUpdate({ root, overrides, dryRun, request, validate: inline });
    if (inline) expect(smoke.smokePrereleaseScripts).toHaveBeenCalledOnce();
    expect(result.changed).toBe(true);
    expect(await readPins(root)).toEqual(dryRun ? oldPins : overrides);
    const report = await readFile(result.reportPath, "utf8");
    expect(report).toContain("## New cards in this update");
    expect(report).toContain("## Released TCG sets still in pre-release CDBs");
    expect(report.indexOf("## New cards in this update")).toBeLessThan(report.indexOf("## Released databases"));
    expect(result.cardChanges).toBeDefined();
    const finalized = withCardUpdate(report, result.cardChanges!);
    expect(finalized).toContain(`/compare/${oldPins.database}...${overrides.database}`);
    expect(finalized).toContain("| Repository | Old → new | Commits ahead |");
    if (!ambiguous) {
      expect(report).toContain("Set NEW");
      expect(report).toContain("Set TEST");
      expect(report).toContain('src="https://pics.projectignis.org:2096/pics/100000002.jpg" width=80');
      expect(report).toContain("100000001 → 2");
      expect(report).toContain("metadata unavailable");
      expect(report).toContain("Withdrawn preview");
    }
    expect(report).toContain("## Prerelease cards");
    expect(report).toContain("## Card script patches");
    const withProd = finalized.replace(/## Script errors in prod \(last 7 days\)\n[\s\S]*?(?=\n## |$)/, "## Script errors in prod (last 7 days)\n\nNo errors.\n");
    expect(withProd).toContain("| Repository | Old → new | Commits ahead |");
    expect(withProd).toContain("## Golden hashes");
    expect(report).toContain("All shared card-script patch stock hashes match the candidate.");
    expect(report).toContain("release-new.cdb");
    expect(report).toContain("release-old.cdb");
    expect(report).toContain("Removed release databases");
    expect(result.changedPaths).toContain("official/c2.lua");
    expect(result.changedPaths).toContain("pre-release/c100000002.lua");
    if (ambiguous === "old") {
      expect(report).toContain("Previous card-data comparison");
      expect(report).toContain("Ambiguous retained prerelease passcode 100000001");
      expect(report).toContain("could not be determined");
      expect(report).not.toContain("Added prerelease cards (1)");
      expect(report).toContain("Dropped prerelease rows (0)");
    } else {
      expect(report).toContain("Added prerelease cards (1)");
      expect(report).toContain("Removed prerelease cards (1)");
      expect(report).toContain("Graduated prerelease cards (1)");
      expect(report).toContain("100000001 → 2 New card");
    }
    if (overrides.scripts === oldPins.scripts) {
      expect(report).toContain("New official card scripts (0)");
      expect(report).toContain("Changed official scripts (0)");
      expect(report).toContain("Changed shared scripts (0)");
      expect(result.files).toEqual(["packages/duel-server/scripts/prepare-data.ts"]);
      return;
    }
    expect(report).toContain("New official card scripts (1)");
    expect(report).toContain("New card");
    expect(report).toContain("Changed official scripts (1)");
    expect(report).toContain("&#64;reviewer Changed &#35;123 card");
    expect(report).toMatch(/^Needs review: 1 conflicts, 1 risks, 1 shared-script changes, probe errors /);
    expect(report).toContain("Changed shared scripts (1)");
    expect(report).toContain("mp-utility.lua");
    expect(report).toContain("re-record");
    expect(report).toContain("earlier duels");
    expect(report).toContain("Removed official scripts (1)");
    expect(report).toContain("Overlay conflicts (1)");
    expect(report).toContain("New multiplayer risks (1)");
    expect(report).toContain("merge at a quiet time");
    expect(result.files.sort()).toEqual([
      "packages/duel-server/scripts/prepare-data.ts",
      "packages/duel-server/domain-core/pins.json",
      "packages/duel-server/legacy-1v1/domain-core/pins.json",
    ].sort());
    expect(await readFile(manifestPath, "utf8")).toBe(JSON.stringify(manifest));
    expect(await readFile(patchManifestPath, "utf8")).toBe(JSON.stringify(patches));
    for (const file of ["domain-core/pins.json", "legacy-1v1/domain-core/pins.json"]) {
      const pins = JSON.parse(await readFile(join(root, "packages/duel-server", file), "utf8"));
      expect(pins.ygoproCore.commit).toBe("1".repeat(40));
      expect(pins.cardScripts.commit).toBe(dryRun ? oldPins.scripts : overrides.scripts);
    }
  });

  it("does not rewrite pins when an upstream request fails", async () => {
    const { root } = await fixture();
    const request = vi.fn(async () => new Response("rate limited", { status: 403 }));
    await expect(runUpdate({ root, overrides: nextPins, request })).rejects.toThrow("Download failed (403)");
    expect(await readPins(root)).toEqual(oldPins);
  });

  it("rejects pin occurrences outside the exact allowlist before writing anything", async () => {
    const { root } = await fixture();
    await writeFile(join(root, "unexpected.txt"), oldPins.scripts);
    execFileSync("git", ["-C", root, "add", "unexpected.txt"]);
    await expect(rewritePins(root, oldPins, nextPins, false)).rejects.toThrow(/unexpected.txt/);
    expect(await readPins(root)).toEqual(oldPins);
  });

  it("rejects even an unchanged old pin in an unexpected tracked file", async () => {
    const { root } = await fixture();
    await writeFile(join(root, "unexpected.bin"), Buffer.concat([Buffer.from([0]), Buffer.from(oldPins.strings)]));
    execFileSync("git", ["-C", root, "add", "unexpected.bin"]);
    await expect(rewritePins(root, oldPins, { ...oldPins, database: nextPins.database }, false)).rejects.toThrow(/unexpected.bin/);
    expect(await readPins(root)).toEqual(oldPins);
  });

  it("does not match a suffix of another property when reading pins", async () => {
    const { root } = await fixture();
    const path = join(root, "packages/duel-server/scripts/prepare-data.ts");
    await writeFile(path, `const distractor = { myscripts: "${nextPins.scripts}" };\n${await readFile(path, "utf8")}`);
    expect(await readPins(root)).toEqual(oldPins);
  });

  it.each(["behind", "diverged"])("refuses a %s manual SHA without rewriting pins", async (status) => {
    const { root } = await fixture();
    const request = vi.fn(async () => Response.json({ status, ahead_by: 1, behind_by: 1 }));
    await expect(runUpdate({ root, overrides: nextPins, request })).rejects.toThrow(/behind|diverged/);
    expect(await readPins(root)).toEqual(oldPins);
  });

  it("reports changed listed cards without overlays and all format gaps", () => {
    const scripts = new Map([["official/c94145021.lua", "Duel.GetFieldGroup(tp,LOCATION_HAND,LOCATION_HAND)"]]);
    expect(findListedChanges(scripts, ["official/c94145021.lua"], new Set())).toEqual([
      expect.objectContaining({ code: 94145021, changed: true, formatGap: true }),
    ]);
    expect(findListedChanges(scripts, [], new Set([94145021]))).toEqual([
      expect.objectContaining({ code: 94145021, changed: false, formatGap: true }),
    ]);
  });

  it.each([74519184, 72892473, 82301904, 35059553, 37313786, 27204311, 57728570, 15305240, 13532663])(
    "honors the owner Tag decision for %i but still reports script changes", (code) => {
      const entry = MULTIPLAYER_FORBIDDEN.find((card) => card.code === code)!;
      expect(entry.tagDecision).toEqual({ allowed: true, source: "owner 2026-10-06, option A" });
      expect(entry.formats).toEqual(["ffa3", "ffa4"]);
      const source = "Duel.GetFieldGroup(tp,LOCATION_HAND,LOCATION_HAND)";
      const path = `official/c${code}.lua`;
      const scripts = new Map([[path, source]]);
      expect(scanText(code, source).flagged).toBe(true);
      expect(reconcile([scanText(code, source)]).formatGap).toEqual([]);
      expect(findListedChanges(scripts, [], new Set())).toEqual([]);
      expect(findListedChanges(scripts, [path], new Set())).toEqual([
        expect.objectContaining({ code, changed: true, formatGap: false }),
      ]);
    },
  );

  it("writes single-line GITHUB_OUTPUT values including only reported files", () => {
    expect(githubOutput({ changed: true, next: nextPins, files: ["packages/duel-server/scripts/prepare-data.ts"] })).toBe(
      `changed=true\nscripts=${nextPins.scripts}\ndatabase=${nextPins.database}\nstrings=${nextPins.strings}\nfiles=["packages/duel-server/scripts/prepare-data.ts"]\n`,
    );
  });
});
