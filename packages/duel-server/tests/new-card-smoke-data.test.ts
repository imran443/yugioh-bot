import { expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { changedSmokeCodes, parseSmokeArgs, pinsFromText, snapshotSmokeBundle, smokeSetCodes, shardSmokeCodes } from "../scripts/lib/new-card-smoke-data.js";

it("partitions passcodes by a stable hash into disjoint shards independent of input order", () => {
  const codes = Array.from({ length: 300 }, (_, i) => i + 1);
  const shards = [1, 2, 3, 4].map(index => shardSmokeCodes(codes, { index, count: 4 }));
  expect(shards.flat().sort((a, b) => a - b)).toEqual(codes);
  expect(shards.every(c => c.length >= 50 && c.length <= 100)).toBe(true);
  expect(shardSmokeCodes([...codes].reverse(), { index: 2, count: 4 }).sort((a, b) => a - b)).toEqual(shards[1]);
  expect(parseSmokeArgs(["--shard", "2/4"]).shard).toEqual({ index: 2, count: 4 });
  for (const shard of ["0/4", "5/4", "1/0", "x/4", "2.5/4"]) expect(() => parseSmokeArgs(["--shard", shard])).toThrow(/shard/);
});

it("selects added rows, edited text/stats, changed scripts, and helper dependents", () => {
  const before = { cards: new Map([[1, { row: "a", script: "s" }], [2, { row: "b", script: "s" }], [4, { row: "d", script: "s" }]]), helpers: "h" };
  const after = { cards: new Map([[1, { row: "a", script: "new" }], [2, { row: "new", script: "s" }], [3, { row: "c", script: "s" }]]), helpers: "h" };
  expect(changedSmokeCodes(before, after)).toEqual([1, 2, 3]);
  expect(changedSmokeCodes(after, after)).toEqual([]);
  expect(changedSmokeCodes({ ...after, helpers: "old" }, after)).toEqual([1, 2, 3]);
});
it("reads all three immutable data pins from source text", () => {
  const sha = "a".repeat(40);
  expect(pinsFromText(`scripts: "${sha}", database: "${sha}", strings: "${sha}"`)).toEqual({ scripts: sha, database: sha, strings: sha });
  expect(() => pinsFromText('scripts: "short"')).toThrow(/pin/);
});
it("samples 150 unchanged cards across types when shared helpers change, preserving every edited card", () => {
  const cards = new Map(Array.from({ length: 1400 }, (_, i) => [i + 1, { row: "same", script: "same", type: [17, 33, 2, 4, 0x800021, 0x200021, 0x4000021][i % 7]! }]));
  const before = { cards, helpers: "old" };
  const after = { cards: new Map(cards), helpers: "new" };
  after.cards.set(1401, { row: "added", script: "new", type: 33 });
  after.cards.set(1, { row: "edited", script: "same", type: 17 });
  const selected = changedSmokeCodes(before, after);
  expect(selected).toHaveLength(152);
  expect(selected).toContain(1); expect(selected).toContain(1401);
  expect(selected).toEqual(changedSmokeCodes(before, { ...after, cards: new Map([...after.cards].reverse()) }));
  expect(new Set(selected.map(code => after.cards.get(code)!.type))).toHaveLength(7);
});
it("validates mutually exclusive input modes and positive limits", () => {
  expect(parseSmokeArgs(["--cards", "42,43", "--jobs", "2"]).cards).toEqual([42, 43]);
  expect(() => parseSmokeArgs(["--cards", "0"])).toThrow(/passcode/);
  expect(() => parseSmokeArgs(["--cards", "42", "--from-pin", "main"])).toThrow(/input/);
  expect(() => parseSmokeArgs(["--from-pin", "main"])).toThrow(/both/);
  expect(() => parseSmokeArgs(["--jobs", "0"])).toThrow(/jobs/);
  expect(() => parseSmokeArgs(["--jobs", "9"])).toThrow(/jobs/);
  expect(() => parseSmokeArgs(["--set", "BETB", "--cards", "42"])).toThrow(/input/);
  expect(() => parseSmokeArgs(["--timeout", "2147483648"])).toThrow(/timeout/);
  expect(() => parseSmokeArgs(["--seed", "4294967296"])).toThrow(/seed/);
  expect(parseSmokeArgs(["--cards", "42", "--case", "domain/ffa4/field/branch-1", "--seed", "7"]).case).toBe("domain/ffa4/field/branch-1");
  expect(() => parseSmokeArgs(["--case", "bad"])).toThrow(/case/);
});
it("fingerprints real SQLite rows, 64-bit setcodes, aliases, and shared helpers", async () => {
  const root = await mkdtemp(join(tmpdir(), "smoke-snapshot-"));
  try {
    await mkdir(join(root, "card-scripts"));
    const db = new Database(join(root, "cards.cdb"));
    db.exec("CREATE TABLE datas(id INTEGER, alias INTEGER, type INTEGER, setcode INTEGER); CREATE TABLE texts(id INTEGER, name TEXT, desc TEXT)");
    db.exec("INSERT INTO datas VALUES(42,0,33,9223372036854775807),(43,42,33,0),(44,0,16385,0); INSERT INTO texts VALUES(42,'Test','Effect'),(43,'Test','Effect'),(44,'Token','')");
    await writeFile(join(root, "card-scripts/c42.lua"), "initial_effect");
    await writeFile(join(root, "card-scripts/utility.lua"), "helper");
    const before = snapshotSmokeBundle(root);
    expect([...before.cards.keys()]).toEqual([42, 43]);
    await writeFile(join(root, "card-scripts/c42.lua"), "changed operation");
    expect(changedSmokeCodes(before, snapshotSmokeBundle(root))).toEqual([42, 43]);
    const after = snapshotSmokeBundle(root);
    db.exec("UPDATE texts SET desc='new text' WHERE id=43");
    expect(changedSmokeCodes(after, snapshotSmokeBundle(root))).toEqual([43]);
    await writeFile(join(root, "card-scripts/utility.lua"), "changed helper");
    expect(changedSmokeCodes(after, snapshotSmokeBundle(root))).toEqual([42, 43]);
    db.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});
it("leaves a prepared bundle unchanged and removes temporary set CDBs on success and error", async () => {
  const root = await mkdtemp(join(tmpdir(), "smoke-readonly-"));
  const request = globalThis.fetch;
  const temporary = () => readdir(tmpdir()).then(paths => paths.filter(p => p.startsWith("new-card-smoke-set-")));
  try {
    const db = new Database(join(root, "cards.cdb")); db.exec("CREATE TABLE datas(id INTEGER,type INTEGER); INSERT INTO datas VALUES(42,33)"); db.close();
    await writeFile(join(root, "manifest.json"), JSON.stringify({ sources: { database: "a".repeat(40), databaseFiles: ["release-test.cdb"] } }));
    const before = await readdir(root), temps = await temporary();
    globalThis.fetch = async () => new Response(readFileSync(join(root, "cards.cdb")));
    expect(await smokeSetCodes("TEST", root)).toEqual([42]);
    expect(await readdir(root)).toEqual(before); expect(await temporary()).toEqual(temps);
    globalThis.fetch = async () => new Response("missing", { status: 404 });
    await expect(smokeSetCodes("TEST", root)).rejects.toThrow(/download/);
    expect(await readdir(root)).toEqual(before); expect(await temporary()).toEqual(temps);
  } finally { globalThis.fetch = request; await rm(root, { recursive: true, force: true }); }
});
