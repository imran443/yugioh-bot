import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

// DOMAIN_CORE_BUILD=docker (default): run packages/duel-server/scripts/build-domain-core.sh
// inside the pinned emscripten/emsdk image. DOMAIN_CORE_BUILD=local: run that same script on
// the host with DOMAIN_ROOT set; em++ must already be on PATH (source emsdk_env.sh first).
// There is no silent fallback between routes.
// DUEL_DATA_DIR overrides the resource bundle output (default $DOMAIN_ROOT/data/duel-engine).

const worktree = resolve(process.env.DOMAIN_ROOT ?? process.cwd());
// `tsx build-domain-core.ts legacy-domain` builds the Domain core of the old 1v1 engine (inputs in packages/duel-server/legacy-1v1).
const target = process.argv[2] ?? "domain";
if (!["domain", "standard", "legacy-domain", "multi", "multi-domain"].includes(target)) throw new Error(`unknown core target: ${target}`);
const multi = target === "multi" || target === "multi-domain";
const pinsPath = resolve(worktree, target === "legacy-domain" ? "packages/duel-server/legacy-1v1/domain-core/pins.json" : "packages/duel-server/domain-core/pins.json");
if (!existsSync(pinsPath)) throw new Error(`missing ${pinsPath}`);
const pins = JSON.parse(readFileSync(pinsPath, "utf8")) as { emscripten?: { image?: string; digest?: string } };
const imageName = pins.emscripten?.image ?? "docker.io/emscripten/emsdk:4.0.9";
const image = pins.emscripten?.digest ? `${imageName}@${pins.emscripten.digest}` : imageName;
// `tsx build-domain-core.ts standard` builds the Standard core (stock rules plus the shared core fixes) instead.
const script = target === "legacy-domain" ? "packages/duel-server/legacy-1v1/scripts/build-domain-core.sh" : `packages/duel-server/scripts/build-${multi ? "multi" : target}-core.sh`;
const mode = process.env.DOMAIN_CORE_BUILD ?? "docker";
const dataDir = process.env.DUEL_DATA_DIR ? resolve(process.env.DUEL_DATA_DIR) : undefined;

if (!existsSync(resolve(worktree, script))) {
  throw new Error(`missing ${script} under ${worktree}`);
}
if (mode !== "docker" && mode !== "local") {
  throw new Error(`DOMAIN_CORE_BUILD must be "docker" or "local"`);
}
if (dataDir) mkdirSync(dataDir, { recursive: true });

// Multi outputs can be isolated under this checkout rather than sharing domain-core/dist.
const buildEnv: Record<string, string> = {
  EMCC_CORES: process.env.EMCC_CORES ?? "2",
  ...(process.env.LUA_FIXED_SEED ? { LUA_FIXED_SEED: process.env.LUA_FIXED_SEED } : {}),
  ...(multi ? {
    LUA_FIXED_SEED: "1",
    OUT_NAME: `ocgcore.${target}.sync.wasm`,
    ...(target === "multi-domain" ? { APPLY_DOMAIN: "1", DOMAIN_MULTI: "1" } : {}),
  } : {}),
};
if (multi) {
  for (const key of ["MULTI_TREE", "MULTI_DIST", "PATCH_LIMIT", "OUT_NAME"] as const) {
    if (process.env[key]) buildEnv[key] = process.env[key]!;
  }
}
const dockerEnv = Object.entries(buildEnv).flatMap(([key, value]) => {
  if (key === "MULTI_TREE" || key === "MULTI_DIST") {
    const path = relative(worktree, resolve(worktree, value));
    if (path === ".." || path.startsWith("../") || isAbsolute(path)) throw new Error(`${key} must be inside ${worktree}`);
    value = `/src/${path}`;
  }
  return ["-e", `${key}=${value}`];
});

const result =
  mode === "local"
    ? spawnSync("bash", [script], {
        stdio: "inherit",
        cwd: worktree,
        env: {
          ...process.env,
          ...buildEnv,
          DOMAIN_ROOT: worktree,
          ...(dataDir ? { DUEL_DATA_DIR: dataDir } : {}),
        },
      })
    : spawnSync(
        "docker",
        [
          "run",
          "--rm",
          "--ulimit", "core=0:0",
          ...(process.getuid && process.getgid ? ["--user", `${process.getuid()}:${process.getgid()}`] : []),
          "-v",
          `${worktree}:/src`,
          "-w",
          "/src",
          "-e",
          "DOMAIN_ROOT=/src",
          ...dockerEnv,
          ...(dataDir ? ["-v", `${dataDir}:/duel-data`, "-e", "DUEL_DATA_DIR=/duel-data"] : []),
          image,
          "bash",
          script,
        ],
        { stdio: "inherit" },
      );

if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);

if (target === "multi-domain" && dataDir) {
  const dist = resolve(worktree, process.env.MULTI_DIST ?? "packages/duel-server/domain-core/dist");
  const outName = process.env.OUT_NAME ?? "ocgcore.multi-domain.sync.wasm";
  const infoName = `${outName.replace(/\.sync\.wasm$/, "")}-build-info.json`;
  copyFileSync(resolve(dist, outName), resolve(dataDir, "ocgcore.multi-domain.wasm"));
  copyFileSync(resolve(dist, infoName), resolve(dataDir, "ocgcore.multi-domain-build-info.json"));
}
