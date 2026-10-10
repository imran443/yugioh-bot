import type { getDb } from "./db";

/**
 * What a cube is for, stored in the cube's `config_json` as `draftType`:
 * `theme` for theme drafts (each player drafts privately from their own cube), `booster` for
 * cube drafts (packs passed around the table), `any` for a plain cube used for either.
 * A cube with no value, or one this code does not know, is `any`.
 */
export type CubeDraftType = "theme" | "booster" | "any";

export const CUBE_DRAFT_TYPES: readonly CubeDraftType[] = ["theme", "booster", "any"];

export const CUBE_TYPE_LABELS: Record<CubeDraftType, string> = {
  theme: "Theme cube",
  booster: "Cube draft",
  any: "Any",
};

export const CUBE_TYPE_HINTS: Record<CubeDraftType, string> = {
  theme: "Theme drafts: each player drafts privately from their own cube.",
  booster: "Cube drafts: packs are passed around the table, booster style.",
  any: "A plain cube you can use for either kind of draft.",
};

/**
 * The types a screen offers. While theme drafts are closed, a new cube cannot be a theme cube.
 * A cube that is already a theme cube keeps its type in view so the editor never shows a blank choice.
 */
export function offeredCubeTypes(themeDraftsEnabled: boolean, current?: CubeDraftType): CubeDraftType[] {
  return CUBE_DRAFT_TYPES.filter((type) => type !== "theme" || themeDraftsEnabled || current === "theme");
}

/** The hint under the type choice. It names no theme draft while theme drafts are closed. */
export function cubeTypeHint(type: CubeDraftType, themeDraftsEnabled: boolean): string {
  if (type === "any" && !themeDraftsEnabled) return "A plain cube you can use in any cube draft.";
  return CUBE_TYPE_HINTS[type];
}

export function parseCubeDraftType(value: unknown): CubeDraftType | null {
  return typeof value === "string" && (CUBE_DRAFT_TYPES as readonly string[]).includes(value)
    ? (value as CubeDraftType)
    : null;
}

function parseConfig(configJson: string | null | undefined): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(configJson || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function cubeDraftTypeOf(configJson: string | null | undefined): CubeDraftType {
  return parseCubeDraftType(parseConfig(configJson).draftType) ?? "any";
}

/** The pack settings a cube's saved config carries, for the cube draft check. */
export interface CubeDraftSettings {
  cardsPerPlayer?: number;
  packSize?: number;
  packsPerPlayer?: number;
  poolFromConfig?: boolean;
}

export function cubeDraftSettingsOf(configJson: string | null | undefined): CubeDraftSettings {
  const config = parseConfig(configJson);
  const settings: CubeDraftSettings = {};
  for (const key of ["cardsPerPlayer", "packSize", "packsPerPlayer"] as const) {
    const value = config[key];
    if (typeof value === "number" && Number.isInteger(value) && value > 0) settings[key] = value;
  }
  if ([config.setNames, config.customCardIds].some((value) => Array.isArray(value) && value.length > 0)) settings.poolFromConfig = true;
  return settings;
}

/** Write `draftType` into the cube's config and keep every other config key. */
export function setCubeDraftType(db: ReturnType<typeof getDb>, cubeId: number, type: CubeDraftType): void {
  const row = db.prepare("select config_json from cubes where id = ?").get(cubeId) as
    | { config_json: string | null }
    | undefined;
  if (!row) return;
  const config = { ...parseConfig(row.config_json), draftType: type };
  db.prepare("update cubes set config_json = ?, updated_at = ? where id = ?").run(
    JSON.stringify(config),
    new Date().toISOString(),
    cubeId,
  );
}
