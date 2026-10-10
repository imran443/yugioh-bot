import path from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

const worktreeRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const nextConfig: NextConfig = {
  output: "standalone",
  poweredByHeader: false,
  // The "N" badge covers the corner of the board in screenshots and in the 3D mode preview (dev only; no effect in a build).
  devIndicators: false,
  ...(process.env.E2E_NEXT_DIST_DIR ? { distDir: process.env.E2E_NEXT_DIST_DIR } : {}),
  // Parent-repo lockfile made Next trace standalone under
  // .next/standalone/.worktrees/domain-multiplayer/... so Docker
  // `node packages/web/server.js` would miss the emitted server.
  outputFileTracingRoot: worktreeRoot,
  transpilePackages: ["@yugidraft/shared"],
  serverExternalPackages: ["better-sqlite3", "sharp"],
  images: { unoptimized: true },
};

export default nextConfig;
