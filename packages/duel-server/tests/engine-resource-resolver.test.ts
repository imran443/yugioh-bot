import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isEngineIdentity, type EngineIdentity, type ReplaySource } from "@yugidraft/shared/duels";
import { getCurrentEngineResources, resolveEngineResourcesForSource, verifyWorkerEngineIdentity } from "../src/engine-resource-resolver.js";

const directories: string[] = [];
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
afterEach(() => { vi.unstubAllEnvs(); for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function bundle() {
  const directory = mkdtempSync(join(tmpdir(), "replay-resources-"));
  directories.push(directory);
  vi.stubEnv("DUEL_MULTI_SCRIPTS_DIR", join(directory, "multi-scripts"));
  const files = {
    "manifest.json": JSON.stringify({ bundleVersion: "bundle-1" }),
    "cards.cdb": "cards", "card-remaps.json": "{}",
    "ocgcore.standard.wasm": "standard", "ocgcore.domain.wasm": "domain",
    "ocgcore.domain.legacy.wasm": "legacy-domain",
    "ocgcore.multi.wasm": "multi", "ocgcore.multi-domain.wasm": "multi-domain",
    "card-scripts/constant.lua": "constants", "card-scripts/domain.lua": "domain-script",
    "card-scripts/domain.legacy.lua": "legacy-script", "card-scripts/official/c1.lua": "card-script",
    "multi-scripts/mp-utility.lua": "overlay",
    "multi-scripts/MANIFEST.json": JSON.stringify({ version: 1, cards: [] }),
  };
  for (const [file, value] of Object.entries(files)) {
    mkdirSync(join(directory, file, ".."), { recursive: true });
    writeFileSync(join(directory, file), value);
  }
  return directory;
}

function source(directory: string, mode: "normal" | "domain" = "normal", format: "1v1" | "tag" | "ffa3" | "ffa4" = "1v1", engine: "legacy" | "pinned" = "pinned") {
  const resources = getCurrentEngineResources(directory, { mode, format, engine,
    ...(format !== "1v1" ? { multiScriptsDirectory: join(directory, "multi-scripts") } : {}) });
  const value = {
    session: { mode, format, masterRule: 5 }, bundleVersion: resources.bundleVersion,
    setup: { engine, firstTurnDraw: false, scriptErrorMode: "tolerant" }, engineIdentity: resources.identity,
  } as Pick<ReplaySource, "session" | "bundleVersion" | "setup" | "engineIdentity">;
  return { value, resources };
}

describe("current engine identity", () => {
  it.each([
    ["normal", "1v1", "pinned", "standard", null],
    ["domain", "1v1", "pinned", "domain", "domain-script"],
    ["domain", "1v1", "legacy", "legacy-domain", "legacy-script"],
    ["normal", "tag", "legacy", "multi", null],
    ["domain", "ffa3", "pinned", "multi-domain", "domain-script"],
    ["domain", "ffa4", "legacy", "multi-domain", "domain-script"],
  ] as const)("identifies %s %s with choice %s", (mode, format, engine, wasm, script) => {
    const { resources } = source(bundle(), mode, format, engine);
    expect(isEngineIdentity(resources.identity)).toBe(true);
    expect(resources.identity).toMatchObject({ mode, coreFamily: format === "1v1" ? engine : "multi",
      wasmHash: hash(wasm), domainScriptHash: script === null ? null : hash(script) });
    expect(resources.multiScriptsDirectory ?? null).toBe(format === "1v1" ? null : join(resources.dataDirectory, "multi-scripts"));
  });

  it("identifies the npm legacy Normal core independently of pinned Standard", () => {
    const directory = bundle();
    const legacy = source(directory, "normal", "1v1", "legacy").resources.identity;
    const pinned = source(directory).resources.identity;
    expect(legacy.coreFamily).toBe("legacy");
    expect(legacy.wasmHash).not.toBe(pinned.wasmHash);
    expect(legacy.wrapperHash).toBe(pinned.wrapperHash);
  });

  it.each(["wasmHash", "wrapperHash", "cardDatabaseHash", "cardRemapsHash", "cardScriptsHash", "domainScriptHash", "multiOverlayHash"] as const)("refuses a changed %s", (field) => {
    const directory = bundle();
    const { value } = source(directory, "domain", "ffa4");
    value.engineIdentity = { ...value.engineIdentity!, [field]: "0".repeat(64) };
    expect(() => resolveEngineResourcesForSource(directory, value)).toThrowError(expect.objectContaining({ code: "ENGINE_UNAVAILABLE_FOR_SOURCE", status: 409 }));
  });

  it.each(["wrapperVersion", "protocolVersion", "hostRuleVersion", "coreFamily", "mode", "version"] as const)("refuses a changed %s without fallback", (field) => {
    const directory = bundle();
    const { value } = source(directory);
    value.engineIdentity = { ...value.engineIdentity!, [field]: field === "version" ? 2 : "different" } as unknown as EngineIdentity;
    expect(() => resolveEngineResourcesForSource(directory, value)).toThrowError(expect.objectContaining({ code: "ENGINE_UNAVAILABLE_FOR_SOURCE" }));
  });

  it.each(["cards.cdb", "ocgcore.standard.wasm", "card-scripts/official/c1.lua", "card-remaps.json"])("checks actual changed bytes at %s", (file) => {
    const directory = bundle();
    const { value } = source(directory);
    writeFileSync(join(directory, file), "changed");
    expect(() => resolveEngineResourcesForSource(directory, value)).toThrowError(expect.objectContaining({ code: "ENGINE_UNAVAILABLE_FOR_SOURCE" }));
  });

  it("refuses missing resources and does not look for archives", () => {
    const directory = bundle();
    const { value } = source(directory);
    rmSync(join(directory, "ocgcore.standard.wasm"));
    expect(() => resolveEngineResourcesForSource(directory, value)).toThrowError(expect.objectContaining({ code: "ENGINE_UNAVAILABLE_FOR_SOURCE" }));
  });

  it("refuses an old source without assigning today's identity", () => {
    const directory = bundle();
    const { value } = source(directory);
    value.engineIdentity = null;
    expect(() => resolveEngineResourcesForSource(directory, value)).toThrowError(expect.objectContaining({ code: "ENGINE_UNAVAILABLE_FOR_SOURCE" }));
    expect(value.engineIdentity).toBeNull();
  });

  it("refuses a bundle mismatch even when identity matches", () => {
    const directory = bundle();
    const { value } = source(directory);
    value.bundleVersion = "old-bundle";
    expect(() => resolveEngineResourcesForSource(directory, value)).toThrowError(expect.objectContaining({ code: "ENGINE_UNAVAILABLE_FOR_SOURCE" }));
  });

  it("keeps saved legacy choice when the current switch selects pinned", () => {
    const directory = bundle();
    const { value } = source(directory, "domain", "1v1", "legacy");
    expect(resolveEngineResourcesForSource(directory, value).identity.coreFamily).toBe("legacy");
    value.setup!.engine = "pinned";
    expect(() => resolveEngineResourcesForSource(directory, value)).toThrowError(expect.objectContaining({ code: "ENGINE_UNAVAILABLE_FOR_SOURCE" }));
  });

  it.each(["firstTurnDraw", "scriptErrorMode"] as const)("refuses missing recorded %s", (field) => {
    const directory = bundle();
    const { value } = source(directory);
    delete value.setup![field];
    expect(() => resolveEngineResourcesForSource(directory, value)).toThrowError(expect.objectContaining({ code: "ENGINE_UNAVAILABLE_FOR_SOURCE" }));
  });

  it("uses the pinned overlay in the worker after environment selection changes", () => {
    const directory = bundle();
    const { resources } = source(directory, "domain", "ffa4");
    vi.stubEnv("DUEL_MULTI_SCRIPTS_DIR", join(directory, "missing"));
    expect(() => verifyWorkerEngineIdentity(directory, { mode: "domain", format: "ffa4", multiScriptsDirectory: resources.multiScriptsDirectory }, resources.identity)).not.toThrow();
  });

  it("refuses changes between server selection and worker creation", () => {
    const directory = bundle();
    const { resources } = source(directory);
    writeFileSync(join(directory, "ocgcore.standard.wasm"), "changed before worker");
    expect(() => verifyWorkerEngineIdentity(directory, { mode: "normal", engine: "pinned" }, resources.identity)).toThrowError(expect.objectContaining({ code: "ENGINE_UNAVAILABLE_FOR_SOURCE" }));
  });

  it("includes multi core capabilities in the host rule identity", () => {
    const directory = bundle();
    const { value } = source(directory, "domain", "ffa4");
    writeFileSync(join(directory, "ocgcore.multi-domain.SOURCE"), `sha256=${value.engineIdentity!.wasmHash}\ncapabilities=ffa4-facing-extra-zones\n`);
    expect(() => resolveEngineResourcesForSource(directory, value)).toThrowError(expect.objectContaining({ code: "ENGINE_UNAVAILABLE_FOR_SOURCE" }));
  });

  it("accepts a current multi Domain source and does not change it", () => {
    const directory = bundle();
    const { value, resources } = source(directory, "domain", "ffa4");
    const before = structuredClone(value);
    expect(resolveEngineResourcesForSource(directory, value)).toEqual(resources);
    expect(value).toEqual(before);
  });

  it("refuses script symlinks that the folder digest would otherwise omit", () => {
    const directory = bundle();
    const { value } = source(directory);
    const target = join(directory, "outside.lua");
    writeFileSync(target, "script outside the hashed folder");
    symlinkSync(target, join(directory, "card-scripts/c2.lua"));
    expect(() => resolveEngineResourcesForSource(directory, value)).toThrowError(expect.objectContaining({ code: "ENGINE_UNAVAILABLE_FOR_SOURCE" }));
  });
});
