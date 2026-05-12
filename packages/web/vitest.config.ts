import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { resolve } from "path";
import { fileURLToPath } from "url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  plugins: [react()],
  root: __dirname,
  test: {
    // Component tests use jsdom; pure unit tests run in node by default.
    // Individual test files opt-in via `// @vitest-environment jsdom`.
    environment: "node",
    globals: true,
    setupFiles: ["./tests/setup.ts"],
    exclude: [".next/**", "node_modules/**"],
  },
  resolve: {
    // Dedupe ensures a single React instance across vitest + @testing-library.
    // The local packages/web/node_modules/react has been removed so only the
    // workspace-root copy (node_modules/react) exists.
    dedupe: ["react", "react-dom"],
    alias: {
      "@": resolve(__dirname, "./src"),
    },
  },
});
