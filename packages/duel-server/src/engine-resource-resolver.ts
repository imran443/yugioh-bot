import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  isEngineIdentity, sameEngineIdentity, seatCountFor,
  type DuelEngineChoice, type DuelFormat, type DuelMode, type EngineIdentity, type ReplaySource,
} from "@yugidraft/shared/duels";
import { multiScriptsFolderHash, pinnedEngineVersion, resolveMultiScriptsDirectory } from "./multi-scripts.js";
import { readCoreCapabilities } from "./core-capabilities.js";
import { ENGINE_PROTOCOL_VERSION } from "./worker-protocol.js";

/** Bump when engine decoding, journal dispatch or view projection changes. */
export const ENGINE_HOST_RULE_VERSION = "duel-rules-1";

export class EngineResourceUnavailableError extends Error {
  readonly code = "ENGINE_UNAVAILABLE_FOR_SOURCE";
  readonly status = 409;
  constructor(reason: string) {
    super(`Replay unavailable: ${reason}. The saved final board is still available if recorded.`);
    this.name = "EngineResourceUnavailableError";
  }
}

export interface EngineResources {
  identity: EngineIdentity;
  dataDirectory: string;
  bundleVersion: string;
  /** Server-selected current overlay. Never read a resource path from source data or a request. */
  multiScriptsDirectory?: string;
}

interface ResourceOptions {
  mode: DuelMode;
  format?: DuelFormat;
  engine?: DuelEngineChoice;
  /** Internal worker handoff only; pin the folder selected before worker creation. */
  multiScriptsDirectory?: string;
}

function hashFile(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** Hash actual files, not manifest claims. This release has no archive lookup or resource cache. */
export function getCurrentEngineResources(dataDirectory: string, options: ResourceOptions): EngineResources {
  try {
    const directory = resolve(dataDirectory);
    const manifest = JSON.parse(readFileSync(join(directory, "manifest.json"), "utf8")) as { bundleVersion?: unknown };
    if (typeof manifest.bundleVersion !== "string" || !manifest.bundleVersion.trim()) throw new Error("missing bundle version");
    const multi = seatCountFor(options.format ?? "1v1") > 2;
    const coreFamily = multi ? "multi" : options.engine ?? "pinned";
    const packageDirectory = dirname(fileURLToPath(import.meta.resolve("ocgcore-wasm/package.json")));
    const wrapperVersion = (JSON.parse(readFileSync(join(packageDirectory, "package.json"), "utf8")) as { version: string }).version;
    const wasmName = multi ? (options.mode === "domain" ? "ocgcore.multi-domain.wasm" : "ocgcore.multi.wasm")
      : coreFamily === "legacy" ? (options.mode === "domain" ? "ocgcore.domain.legacy.wasm" : null)
      : options.mode === "domain" ? "ocgcore.domain.wasm" : "ocgcore.standard.wasm";
    const wasmHash = hashFile(wasmName ? join(directory, wasmName) : join(packageDirectory, "lib/ocgcore.sync.wasm"));
    // Include the patched decoder modules and Emscripten adapter used by the sync core.
    const wrapperHash = createHash("sha256").update(multiScriptsFolderHash(join(packageDirectory, "dist")))
      .update(hashFile(join(packageDirectory, "lib/ocgcore.sync.mjs"))).digest("hex");
    const scripts = join(directory, "card-scripts");
    const remaps = join(directory, "card-remaps.json");
    const overlay = multi ? options.multiScriptsDirectory ?? resolveMultiScriptsDirectory(directory) : null;
    if (multi && !overlay) throw new Error("missing current multi overlay");
    const multiOverlayHash = overlay ? multiScriptsFolderHash(overlay) : null;
    const capabilities = multi ? readCoreCapabilities(directory, wasmName!, wasmHash) : null;
    const identity: EngineIdentity = {
      version: 1, coreFamily, mode: options.mode, wasmHash, wrapperVersion, wrapperHash,
      protocolVersion: ENGINE_PROTOCOL_VERSION,
      cardDatabaseHash: hashFile(join(directory, "cards.cdb")),
      cardRemapsHash: existsSync(remaps) ? hashFile(remaps) : null,
      cardScriptsHash: multiScriptsFolderHash(scripts),
      domainScriptHash: options.mode === "domain" ? hashFile(join(scripts, coreFamily === "legacy" ? "domain.legacy.lua" : "domain.lua")) : null,
      multiOverlayHash,
      hostRuleVersion: `${ENGINE_HOST_RULE_VERSION}:${JSON.stringify(capabilities)}`,
    };
    if (!isEngineIdentity(identity)) throw new Error("invalid current engine identity");
    return { identity, dataDirectory: directory,
      bundleVersion: pinnedEngineVersion(manifest.bundleVersion, seatCountFor(options.format ?? "1v1"), multiOverlayHash),
      ...(overlay ? { multiScriptsDirectory: resolve(overlay) } : {}) };
  } catch {
    // Filesystem errors can contain private paths. Give callers one stable public error.
    throw new EngineResourceUnavailableError("the current engine resources are incomplete");
  }
}

/** Refuse before engine creation. Never assign today's identity to an old source. */
export function resolveEngineResourcesForSource(
  dataDirectory: string,
  source: Pick<ReplaySource, "session" | "bundleVersion" | "setup" | "engineIdentity">,
): EngineResources {
  if (!isEngineIdentity(source.engineIdentity)) throw new EngineResourceUnavailableError("this game has no verified recorded engine identity");
  if (typeof source.setup?.firstTurnDraw !== "boolean"
    || (source.setup.scriptErrorMode !== "strict" && source.setup.scriptErrorMode !== "tolerant")) {
    throw new EngineResourceUnavailableError("the recorded engine rules are incomplete");
  }
  const engine = source.setup.engine ?? (source.setup.startupScripts?.length ? "pinned" : "legacy");
  const resources = getCurrentEngineResources(dataDirectory, { mode: source.session.mode, format: source.session.format, engine });
  if (source.bundleVersion !== resources.bundleVersion || !sameEngineIdentity(source.engineIdentity, resources.identity)) {
    throw new EngineResourceUnavailableError("the engine changed or its recorded resources and runtime rules do not match");
  }
  return resources;
}

/** Repeat the check inside the worker, using the exact overlay passed by the server. */
export function verifyWorkerEngineIdentity(dataDirectory: string, options: ResourceOptions, expected: EngineIdentity): void {
  const current = getCurrentEngineResources(dataDirectory, options);
  if (!isEngineIdentity(expected) || !sameEngineIdentity(expected, current.identity)) {
    throw new EngineResourceUnavailableError("the engine resources changed before worker creation");
  }
}
