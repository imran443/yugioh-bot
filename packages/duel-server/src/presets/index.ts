import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { DuelFormat } from "@yugidraft/shared/duels";
import { seatCountFor } from "@yugidraft/shared/duels";
import { preset as dustTornado } from "./dust-tornado-chain.js";
import { preset as ffa4ChainOrder } from "./ffa4-chain-order-heavy-storm.js";
import { preset as ffa4Surrender } from "./ffa4-surrender-in-chain.js";
import { presets as ffa3Elimination } from "./ffa3-elimination.js";
import { presets as ffa3Table } from "./ffa3-table.js";
import { presets as ffa3Rules } from "./ffa3-rules.js";
import { preset as ffa4RulesExtraZones } from "./ffa4-rules-extra-zones.js";
import { preset as ffa3Direct } from "./ffa3-table-direct.js";
import { preset as turnPlayerLast } from "./ffa3-turn-player-last.js";
import { preset as thirdResponse } from "./ffa3-third-response.js";
import { preset as jinzo } from "./jinzo-stops-trap.js";
import { preset as mindCrush } from "./mind-crush-ffa4-pick.js";
import { preset as negationVeiler } from "./negation-veiler-ffa4.js";
import { preset as negationVeiler1v1 } from "./negation-veiler-1v1.js";
import { preset as mindCrush3 } from "./ffa3-mind-crush-pick.js";
import { presets as raigekiDarkHole } from "./raigeki-dark-hole.js";
import { preset as solemn } from "./solemn-judgment-summon.js";
import { preset as tagJinzo } from "./tag-jinzo-blocks-traps.js";
import { preset as tagSolemn } from "./tag-lp-solemn-partner.js";
import type { Preset } from "./types.js";

export type { Preset } from "./types.js";
export { compileBoard, type BoardSpec, type CompiledBoard } from "./board.js";

/** The registry. 1v1 presets first, then the ones that need the multi-duelist core. */
export const PRESETS: readonly Preset[] = [
  dustTornado,
  solemn,
  jinzo,
  negationVeiler1v1,
  ...raigekiDarkHole,
  mindCrush,
  negationVeiler,
  mindCrush3,
  tagSolemn,
  tagJinzo,
  ffa4ChainOrder,
  ffa4Surrender,
  ...ffa3Table,
  ...ffa3Rules,
  ffa4RulesExtraZones,
  ...ffa3Elimination,
  ffa3Direct,
  turnPlayerLast,
  thirdResponse,
];

export function getPreset(id: string): Preset | undefined {
  return PRESETS.find((preset) => preset.id === id);
}

/** Bot policy name stored in `setup_json.botPolicies`. */
export const SCRIPTED_POLICY = "scripted";

/** The multi-duelist wasm that the engine loads for more than two seats exists in this engine data directory. */
export function multiCoreAvailable(dataDirectory: string): boolean {
  return existsSync(join(dataDirectory, "ocgcore.multi.wasm"));
}

/** A known problem that a preset may run into (the known-issues registry). */
export interface PresetIssue {
  sig: string;
  title: string;
  owner: string;
}

/** The multi-duelist core of the data directory: the sha256 of `ocgcore.multi.wasm` and the `tag=` of `ocgcore.multi.SOURCE`. */
export interface MultiCoreInfo {
  tag: string | null;
  sha: string | null;
}

const shaCache = new Map<string, { key: string; sha: string }>();

export function multiCoreInfo(dataDirectory: string): MultiCoreInfo {
  const wasm = join(dataDirectory, "ocgcore.multi.wasm");
  let sha: string | null = null;
  if (existsSync(wasm)) {
    const stat = statSync(wasm);
    const key = `${stat.size}:${stat.mtimeMs}`;
    const cached = shaCache.get(wasm);
    if (cached?.key === key) sha = cached.sha;
    else {
      sha = createHash("sha256").update(readFileSync(wasm)).digest("hex");
      shaCache.set(wasm, { key, sha });
    }
  }
  let tag: string | null = null;
  const source = join(dataDirectory, "ocgcore.multi.SOURCE");
  if (existsSync(source)) {
    const match = /^tag=(.+)$/m.exec(readFileSync(source, "utf8"));
    tag = match ? match[1]!.trim() || null : null;
  }
  return { tag, sha };
}

export interface PresetSummary {
  id: string;
  title: string;
  format: DuelFormat;
  humanSeat: 0;
  seats: number;
  checklist: string[];
  rules: string[];
  needsMultiCore: boolean;
  needs: "multi-core" | null;
  available: boolean;
  unavailableReason: string | null;
  /** Known problems for this preset (empty when none are registered). */
  issues: PresetIssue[];
}

export function summarizePreset(preset: Preset, dataDirectory: string, issues: PresetIssue[] = []): PresetSummary {
  const needsMultiCore = preset.needs === "multi-core";
  const available = !needsMultiCore || multiCoreAvailable(dataDirectory);
  return {
    id: preset.id,
    title: preset.title,
    format: preset.format,
    humanSeat: preset.humanSeat,
    seats: seatCountFor(preset.format),
    checklist: [...preset.checklist],
    rules: [...preset.rules],
    needsMultiCore,
    needs: preset.needs ?? null,
    available,
    unavailableReason: available ? null : "This scenario needs the multi-duelist engine core, which is not installed on this server yet.",
    issues: issues.map((issue) => ({ sig: issue.sig, title: issue.title, owner: issue.owner })),
  };
}
