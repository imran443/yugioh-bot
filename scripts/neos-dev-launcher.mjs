import { existsSync } from "node:fs";
import path from "node:path";

export function getNeosViteCommand(extraArgs = []) {
  const repoRoot = path.resolve(import.meta.dirname, "..");
  const neosRoot = path.join(repoRoot, "vendor", "neos-ts");
  const viteBin = path.join(neosRoot, "node_modules", "vite", "bin", "vite.js");

  if (!existsSync(viteBin)) {
    throw new Error(
      "Neos Vite binary not found. Run `npm run setup:duel-web` before running this command.",
    );
  }

  return {
    command: process.execPath,
    args: [viteBin, ...extraArgs],
    cwd: neosRoot,
  };
}
