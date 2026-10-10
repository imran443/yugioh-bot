import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as relevance from "../scripts/engine-data-relevance.js";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
const snapshot = () => ({ cards: new Map([[1, "row"]]), scripts: new Map([["official/c1.lua", "script"]]), strings: "strings", remaps: {} });

describe("engine data relevance gate", () => {
  it("ignores upstream pin changes with identical loaded inputs", () => {
    expect(relevance.compareLoadedData(snapshot(), snapshot())).toMatchObject({ relevant: false, newCards: 0, changedCards: 0, removedCards: 0, changedScripts: [] });
  });
  it.each(["cards", "scripts", "strings", "remaps"] as const)("opens the gate for a loaded %s change", field => {
    const next = snapshot();
    if (field === "cards") next.cards.set(1, "new text or stats");
    if (field === "scripts") next.scripts.set("official/c1.lua", "fix");
    if (field === "strings") next.strings = "new strings";
    if (field === "remaps") next.remaps = { "100000001": 1 };
    expect(relevance.compareLoadedData(snapshot(), next).relevant).toBe(true);
  });
  it("counts additions, edits and removals separately, including script removals", () => {
    const old = snapshot(); old.cards.set(2, "removed"); old.scripts.set("utility.lua", "removed helper");
    const next = snapshot(); next.cards.set(1, "edited"); next.cards.set(3, "added"); next.scripts.set("pre-release/c3.lua", "added");
    expect(relevance.compareLoadedData(old, next)).toMatchObject({ relevant: true, newCards: 1, changedCards: 1, removedCards: 1,
      changedScripts: ["pre-release/c3.lua", "utility.lua"] });
  });
  it("never treats an unavailable previous snapshot as an irrelevant update", () => {
    expect(relevance.compareLoadedData(null, snapshot())).toMatchObject({ relevant: true, newCards: null, changedCards: null, comparisonAvailable: false });
  });
  it("compares known scripts and strings even when previous card rows are unavailable", () => {
    expect(relevance.compareLoadedData({ ...snapshot(), cards: null, remaps: null }, snapshot())).toMatchObject({
      relevant: true, comparisonAvailable: false, newCards: null, changedCards: null, changedScripts: [], stringsChanged: false,
    });
  });
  it("keeps shipped scripts and helpers, but excludes known Rush cards, docs and discarded previews", () => {
    const tree = new Map([
      ["official/c1.lua", "one"], ["pre-release/c1.lua", "shadowed"], ["pre-release/c2.lua", "two"],
      ["official/c999.lua", "rush"], ["rush/c1.lua", "rush directory"], ["rush/utility.lua", "rush helper"],
      ["pre-release/c3.lua", "discarded"], ["utility.lua", "helper"], ["proc_xyz.lua", "helper"],
      ["pre-errata/c1.lua", "explicit path"], ["README.md", "doc"], ["unused.txt", "other"],
    ]);
    expect([...relevance.loadedScriptTree(tree, new Set([1, 2]), new Set([999])).keys()]).toEqual([
      "official/c1.lua", "pre-release/c2.lua", "utility.lua", "proc_xyz.lua", "pre-errata/c1.lua",
    ]);
  });
  it("retains shipped numbered dependencies even when their passcode is absent from the CDB", () => {
    const tree = new Map([["official/c1.lua", "uses c2.lua"], ["official/c2.lua", "dependency"],
      ["c3.lua", "root dependency"], ["pre-errata/c4.lua", "explicit dependency"]]);
    expect(relevance.loadedScriptTree(tree, new Set([1]))).toEqual(tree);
  });
  it.each(["rush_utility.lua", "rush-helper.lua", "rush.lua"])("keeps root %s relevant while excluding Rush directories and CDB passcodes", path => {
    const tree = new Map([[path, "helper"], ["rush/c2.lua", "Rush script"], ["RUSH/utility.lua", "Rush helper"],
      ["unofficial/rush/c3.lua", "nested Rush"], ["official/c999.lua", "Rush CDB card"], ["proc_rush.lua", "shared procedure"]]);
    const loaded = relevance.loadedScriptTree(tree, new Set([1]), new Set([999]));
    expect([...loaded.keys()]).toEqual([path, "proc_rush.lua"]);
    tree.set(path, "changed helper");
    expect(relevance.compareLoadedData({ ...snapshot(), scripts: loaded },
      { ...snapshot(), scripts: relevance.loadedScriptTree(tree, new Set([1]), new Set([999])) }))
      .toMatchObject({ relevant: true, changedScripts: [path] });
  });
  it("does not lose changes to SQLite integers above Number.MAX_SAFE_INTEGER or card text strings", async () => {
    const dir = await mkdtemp(join(tmpdir(), "relevance-test-")); dirs.push(dir);
    const path = join(dir, "cards.cdb"), db = new Database(path);
    db.exec("CREATE TABLE datas (id INTEGER PRIMARY KEY, setcode INTEGER, race INTEGER); CREATE TABLE texts (id INTEGER PRIMARY KEY, name TEXT, desc TEXT, str1 TEXT); INSERT INTO datas VALUES(1,9007199254740992,33); INSERT INTO texts VALUES(1,'Card','Effect','Choice')");
    const before = relevance.readCardRows(path);
    db.exec("UPDATE datas SET setcode=9007199254740993");
    const afterInteger = relevance.readCardRows(path);
    expect(afterInteger.get(1)).not.toBe(before.get(1));
    db.exec("UPDATE texts SET str1='Different choice'");
    expect(relevance.readCardRows(path).get(1)).not.toBe(afterInteger.get(1));
    db.close();
  });
  it("compares row values instead of SQLite layout or column order", async () => {
    const dir = await mkdtemp(join(tmpdir(), "relevance-layout-")); dirs.push(dir);
    const a = join(dir, "a.cdb"), b = join(dir, "b.cdb");
    for (const [path, reversed] of [[a, false], [b, true]] as const) {
      const db = new Database(path);
      db.exec(reversed ? "CREATE TABLE datas (ot INTEGER,id INTEGER PRIMARY KEY); INSERT INTO datas VALUES(3,1)" : "CREATE TABLE datas (id INTEGER PRIMARY KEY,ot INTEGER); INSERT INTO datas VALUES(1,3)");
      db.exec("CREATE TABLE texts (id INTEGER PRIMARY KEY,name TEXT); INSERT INTO texts VALUES(1,'Card'); VACUUM"); db.close();
    }
    expect(relevance.readCardRows(a)).toEqual(relevance.readCardRows(b));
  });
  it("includes orphan rows retained from the base database because the loader reads both tables separately", async () => {
    const dir = await mkdtemp(join(tmpdir(), "relevance-orphans-")); dirs.push(dir);
    const path = join(dir, "cards.cdb"), db = new Database(path);
    db.exec("CREATE TABLE datas (id INTEGER PRIMARY KEY, atk INTEGER); CREATE TABLE texts (id INTEGER PRIMARY KEY,name TEXT,str1 TEXT); INSERT INTO datas VALUES(1,1000); INSERT INTO texts VALUES(2,'Text only','Choice')");
    const before = relevance.readCardRows(path);
    expect([...before.keys()]).toEqual([1, 2]);
    db.exec("UPDATE datas SET atk=2000 WHERE id=1; UPDATE texts SET str1='New choice' WHERE id=2");
    const after = relevance.readCardRows(path);
    expect(after.get(1)).not.toBe(before.get(1)); expect(after.get(2)).not.toBe(before.get(2));
    db.exec("DELETE FROM datas WHERE id=1; INSERT INTO datas VALUES(3,3000)");
    expect([...relevance.readCardRows(path).keys()]).toEqual([2, 3]);
    db.close();
  });
  it("renders review counts and deduplicated set codes in the PR body", () => {
    const next = snapshot(); next.cards.set(1, "edit"); next.cards.set(2, "new"); next.scripts.set("utility.lua", "new");
    const body = relevance.renderRelevantChanges(relevance.compareLoadedData(snapshot(), next), ["BETB", "DBGV", "BETB"]);
    expect(body).toContain("New cards: 1. Changed cards: 1. Removed cards: 0. Changed scripts: 1.");
    expect(body).toContain("New set codes: BETB, DBGV.");
  });
});
