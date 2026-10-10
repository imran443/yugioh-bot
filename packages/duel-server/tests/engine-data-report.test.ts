import { describe, expect, it } from "vitest";
import { boundedReport, withValidation, prodScriptErrorReport, readProdScriptErrors } from "../scripts/engine-data-report.js";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const run = "https://github.com/example/repo/actions/runs/123";
it("rejects missing, malformed and oversized prod snapshots without failing report generation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "prod-report-")), path = join(dir, "snapshot.json");
  try {
    expect(await readProdScriptErrors(path)).toBeNull();
    for (const content of ["not json", JSON.stringify({ available: false }), "x".repeat(65537),
      JSON.stringify({ available: true, cards: [{ code: 1, name: "Card", distinctDuels: 1, errorCount: 1, autoBlocked: true, scriptHash: null, helperScripts: ["../private.lua"] }] }),
      JSON.stringify({ available: true, cards: [{ code: 1, name: "Card", distinctDuels: 2, errorCount: 1, autoBlocked: true, scriptHash: null }] })]) {
      await writeFile(path, content); expect(await readProdScriptErrors(path)).toBeNull();
    }
    await writeFile(path, JSON.stringify({ available: true, cards: [{ code: 1, name: "Card", distinctDuels: 1, errorCount: 1,
      autoBlocked: false, scriptHash: null, helperScripts: ["utility.lua"], privateDiagnostic: "not retained" }] }));
    const parsed = await readProdScriptErrors(path);
    expect(JSON.stringify(parsed)).not.toContain("privateDiagnostic");
    expect(parsed?.available && parsed.cards[0]?.helperScripts).toEqual(["utility.lua"]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
it("reports prod counts and script changes without publishing diagnostics or metadata", () => {
  const report = prodScriptErrorReport({ available: true, cards: [
    { code: 10, name: "Name | <tag> @someone #123\nNew", distinctDuels: 3, errorCount: 8, autoBlocked: true, scriptHash: "a".repeat(64) },
    { code: 20, name: "Same", distinctDuels: 0, errorCount: 0, autoBlocked: true, scriptHash: "b".repeat(64) },
  ] }, code => code === 10 ? "c".repeat(64) : "b".repeat(64));
  expect(report).toContain("## Script errors in prod (last 7 days)");
  expect(report).toContain("3 | 8 | Yes | Yes — auto block will lift");
  expect(report).toContain("0 | 0 | Yes | No");
  expect(report).not.toContain("<tag>"); expect(report).not.toContain("@someone"); expect(report).not.toContain("#123");
  expect(report).not.toContain("a".repeat(64)); expect(report).toContain("\\|");
});
it("degrades to unavailable on missing prod data and bounds the protected section", () => {
  expect(prodScriptErrorReport(null)).toContain("prod error data unavailable");
  const section = prodScriptErrorReport({ available: true, cards: Array.from({ length: 100 }, (_, i) => ({
    code: i + 1, name: "漢".repeat(200), distinctDuels: 3, errorCount: 5, autoBlocked: true, scriptHash: null,
  })) });
  expect(Buffer.byteLength(section)).toBeLessThanOrEqual(12000);
  expect(section).toContain("truncated");
  const report = "Needs review: 0\n" + "data\n".repeat(20000) + "\n" + section;
  expect(boundedReport(report, run, 60000)).toContain("## Script errors in prod (last 7 days)");
});
it("retains active blocks ahead of top nonblocked errors when long names hit the byte cap", () => {
  const cards = Array.from({ length: 99 }, (_, i) => ({ code: i + 1, name: "漢".repeat(200),
    distinctDuels: 3, errorCount: 5, autoBlocked: false, scriptHash: null }));
  cards.push({ code: 100, name: "Blocked card", distinctDuels: 0, errorCount: 0, autoBlocked: true, scriptHash: null });
  const report = prodScriptErrorReport({ available: true, cards });
  expect(report).toContain("Blocked card"); expect(report.indexOf("Blocked card")).toBeLessThan(report.indexOf("漢"));
  expect(report).toContain("truncated"); expect(Buffer.byteLength(report)).toBeLessThanOrEqual(12000);
});
describe("engine update report publishing", () => {
  it("keeps relevance counts and new set codes when the PR body is truncated", () => {
    const report = "Needs review: 0\n" + "data\n".repeat(20000) + "\n## Relevance gate\n\nNew cards: 3. Changed cards: 2. Changed scripts: 1.\nNew set codes: BETB.\n";
    const body = boundedReport(report, run, 60000);
    expect(body).toContain("New cards: 3. Changed cards: 2. Changed scripts: 1.");
    expect(body).toContain("New set codes: BETB.");
    expect(Buffer.byteLength(body)).toBeLessThanOrEqual(60000);
  });
  it("keeps the first line and review warnings within the PR body limit", () => {
    const report = "Needs review: 1 conflicts\n" + "card data\n".repeat(10_000) + "\n## Deployment\n\nLive-duel warning; replay loss.\n\n## Golden hashes\n\nRe-record hashes.\n";
    const body = boundedReport(report, run, 60_000);
    expect(Buffer.byteLength(body)).toBeLessThanOrEqual(60_000);
    expect(body.startsWith("Needs review:")).toBe(true);
    expect(body).toContain("replay loss");
    expect(body).toContain("Re-record hashes");
    expect(body).toContain(`${run}#summary`);
    expect(body).toContain(`${run}#artifacts`);
  });
  it("limits multibyte summary bytes below GitHub's 1 MiB maximum", () => {
    const summary = boundedReport("Needs review: 0\n" + "漢".repeat(400_000), run, 1_000_000);
    expect(Buffer.byteLength(summary)).toBeLessThanOrEqual(1_000_000);
    expect(summary).not.toContain("�");
  });
  it("preserves a full report when it fits", () => {
    expect(boundedReport("complete\n", run, 60_000)).toBe("complete\n");
  });
  it("replaces probe results and first-line status after candidate preparation", () => {
    const report = "Needs review: 1 conflicts, 2 risks, 3 shared-script changes, probe errors not run, overlay check exit not run\n\n## Core compatibility\n\nPending.\n\n## Deployment\n\nwarning\n";
    const result = withValidation(report, { errors: ["missing Group.NewApi"], scriptsChecked: 3, apiSymbolsChecked: 4, globalsChecked: 5, cardsChecked: 2 }, 1, "overlay drift");
    expect(result.split("\n")[0]).toBe("Needs review: 1 conflicts, 2 risks, 3 shared-script changes, probe errors 1, overlay check exit 1");
    expect(result).toContain("missing Group.NewApi");
    expect(result).toContain("ocgcore-wasm@0.1.2");
    expect(result).toContain("overlay drift");
    expect(result).not.toContain("Pending.");
  });
});

it("retains blocking artwork findings in bounded reports", () => {
  const report = "BLOCKING: 1 artwork script fallback\n" + "data\n".repeat(20000) + "\n## Artwork script safety\n\nBLOCKING: c11.lua → c10.lua; GetID() differs.\n";
  expect(boundedReport(report, run, 60000)).toContain("c11.lua → c10.lua");
});

it("reports additions, withdrawals, graduations and every dropped preview row", async () => {
  const { prereleaseUpdateReport } = await import("../scripts/engine-data-report.js");
  const previous = [{code:100000001,name:"Graduating",type:33},{code:100000002,name:"Withdrawn",type:33}];
  const next = {prerelease:[{code:100000003,name:"Added",type:33}],released:[{code:12,name:"Graduating",type:33}],
    remaps:{100000001:12},drops:[{code:100000004,name:"Duplicate",type:33,file:"prerelease-en.cdb",reason:"duplicate" as const,keptCode:100000003}]};
  const report=prereleaseUpdateReport(previous,next);
  expect(report).toContain("Added prerelease cards (1)");
  expect(report).toContain("Removed prerelease cards (1)");
  expect(report).toContain("Graduated prerelease cards (1)");
  expect(report).toContain("100000001 → 12");
  expect(report).toContain("100000004 → 100000003");
  expect(report).toContain("Withdrawn");
});


it("lists disappeared codes without a remap, including renamed releases with matching-stat suggestions", async () => {
 const { prereleaseUpdateReport } = await import("../scripts/engine-data-report.js");
 const stats={type:33,atk:2500,def:2000,level:7,attribute:32};
 const previous=[{code:100000001,name:"Preview name",...stats},{code:100000002,name:"Withdrawn",type:33},{code:44,name:"Same code",type:33},{code:100000003,name:"Mapped",type:33}];
 const next={prerelease:[],released:[{code:12,name:"Official name",...stats},{code:44,name:"Same code",type:33},{code:55,name:"Mapped",type:33}],remaps:{100000003:55},drops:[]};
 const report=prereleaseUpdateReport(previous,next);
 const missing=report.split("Removed preview codes with no remap (2)")[1]?.split("Dropped prerelease rows")[0];
 expect(missing).toContain("100000001 Preview name");
 expect(missing).toContain("12 Official name");
 expect(missing).toContain("100000002 Withdrawn");
 expect(missing).not.toContain("44 Same code");
 expect(missing).not.toContain("100000003 Mapped");
 const withExistingMatch=prereleaseUpdateReport(previous,next,[{code:12,name:"Official name",...stats}]);
 expect(withExistingMatch.split("Removed preview codes with no remap")[1]).not.toContain("12 Official name");
});

it("retains patch review details when the weekly failure summary is truncated", () => {
  const report = "BLOCKING: 1 patch needs review\n" + "data\n".repeat(20000) + "\n## Card script patches\n\n**patch needs review**: official/c3743515.lua; pins unchanged.\n";
  const summary = boundedReport(report, run, 60000);
  expect(summary).toContain("official/c3743515.lua");
  expect(summary).toContain("pins unchanged");
  expect(Buffer.byteLength(summary)).toBeLessThanOrEqual(60000);
});

it("counts renamed/type-changed remaps as graduations and explicitly flags unresolved cases",async()=>{
 const {prereleaseUpdateReport}=await import("../scripts/engine-data-report.js");
 const old={code:101402001,name:"Swift Panther Warrior",type:33};
 const unresolved={code:100000099,name:"Uncertain preview",type:33};
 const next={prerelease:[],released:[{code:77482666,name:"Swiftwind Panther Warrior",type:17}],remaps:{101402001:77482666},drops:[],unmatched:[{...unresolved,commits:["abc"],candidates:[12,13]}]};
 const report=prereleaseUpdateReport([old,unresolved],next);
 expect(report).toContain("Graduated prerelease cards (1)");
 expect(report).toContain("101402001 → 77482666");
 expect(report).toContain("unmatched graduation, needs review");
 expect(report).toContain("100000099");
});

it("reports prepare-time script exclusions and suppressed graduation targets in weekly output",async()=>{
 const {prereleaseScriptReport}=await import("../scripts/engine-data-report.js");
 const report=prereleaseScriptReport({checked:139,excluded:[{code:100000001,name:"Broken @everyone",file:"prerelease-a.cdb",errors:["initial_effect failed"]}],suppressedRemaps:[{old:100000002,target:100000001}]});
 expect(report).toContain("excluded: script error");expect(report).toContain("139");expect(report).toContain("initial_effect failed");expect(report).toContain("100000002 → 100000001");expect(report).not.toContain("@everyone");
});
it("bounds a weekly smoke section with many long diagnostics while preserving its counts and artifact links",async()=>{
 const {prereleaseScriptReport}=await import("../scripts/engine-data-report.js");
 const smoke=prereleaseScriptReport({checked:139,excluded:Array.from({length:139},(_,i)=>({code:100000000+i,name:"Broken",file:"prerelease-a.cdb",errors:["漢".repeat(1000)]})),suppressedRemaps:[]});
 const report="Needs review: 0\n"+"card data\n".repeat(10000)+"\n"+smoke;
 const body=boundedReport(report,run,60000);expect(Buffer.byteLength(body)).toBeLessThanOrEqual(60000);expect(body).toContain("excluded 139");expect(body).toContain(`${run}#artifacts`);expect(body).not.toContain("�");
});
