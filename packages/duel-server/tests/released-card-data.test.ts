import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, expect, it, vi } from "vitest";
import { prepareData, sources } from "../scripts/prepare-data.js";
import { installCardScriptPatches } from "../scripts/card-script-patches.js";
import { discoverReleasedDatabases, downloadReleasedCardData, restrictPrereleaseScripts } from "../scripts/released-card-data.js";
import * as releasedCardData from "../scripts/released-card-data.js";
import { loadCardDatabase } from "../src/cards.js";
import { inspectDeck } from "../src/deck-legality.js";
import { loadArtworkIdentityCatalog, mainArtworkId } from "../../shared/dist/services/card-artworks.js";
import { normalizeDuelSettings } from "@yugidraft/shared/duels";
import { openDatabase } from "@yugidraft/shared/db";
import { createCardCatalogService } from "@yugidraft/shared/services";

// Synthetic CDBs must not consume the production remap policy or Git history.
// Override cases supply their own exact overrideBytes and historical identities.
vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, readFile: (...args: Parameters<typeof actual.readFile>) =>
    String(args[0]).endsWith("/card-remap-overrides.json")
      ? Promise.resolve("{}\n") : actual.readFile(...args) };
});
vi.mock("../scripts/prerelease-history.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../scripts/prerelease-history.js")>();
  return { ...actual, prereleaseHistory: async () => ({ cards: [], transitions: [] }) };
});

const roots: string[] = [];
const root = () => { const dir = mkdtempSync(join(tmpdir(), "released-data-test-")); roots.push(dir); return dir; };
afterEach(() => { roots.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })); vi.unstubAllEnvs(); vi.useRealTimers(); vi.restoreAllMocks(); });
const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const tree = (paths: string[]) => ({ truncated: false, tree: paths.map(path => ({ path, type: "blob", sha: "unused" })) });
function cdb(dir: string, name: string, rows: Array<[number, number, string, number?]>) {
  const path = join(dir, name);
  const db = new Database(path);
  db.exec(`CREATE TABLE datas (id INTEGER PRIMARY KEY, ot INTEGER, alias INTEGER, setcode INTEGER, type INTEGER,
    atk INTEGER, def INTEGER, level INTEGER, race INTEGER, attribute INTEGER, category INTEGER);
    CREATE TABLE texts (id INTEGER PRIMARY KEY, name TEXT, desc TEXT);`);
  for (const [code, alias, label, type = 33] of rows) {
    db.prepare("INSERT INTO datas VALUES (?,3,?,9223372036854775807,?,2500,2000,7,1,32,0)").run(code, alias, type);
    db.prepare("INSERT INTO texts VALUES (?,?,'release effect')").run(code, label);
  }
  db.close();
  return readFileSync(path);
}
function fixture() {
  const dir = root();
  const databases = new Map([
    ["cards.cdb", cdb(dir, "base.cdb", [[1, 0, "Base"], [2, 0, "Old text"]])],
    ["release-z.cdb", cdb(dir, "z.cdb", [[2, 1, "Released text"], [17242022, 0, "Red-Eyes Black Dragon Exceed"], [17242023, 17242022, "Red-Eyes Black Dragon Exceed"]])],
    ["release-a.cdb", cdb(dir, "a.cdb", [[2, 0, "Earlier release"]])],
  ]);
  const scripts = join(dir, "stock"); mkdirSync(join(scripts, "official"), { recursive: true }); mkdirSync(join(scripts, "pre-release"));
  for (const file of ["official/c1.lua", "official/c2.lua", "pre-release/c17242022.lua", "pre-release/c999.lua"]) writeFileSync(join(scripts, file), `-- ${file}\n`);
  cpSync(new URL("./fixtures/card-scripts/c3743515.lua", import.meta.url), join(scripts, "official/c3743515.lua"));
  const archive = execFileSync("tar", ["-czf", "-", "-C", dir, "stock"]);
  const request = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("/git/trees/")) return Response.json(tree(["release-z.cdb", "cards-rush.cdb", "release-a.cdb", "cards.cdb", "cards-skills.cdb", "cards-unofficial.cdb", "goat-entries.cdb"]));
    if (url.endsWith("strings.conf")) return new Response("!system 1 Test\n");
    if (url.includes("codeload.github.com")) return new Response(new Uint8Array(archive));
    const bytes = databases.get(url.split("/").pop()!);
    if (bytes) return new Response(new Uint8Array(bytes));
    throw new Error(`Unexpected download ${url}`);
  });
  return { request, databases, directory: join(dir, "bundle") };
}

it("prepares the Sabersaurus fix in the shared card scripts and versions its effective bytes", async () => {
  const { request, directory } = fixture();
  const result = await prepareData(directory, request);
  const script = readFileSync(join(directory, "card-scripts/official/c3743515.lua"), "utf8");
  expect(script).toContain("Duel.GetBattleMonster(tp)");
  expect(result.integrity.cardScriptPatches).toMatch(/^[a-f0-9]{64}$/);
  request.mockClear();
  expect((await prepareData(directory, request)).bundleVersion).toBe(result.bundleVersion);
  expect(readFileSync(join(directory, "card-scripts/official/c3743515.lua"), "utf8")).toBe(script);
  expect(request).not.toHaveBeenCalled();
});

it("patches an unchanged cached bundle without downloads and changes its version", async () => {
  const { request, directory } = fixture();
  const first = await prepareData(directory, request);
  const { cardScriptPatches: _patches, ...integrity } = first.integrity;
  const { multiScripts: _multi, cardsMerged: _cards, ...engine } = integrity;
  const bundleVersion = hash(JSON.stringify({ sources: first.sources, integrity: engine }));
  writeFileSync(join(directory, "manifest.json"), JSON.stringify({ sources: first.sources, integrity, bundleVersion }));
  cpSync(new URL("./fixtures/card-scripts/c3743515.lua", import.meta.url), join(directory, "card-scripts/official/c3743515.lua"));
  request.mockClear();
  const next = await prepareData(directory, request);
  expect(next.skipped).toBe(true);
  expect(next.bundleVersion).not.toBe(bundleVersion);
  expect(next.integrity.cardScriptPatches).toMatch(/^[a-f0-9]{64}$/);
  expect(readFileSync(join(directory, "card-scripts/official/c3743515.lua"), "utf8")).toContain("Duel.GetBattleMonster(tp)");
  expect(request).not.toHaveBeenCalled();
});

it("refuses an unreviewed upstream Sabersaurus script before applying its patch", async () => {
  const { request, directory } = fixture();
  await prepareData(directory, request);
  writeFileSync(join(directory, "card-scripts/official/c3743515.lua"), "-- changed upstream\n");
  await expect(prepareData(directory, request)).rejects.toThrow(/Card script patch stock mismatch.*c3743515/);
});

it("gives fresh and cached patch installs the same version with optional built-core metadata", async () => {
  const { request, directory } = fixture();
  const first = await prepareData(directory, request);
  writeFileSync(join(directory, "card-scripts/domain.lua"), "domain");
  writeFileSync(join(directory, "card-scripts/domain.legacy.lua"), "legacy domain");
  for (const name of ["domain", "domain.legacy", "standard"]) writeFileSync(join(directory, `ocgcore.${name}.wasm`), name);
  // Force a fresh catalog preparation, preserving the optional core resources.
  writeFileSync(join(directory, "manifest.json"), JSON.stringify({ ...first, sources: {
    ...first.sources, databaseFormat: "old", domainCore: {}, domainCoreLegacy: {}, standardCore: {},
  } }));
  const fresh = await prepareData(directory, request);
  const { cardScriptPatches: _patches, ...integrity } = fresh.integrity;
  const { multiScripts: _multi, cardsMerged: _merged, ...engine } = integrity;
  writeFileSync(join(directory, "manifest.json"), JSON.stringify({ sources: fresh.sources, integrity,
    bundleVersion: hash(JSON.stringify({ sources: fresh.sources, integrity: engine })),
  }));
  cpSync(new URL("./fixtures/card-scripts/c3743515.lua", import.meta.url), join(directory, "card-scripts/official/c3743515.lua"));
  request.mockClear();
  const cached = await prepareData(directory, request);
  expect(cached.skipped).toBe(true);
  expect(cached.integrity).toEqual(fresh.integrity);
  expect(cached.bundleVersion).toBe(fresh.bundleVersion);
  expect(request).not.toHaveBeenCalled();
});

it("restores stock bytes when a shared patch is retired from a cached recipe", () => {
  const directory = root();
  const recipe = join(directory, "recipe");
  cpSync(new URL("../card-script-patches/", import.meta.url), recipe, { recursive: true });
  const scripts = join(directory, "scripts");
  mkdirSync(join(scripts, "official"), { recursive: true });
  const stock = readFileSync(new URL("./fixtures/card-scripts/c3743515.lua", import.meta.url), "utf8");
  const path = join(scripts, "official/c3743515.lua");
  writeFileSync(path, stock);
  installCardScriptPatches(scripts, recipe);
  expect(readFileSync(path, "utf8")).not.toBe(stock);
  writeFileSync(join(recipe, "MANIFEST.json"), "[]\n");
  expect(installCardScriptPatches(scripts, recipe)).toBe(hash(""));
  expect(readFileSync(path, "utf8")).toBe(stock);
});

it.each([
  [403, { "Retry-After": "2" }, 2_000],
  [429, { "Retry-After": "Tue, 06 Oct 2026 12:00:03 GMT" }, 3_000],
  [403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1791288004" }, 4_000],
  [503, { "Retry-After": "1", "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1791288004" }, 4_000],
  [403, { "x-ratelimit-reset": "1791288004" }, 1_000],
  [403, { "x-ratelimit-remaining": "1", "x-ratelimit-reset": "1791288004" }, 1_000],
  [429, { "Retry-After": "2", "x-ratelimit-remaining": "1", "x-ratelimit-reset": "1791288004" }, 2_000],
  [500, {}, 1_000],
])("retries a %i tree response with authentication after the server's delay", async (status, headers, delay) => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-06T12:00:00Z"));
  vi.stubEnv("GH_TOKEN", "");
  vi.stubEnv("GITHUB_TOKEN", "test-read-token");
  const request = vi.fn()
    .mockResolvedValueOnce(new Response("retry", { status, headers }))
    .mockResolvedValueOnce(Response.json(tree(["cards.cdb"])));
  const result = discoverReleasedDatabases(sources.database, request);
  const assertion = expect(result).resolves.toEqual(["cards.cdb"]);
  await vi.advanceTimersByTimeAsync(delay - 1);
  expect(request).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(request).toHaveBeenCalledTimes(2);
  await assertion;
  expect(request.mock.calls[1][1].headers.Authorization).toBe("Bearer test-read-token");
});

it.each<Record<string, string>>([
  { "Retry-After": "3600" },
  { "Retry-After": "Tue, 06 Oct 2026 13:00:00 GMT" },
  { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1791291600" },
])("caps each server delay at one minute and fails after three retries: %j", async headers => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-06T12:00:00Z"));
  const request = vi.fn(async () => new Response("retry", { status: 429, headers }));
  const assertion = expect(discoverReleasedDatabases(sources.database, request)).rejects.toThrow("(429)");
  for (let retry = 1; retry <= 3; retry++) {
    await vi.advanceTimersByTimeAsync(59_999);
    expect(request).toHaveBeenCalledTimes(retry);
    await vi.advanceTimersByTimeAsync(1);
    expect(request).toHaveBeenCalledTimes(retry + 1);
  }
  await assertion;
});

it("stops after three retries and does not retry other client errors", async () => {
  vi.useFakeTimers();
  const limited = vi.fn(async () => new Response("retry", { status: 403 }));
  const assertion = expect(discoverReleasedDatabases(sources.database, limited)).rejects.toThrow("(403)");
  await vi.runAllTimersAsync();
  await assertion;
  expect(limited).toHaveBeenCalledTimes(4);
  const missing = vi.fn(async () => new Response("missing", { status: 404 }));
  await expect(discoverReleasedDatabases(sources.database, missing)).rejects.toThrow("(404)");
  expect(missing).toHaveBeenCalledTimes(1);
});

it("merges release rows and text deterministically without converting SQLite 64-bit values or loading prerelease data", async () => {
  const { request, directory } = fixture(); mkdirSync(directory);
  const first = await downloadReleasedCardData(sources.database, directory, request);
  const bytes = readFileSync(first.path);
  const secondDir = root();
  const second = await downloadReleasedCardData(sources.database, secondDir, request);
  expect(readFileSync(second.path)).toEqual(bytes);
  expect(first.files).toEqual(["cards.cdb", "release-a.cdb", "release-z.cdb"]);
  expect([...first.releaseCodes].sort((a,b) => a-b)).toEqual([2,17242022,17242023]);
  const db = new Database(first.path, { readonly: true });
  try {
    expect(db.prepare("SELECT name FROM texts WHERE id=2").get()).toEqual({ name: "Released text" });
    expect(db.prepare("SELECT alias FROM datas WHERE id=2").get()).toEqual({ alias: 1 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM datas").get()).toEqual({ n: 4 });
    expect(db.prepare("SELECT setcode FROM datas WHERE id=17242022").safeIntegers().get()).toEqual({ setcode: 9223372036854775807n });
  } finally { db.close(); }
  expect(request.mock.calls.every(([input]) => !String(input).includes("prerelease-hidden.cdb"))).toBe(true);
});

it("drops obsolete release files and rebuilds from the base after Ignis merges a set", async () => {
  const { request, directory } = fixture();
  await downloadReleasedCardData(sources.database, directory, request);
  const base = cdb(root(), "upstream.cdb", [[1, 0, "Base"], [17242022, 0, "Merged upstream"]]);
  const nextRequest = vi.fn(async (input: string | URL | Request) => {
    if (String(input).includes("/git/trees/")) return Response.json(tree(["cards.cdb", "cards-rush.cdb"]));
    if (String(input).endsWith("/cards.cdb")) return new Response(new Uint8Array(base));
    throw new Error(`Obsolete release download: ${input}`);
  });
  const next = await downloadReleasedCardData("a".repeat(40), directory, nextRequest);
  expect(next.files).toEqual(["cards.cdb"]);
  expect(next.releaseCodes.size).toBe(0);
  expect(next.bytes).toEqual(base);
  expect(existsSync(join(directory, "release-z.cdb"))).toBe(false);
});

it("keeps pre-release card scripts only for loaded release codes and prefers official copies", () => {
  const dir = root(); mkdirSync(join(dir, "pre-release")); mkdirSync(join(dir, "official"));
  for (const file of ["pre-release/c1.lua", "pre-release/c2.lua", "pre-release/c3.lua", "official/c2.lua"]) writeFileSync(join(dir, file), file);
  restrictPrereleaseScripts(dir, new Set([1, 2]));
  expect(existsSync(join(dir, "pre-release/c1.lua"))).toBe(true);
  expect(existsSync(join(dir, "pre-release/c2.lua"))).toBe(false);
  expect(existsSync(join(dir, "pre-release/c3.lua"))).toBe(false);
});

it("loads official scripts before pre-release and other duplicate basenames while preserving explicit paths", async () => {
  const { request, directory } = fixture();
  await prepareData(directory, request);
  const scriptRoot = join(directory, "card-scripts");
  for (const folder of ["official", "pre-release", "pre-errata", "unofficial"]) {
    mkdirSync(join(scriptRoot, folder), { recursive: true });
    for (const code of [95200011, 95200012, 95200013, 95200102]) writeFileSync(join(scriptRoot, folder, `c${code}.lua`), folder);
  }
  writeFileSync(join(scriptRoot, "pre-release/c17242022.lua"), "pre-release");
  writeFileSync(join(scriptRoot, "unofficial/c17242022.lua"), "unofficial");
  writeFileSync(join(scriptRoot, "unofficial/helper.lua"), "other helper");
  writeFileSync(join(scriptRoot, "helper.lua"), "root helper");
  const cards = loadCardDatabase(directory);
  try {
    for (const code of [95200011, 95200012, 95200013, 95200102]) {
      expect(cards.readScript(`c${code}.lua`)).toBe("official");
      expect(cards.readScript(`unofficial/c${code}.lua`)).toBe("unofficial");
      expect(cards.readScript(`pre-errata/c${code}.lua`)).toBe("pre-errata");
    }
    expect(cards.readScript("c17242022.lua")).toBe("pre-release");
    expect(cards.readScript("helper.lua")).toBe("root helper");
  } finally { cards.close(); }
});

it("prepares a versioned merged manifest visible to artwork identity, engine readers and duel deck validation", async () => {
  const { request, databases, directory } = fixture();
  const result = await prepareData(directory, request);
  expect(result.skipped).toBe(false);
  expect(result.sources.databaseFiles).toEqual(["cards.cdb", "release-a.cdb", "release-z.cdb"]);
  expect(result.integrity.cards).toBe(hash(["cards.cdb", "release-a.cdb", "release-z.cdb"].map(file => `${file}:${hash(databases.get(file)!)}`).join("\n")));
  expect(result.integrity.cardsMerged).toBe(hash(readFileSync(join(directory, "cards.cdb"))));
  const { multiScripts: _overlay, cardsMerged: _merged, ...engine } = result.integrity;
  expect(result.bundleVersion).toBe(hash(JSON.stringify({ sources: result.sources, integrity: engine })));
  const cards = loadCardDatabase(directory);
  try {
    expect(cards.cardData(17242023)?.alias).toBe(17242022);
    expect(cards.get(17242023)?.canonicalPasscode).toBe(17242022);
    expect(cards.readScript("c17242022.lua")).toContain("pre-release/c17242022.lua");
    expect(cards.readScript("c999.lua")).toBeNull();
  } finally { cards.close(); }
  const identity = loadArtworkIdentityCatalog(directory);
  expect(mainArtworkId({ id: 17242023, name: "Red-Eyes Black Dragon Exceed", card_images: [{id:17242023}, {id:17242022}] }, identity)).toBe(17242022);
  vi.stubEnv("DUEL_DATA_DIR", directory);
  const app = openDatabase(":memory:");
  try {
    app.prepare(`INSERT INTO card_catalog (ygoprodeck_id,name,type,frame_type,effect_text,image_url,image_url_small,card_sets_json,cached_at)
      VALUES (17242022,'Red-Eyes Black Dragon Exceed','Effect Monster','effect','','main','small','[]','now')`).run();
    const fetch = vi.fn();
    const catalog = createCardCatalogService(app, { fetch });
    await catalog.syncDraftPool({ setNames: [], includeNames: [], excludeNames: [], customCardIds: [17242023] });
    expect(fetch).not.toHaveBeenCalled();
    expect(app.prepare("SELECT card_id,artwork_id,source FROM card_artworks WHERE artwork_id=17242023").get())
      .toEqual({ card_id: 17242022, artwork_id: 17242023, source: "engine" });
  } finally { app.close(); }
  expect(inspectDeck("normal", { main:[17242023], extra:[], side:[] }, directory,
    normalizeDuelSettings("normal", { validateDeck:false, startingHand:1, banlist:"none", cardPool:"both" })).issues).toEqual([]);
  request.mockClear();
  expect((await prepareData(directory, request)).skipped).toBe(true);
  expect(request).not.toHaveBeenCalled();
});

it("rebuilds an old base-only cache at identical pins and preserves built Domain resources", async () => {
  const { request, directory } = fixture();
  const first = await prepareData(directory, request);
  const { databaseFormat: _format, databaseFiles: _files, ...oldSources } = first.sources;
  writeFileSync(join(directory, "card-scripts/domain.lua"), "domain");
  writeFileSync(join(directory, "card-scripts/domain.legacy.lua"), "legacy domain");
  writeFileSync(join(directory, "ocgcore.domain.wasm"), "domain wasm");
  writeFileSync(join(directory, "ocgcore.domain.legacy.wasm"), "legacy wasm");
  const old = { ...first, sources:{...oldSources, domainCore:{pin:"domain"}, domainCoreLegacy:{pin:"legacy"}} };
  writeFileSync(join(directory, "manifest.json"), JSON.stringify(old));
  request.mockClear();
  const updated = await prepareData(directory, request);
  expect(updated.skipped).toBe(false);
  expect(request).toHaveBeenCalled();
  expect(updated.sources.domainCore).toEqual({pin:"domain"});
  expect(updated.integrity.domainWasm).toBe(hash("domain wasm"));
  expect(updated.integrity.domainLua).toBe(hash("domain"));
  expect(updated.integrity.domainLegacyLua).toBe(hash("legacy domain"));
  expect(updated.bundleVersion).not.toBe(old.bundleVersion);
});

it("keeps the bundle version stable when SQLite changes only the merged bytes", async () => {
  const { request, directory } = fixture();
  const first = await prepareData(directory, request);
  const merge = releasedCardData.downloadReleasedCardData;
  vi.spyOn(releasedCardData, "downloadReleasedCardData").mockImplementation(async (...args) => {
    const result = await merge(...args);
    const bytes = Buffer.from(result.bytes);
    bytes.writeUInt32BE(bytes.readUInt32BE(96) + 1, 96); // SQLite's library version header
    return { ...result, bytes };
  });
  const second = await prepareData(join(root(), "bundle"), request);
  expect(second.integrity.cardsMerged).not.toBe(first.integrity.cardsMerged);
  expect(second.integrity.cards).toBe(first.integrity.cards);
  expect(second.bundleVersion).toBe(first.bundleVersion);
});

it("rebuilds merged-byte manifests and corrupt output, but changes version only for changed inputs", async () => {
  const { request, databases, directory } = fixture();
  const first = await prepareData(directory, request);
  const { cardsMerged: _merged, ...oldIntegrity } = first.integrity;
  writeFileSync(join(directory, "manifest.json"), JSON.stringify({ sources: first.sources, integrity: oldIntegrity, bundleVersion: first.bundleVersion }));
  request.mockClear();
  expect((await prepareData(directory, request)).skipped).toBe(false);
  expect(request).toHaveBeenCalled();
  writeFileSync(join(directory, "cards.cdb"), "corrupt");
  const repaired = await prepareData(directory, request);
  expect(repaired.skipped).toBe(false);
  expect(repaired.integrity.cardsMerged).toBe(first.integrity.cardsMerged);
  expect(repaired.bundleVersion).toBe(first.bundleVersion);
  databases.set("release-z.cdb", cdb(root(), "changed.cdb", [[2, 1, "Changed upstream"]]));
  rmSync(join(directory, "manifest.json"));
  expect((await prepareData(directory, request)).bundleVersion).not.toBe(first.bundleVersion);
});


it("deduplicates prereleases by name/type, gives released rows precedence, and excludes Rush/Legend rows", async () => {
  const dir = root();
  const databases = new Map([
    ["cards.cdb", cdb(dir, "base.cdb", [[12,0,"Graduated"], [13,0,"Same name"]])],
    ["prerelease-a.cdb", cdb(dir, "a.cdb", [[100000001,0,"Graduated"], [100000002,0,"Preview"], [100000003,0,"Same name"], [100000004,0,"Rush"], [100000005,0,"Legend"]])],
    ["prerelease-a-en.cdb", cdb(dir, "en.cdb", [[22,0,"Preview"]])],
    ["release-z.cdb", cdb(dir, "release.cdb", [[13,0,"Latest released text"]])],
  ]);
  const a = new Database(join(dir,"a.cdb"));
  a.exec("UPDATE datas SET ot=513 WHERE id=100000004; UPDATE datas SET ot=1025 WHERE id=100000005; UPDATE datas SET type=2 WHERE id=100000003");
  a.close(); databases.set("prerelease-a.cdb",readFileSync(join(dir,"a.cdb")));
  const request = async (url: string) => url.includes("/git/trees/") ? Response.json(tree([...databases.keys(),"prerelease-cards-rush.cdb"])) : new Response(new Uint8Array(databases.get(url.split("/").pop()!)!));
  const result = await downloadReleasedCardData(sources.database, join(dir,"bundle"), request);
  const db = new Database(result.path);
  try {
    expect(db.prepare("SELECT id FROM datas ORDER BY id").all()).toEqual([{id:12},{id:13},{id:22},{id:100000003}]);
    expect(db.prepare("SELECT name FROM texts WHERE id=13").get()).toEqual({name:"Latest released text"});
    expect(db.prepare("SELECT ot FROM datas WHERE id=22").get()).toEqual({ot:259});
    expect(db.prepare("SELECT setcode FROM datas WHERE id=22").safeIntegers().get()).toEqual({setcode:9223372036854775807n});
  } finally {db.close();}
  expect(result.remaps).toEqual({100000001:12,100000002:22});
  expect(result.drops).toEqual(expect.arrayContaining([
    expect.objectContaining({code:100000001,keptCode:12,reason:"released"}),
    expect.objectContaining({code:100000002,keptCode:22,reason:"duplicate"}),
    expect.objectContaining({code:100000004,reason:"rush"}),
    expect.objectContaining({code:100000005,reason:"rush"}),
  ]));
  expect([...result.prereleaseCodes]).toEqual([22,100000003]);
});

it("records graduated historical identities even when Ignis deleted their prerelease file", async () => {
  const {request,directory} = fixture();
  const result = await downloadReleasedCardData(sources.database,directory,request,{historicalCards:[
    {code:100001234,name:"Red-Eyes Black Dragon Exceed",type:33},
    {code:100001235,name:"Withdrawn preview",type:33},
    {code:100001236,name:"Red-Eyes Black Dragon Exceed",type:2},
  ]});
  expect(result.remaps).toEqual({100001234:17242022});
  expect(JSON.parse(readFileSync(join(directory,"card-remaps.json"),"utf8")).remaps).toEqual(result.remaps);
});

it("includes the remap artifact in bundle identity and repairs a corrupt cached artifact", async () => {
  const {request,directory} = fixture();
  const first=await prepareData(directory,request);
  expect(first.sources.databaseFormat).toBe("official-releases-prerelease-v4");
  expect(first.integrity.cardRemaps).toBe(hash(readFileSync(join(directory,"card-remaps.json"))));
  writeFileSync(join(directory,"card-remaps.json"),"corrupt");
  request.mockClear();
  const next=await prepareData(directory,request);
  expect(next.skipped).toBe(false);
  expect(next.bundleVersion).toBe(first.bundleVersion);
  expect(request).toHaveBeenCalled();
});

it.each([true,false])("refuses contradictory passcode identities instead of corrupting a saved remap (retained=%s)",async retained=>{
 const dir=root();
 const databases=new Map([
  ["cards.cdb",cdb(dir,"base.cdb",[[12,0,"A"],[13,0,"B"]])],
  ["prerelease-a.cdb",cdb(dir,"a.cdb",[[100000001,0,"A"]])],
  ["prerelease-b.cdb",cdb(dir,"b.cdb",[[100000001,0,retained?"Preview B":"B"]])],
 ]);
 const request=async(url:string)=>url.includes("/git/trees/")?Response.json(tree([...databases.keys()])):new Response(new Uint8Array(databases.get(url.split("/").pop()!)!));
 await expect(downloadReleasedCardData(sources.database,join(dir,"bundle"),request)).rejects.toThrow(/Ambiguous.*passcode/);
});

it("refuses historical graduation when a different current preview reuses the old passcode",async()=>{
 const dir=root();
 const databases=new Map([
  ["cards.cdb",cdb(dir,"base.cdb",[[12,0,"Graduated A"]])],
  ["prerelease-b.cdb",cdb(dir,"b.cdb",[[100000001,0,"New preview B"]])],
 ]);
 const request=async(url:string)=>url.includes("/git/trees/")?Response.json(tree([...databases.keys()])):new Response(new Uint8Array(databases.get(url.split("/").pop()!)!));
 await expect(downloadReleasedCardData(sources.database,join(dir,"bundle"),request,{historicalCards:[
  {code:100000001,name:"Graduated A",type:33},
 ]})).rejects.toThrow(/Ambiguous.*passcode/);
});


it("preserves Cynet Mining's real prerelease alternate artwork beside its released main art", async () => {
  const dir = root();
  const databases = new Map([
    ["cards.cdb", cdb(dir, "base.cdb", [[57160136, 0, "Cynet Mining", 2]])],
    ["prerelease-imph.cdb", cdb(dir, "preview.cdb", [[57160137, 57160136, "Cynet Mining", 2]])],
  ]);
  const request = async (url: string) => url.includes("/git/trees/") ? Response.json(tree([...databases.keys()]))
    : new Response(new Uint8Array(databases.get(url.split("/").pop()!)!));
  const result = await downloadReleasedCardData(sources.database, join(dir, "bundle"), request, {
    historicalCards: [{ code: 57160137, alias: 57160136, name: "Cynet Mining", type: 2 }],
  });
  expect(result.drops).toEqual([]);
  expect(result.remaps).toEqual({});
  expect([...result.prereleaseCodes]).toEqual([57160137]);
  expect(result.prerelease[0]).toMatchObject({atk:2500,def:2000,level:7,attribute:32});
  const db = new Database(result.path, { readonly: true });
  try { expect(db.prepare("SELECT alias FROM datas WHERE id=57160137").get()).toEqual({ alias: 57160136 }); }
  finally { db.close(); }
});

it("only uses main artworks for identity matches between preview files and released rows", async () => {
  const dir = root();
  const databases = new Map([
    ["cards.cdb", cdb(dir, "base.cdb", [[57160137, 57160136, "Cynet Mining", 2]])],
    ["prerelease-a.cdb", cdb(dir, "preview.cdb", [[57160136, 0, "Cynet Mining", 2], [57160138, 57160136, "Cynet Mining", 2]])],
  ]);
  const request = async (url: string) => url.includes("/git/trees/") ? Response.json(tree([...databases.keys()]))
    : new Response(new Uint8Array(databases.get(url.split("/").pop()!)!));
  const result = await downloadReleasedCardData(sources.database, join(dir, "bundle"), request);
  expect(result.drops).toEqual([]);
  expect(result.remaps).toEqual({});
  expect([...result.prereleaseCodes]).toEqual([57160136, 57160138]);
});

it("preserves distinct same-name tokens and never creates historical token remaps", async () => {
  const dir = root();
  const databases = new Map([
    ["cards.cdb", cdb(dir, "base.cdb", [[23116809, 0, "Fireball Token"]])],
    ["prerelease-tokens.cdb", cdb(dir, "tokens.cdb", [[98596597, 0, "Fireball Token"], [100000002, 0, "Fireball Token"]])],
  ]);
  for (const [file, path] of [["cards.cdb", "base.cdb"], ["prerelease-tokens.cdb", "tokens.cdb"]]) {
    const db = new Database(join(dir, path!));
    db.exec("UPDATE datas SET type=16401"); db.close();
    databases.set(file!, readFileSync(join(dir, path!)));
  }
  const request = async (url: string) => url.includes("/git/trees/") ? Response.json(tree([...databases.keys()]))
    : new Response(new Uint8Array(databases.get(url.split("/").pop()!)!));
  const result = await downloadReleasedCardData(sources.database, join(dir, "bundle"), request, {
    historicalCards: [{ code: 100000003, name: "Fireball Token", type: 16401 }],
  });
  expect(result.drops).toEqual([]);
  expect(result.remaps).toEqual({});
  expect([...result.prereleaseCodes]).toEqual([98596597, 100000002]);
});


it("remaps a missing historical alternate artwork to its graduated main card", async () => {
  const dir = root();
  const databases = new Map([
    ["cards.cdb", cdb(dir, "base.cdb", [[10000080, 0, "The Winged Dragon of Ra"]])],
  ]);
  const request = async (url: string) => url.includes("/git/trees/") ? Response.json(tree([...databases.keys()]))
    : new Response(new Uint8Array(databases.get(url.split("/").pop()!)!));
  const result = await downloadReleasedCardData(sources.database, join(dir, "bundle"), request, {
    historicalCards: [
      { code: 101403130, alias: 101403030, name: "The Winged Dragon of Ra", type: 33 },
      { code: 101403131, alias: 101403031, name: "The Winged Dragon of Ra", type: 33 },
      { code: 101403132, alias: 101403030, name: "Ra Token", type: 16401 },
      { code: 101403030, name: "The Winged Dragon of Ra", type: 33 },
    ],
  });
  expect(result.remaps).toEqual({ 101403030: 10000080, 101403130: 10000080 });
  expect(JSON.parse(readFileSync(join(dir, "bundle/card-remaps.json"), "utf8")).remaps).toEqual(result.remaps);
  expect(result.scriptCodes.has(101403130)).toBe(false);
});

it("updates a surviving artwork alias after its main preview graduates through history", async () => {
 const dir=root();
 const databases=new Map([
  ["cards.cdb",cdb(dir,"base.cdb",[[12,0,"Graduated"]])],
  ["prerelease-art.cdb",cdb(dir,"art.cdb",[[100000002,100000001,"Graduated"]])],
 ]);
 const request=async(url:string)=>url.includes("/git/trees/")?Response.json(tree([...databases.keys()])):new Response(new Uint8Array(databases.get(url.split("/").pop()!)!));
 const result=await downloadReleasedCardData(sources.database,join(dir,"bundle"),request,{historicalCards:[
  {code:100000002,alias:100000001,name:"Graduated",type:33},
  {code:100000001,name:"Graduated",type:33},
 ]});
 expect(result.remaps).toEqual({100000001:12});
 expect([...result.prereleaseCodes]).toEqual([100000002]);
 const db=new Database(result.path,{readonly:true});
 try{expect(db.prepare("SELECT alias FROM datas WHERE id=100000002").get()).toEqual({alias:12});}finally{db.close();}
});

it("puts real renamed graduation evidence into the common remap artifact, retaining only official rows", async () => {
 const fixture = JSON.parse(readFileSync(new URL("./fixtures/prerelease-graduations.json",import.meta.url),"utf8"));
 const dir=root(), examples=fixture.examples;
 const bytes=cdb(dir,"official.cdb",examples.map(({after}:any)=>[after.code,0,after.name,after.type]));
 const request=async(url:string)=>url.includes("/git/trees/")?Response.json(tree(["cards.cdb"])):new Response(new Uint8Array(bytes));
 const transition={commit:fixture.databaseCommit,removed:examples.map((x:any)=>x.before),added:examples.map((x:any)=>x.after)};
 const result=await downloadReleasedCardData(sources.database,join(dir,"bundle"),request,{historicalCards:transition.removed,historicalGraduations:[transition]});
 expect(result.remaps).toEqual({101402001:77482666,101402002:4881365,101402021:25158975});
 expect(result.unmatched).toEqual([]);
 expect(JSON.parse(result.remapBytes).remaps).toEqual(result.remaps);
});

it("includes exact override source bytes in bundle integrity and validates sources/targets before remapping", async () => {
 const {request,directory}=fixture();
 const historicalCards=[{code:101402001,name:"Old preview name",type:33}];
 const overrideBytes='{"101402001":17242022}\n';
 const result=await downloadReleasedCardData(sources.database,directory,request,{historicalCards,overrideBytes});
 expect(result.remaps).toEqual({101402001:17242022});
 expect(JSON.parse(result.remapBytes).overrideSource).toBe(overrideBytes);
 for(const overrideBytes of ['{"999999999":17242022}', '{"101402001":999}', '{"17242022":1}', '{"101402001":17242023}']){
  await expect(downloadReleasedCardData(sources.database,join(root(),"bundle"),request,{historicalCards,overrideBytes})).rejects.toThrow(/override/i);
 }
});

it("carries detected historical edges through reviewed overrides to the retained target",async()=>{
 const {request,directory}=fixture();
 const example=JSON.parse(readFileSync(new URL("./fixtures/prerelease-graduations.json",import.meta.url),"utf8")).examples[0];
 const result=await downloadReleasedCardData(sources.database,directory,request,{historicalCards:[example.before,{...example.after,code:100000010}],historicalGraduations:[{commit:"earlier",removed:[example.before],added:[{...example.after,code:100000010}]}],overrideBytes:'{"100000010":17242022}\n'});
 expect(result.remaps).toEqual({101402001:17242022,100000010:17242022});
 expect(result.unmatched).toEqual([]);
});

it.each([1,null])("lets a reviewed override (%s) replace or veto an automatic graduation",async target=>{
 const {request,directory}=fixture();
 const example=JSON.parse(readFileSync(new URL("./fixtures/prerelease-graduations.json",import.meta.url),"utf8")).examples[0];
 const after={...example.after,code:17242022};
 const overrideBytes=JSON.stringify({[example.before.code]:target});
 const result=await downloadReleasedCardData(sources.database,directory,request,{historicalCards:[example.before],historicalGraduations:[{commit:"automatic",removed:[example.before],added:[after]}],overrideBytes});
 expect(result.remaps).toEqual(target===null?{}:{[example.before.code]:target});
 expect(JSON.parse(result.remapBytes).overrides).toEqual({[example.before.code]:target});
 expect(result.unmatched).toEqual([]);
 expect(JSON.parse(result.remapBytes).unmatched).toEqual([]);
});

it.each([1,null])("lets a reviewed override (%s) replace or veto a name/type remap",async target=>{
 const {request,directory}=fixture();
 const result=await downloadReleasedCardData(sources.database,directory,request,{historicalCards:[{code:101402001,name:"Red-Eyes Black Dragon Exceed",type:33}],overrideBytes:JSON.stringify({101402001:target})});
 expect(result.remaps).toEqual(target===null?{}:{101402001:target});
 expect(result.unmatched).toEqual([]);
 expect(JSON.parse(result.remapBytes).unmatched).toEqual([]);
});

it("does not follow an automatic chain through a vetoed intermediate code",async()=>{
 const {request,directory}=fixture();
 const example=JSON.parse(readFileSync(new URL("./fixtures/prerelease-graduations.json",import.meta.url),"utf8")).examples[0];
 const intermediate={...example.after,code:100000010};
 const result=await downloadReleasedCardData(sources.database,directory,request,{historicalCards:[example.before,intermediate],historicalGraduations:[{commit:"first",removed:[example.before],added:[intermediate]},{commit:"second",removed:[intermediate],added:[{...example.after,code:17242022}]}],overrideBytes:'{"100000010":null}'});
 expect(result.remaps).toEqual({});
 expect(result.unmatched.map(card=>card.code)).toEqual([example.before.code]);
});

it("smoke-checks unchanged prerelease scripts during preparation, removes failures, and caches the result",async()=>{
 const f=fixture(),dir=root();
 f.databases.set("prerelease-test.cdb",cdb(dir,"preview.cdb",[[100000001,0,"Healthy preview"],[100000002,0,"Broken preview"]]));
 const scripts=join(dir,"stock");mkdirSync(join(scripts,"pre-release"),{recursive:true});mkdirSync(join(scripts,"official"));
 writeFileSync(join(scripts,"constant.lua"),"");writeFileSync(join(scripts,"utility.lua"),"function GetID() return self_table,self_code end");
 writeFileSync(join(scripts,"pre-release/c100000001.lua"),"local s,id=GetID();function s.initial_effect(c) end");
 writeFileSync(join(scripts,"pre-release/c100000002.lua"),"local s,id=GetID();function s.initial_effect(c) error('broken preview') end");
 writeFileSync(join(scripts,"official/c1.lua"),"local s,id=GetID();function s.initial_effect(c) error('released error') end");
 cpSync(new URL("./fixtures/card-scripts/c3743515.lua",import.meta.url),join(scripts,"official/c3743515.lua"));
 const archive=execFileSync("tar",["-czf","-","-C",dir,"stock"]);
 const original=f.request.getMockImplementation()!;
 f.request.mockImplementation(async(input:string|URL|Request)=>String(input).includes("/git/trees/")?Response.json(tree([...f.databases.keys()])):String(input).includes("codeload")?new Response(new Uint8Array(archive)):original(input));
 const prepared=await prepareData(f.directory,f.request),artifact=JSON.parse(readFileSync(join(f.directory,"card-remaps.json"),"utf8"));
 expect(artifact.scriptSmoke.checked).toBe(2);expect(artifact.scriptSmoke.excluded.map((card:any)=>card.code)).toEqual([100000002]);
 expect(artifact.prerelease.map((card:any)=>card.code)).toEqual([100000001]);
 const db=new Database(join(f.directory,"cards.cdb"));try{expect(db.prepare("SELECT id FROM datas WHERE id IN (1,100000001,100000002) ORDER BY id").all()).toEqual([{id:1},{id:100000001}]);}finally{db.close();}
 expect(existsSync(join(f.directory,"card-scripts/pre-release/c100000002.lua"))).toBe(false);
 expect(existsSync(join(f.directory,"card-scripts/official/c1.lua"))).toBe(true);
 expect(prepared.integrity.cardRemaps).toBe(hash(readFileSync(join(f.directory,"card-remaps.json"))));
 f.request.mockClear();expect((await prepareData(f.directory,f.request)).skipped).toBe(true);expect(f.request).not.toHaveBeenCalled();
});
