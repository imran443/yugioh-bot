# Neos Runtime Spike Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove that `neos-ts` can be checked out, installed, launched, and smoke-tested from this monorepo without coupling it to the existing Next.js app yet.

**Architecture:** Keep upstream Neos isolated under `vendor/neos-ts` as a git submodule and expose it through a small `packages/duel-web` workspace wrapper. Add root scripts for setup/dev/build/smoke checks, but do not add `build` or `test` scripts to `packages/duel-web` yet so the existing `turbo run build` and `turbo run test` flows remain unaffected until the runtime spike is stable.

**Tech Stack:** npm workspaces, git submodules, Vite, React 18 inside Neos, Next.js 16/React 19 in the existing web app, Node.js smoke script using `child_process` and `fetch`.

---

## Scope

This plan only proves local Neos runtime viability. It does not wire tournament results, embed Neos inside Next.js, add Neos backend containers, or change tournament data models. Those belong in follow-up plans after this spike confirms Neos can run in this repo.

## File Structure

**New files:**
- `vendor/neos-ts` — git submodule pointing to `https://github.com/DarkNeos/neos-ts.git`.
- `packages/duel-web/package.json` — workspace wrapper scripts for Neos setup/dev/build/smoke.
- `scripts/check-neos-vendor.mjs` — fast static check that the Neos submodule and nested protobuf submodule are initialized.
- `scripts/smoke-neos-runtime.mjs` — boots Neos Vite dev server and verifies the browser entrypoint plus config endpoint are reachable.
- `docs/duel-web-neos-runtime.md` — local developer instructions for setting up and running the Neos spike.

**Modified files:**
- `.gitmodules` — records the `vendor/neos-ts` submodule.
- `package.json` — adds root convenience scripts for the Neos spike.

---

## Task 1: Add Neos Submodule And Static Vendor Check

**Files:**
- Create: `scripts/check-neos-vendor.mjs`
- Modify: `.gitmodules`
- Create external checkout: `vendor/neos-ts`

- [ ] **Step 1: Write the failing static check**

Create `scripts/check-neos-vendor.mjs`:

```js
// scripts/check-neos-vendor.mjs
import { existsSync, readFileSync } from "node:fs";

function fail(message) {
  console.error(`Neos vendor check failed: ${message}`);
  process.exit(1);
}

function readJson(url) {
  try {
    return JSON.parse(readFileSync(url, "utf8"));
  } catch (error) {
    fail(`could not read JSON at ${url.pathname}: ${error.message}`);
  }
}

const neosPackageUrl = new URL("../vendor/neos-ts/package.json", import.meta.url);
const neosProtobufUrl = new URL("../vendor/neos-ts/neos-protobuf", import.meta.url);
const gitmodulesUrl = new URL("../.gitmodules", import.meta.url);

if (!existsSync(neosPackageUrl)) {
  fail("vendor/neos-ts/package.json is missing; run git submodule update --init --recursive vendor/neos-ts");
}

if (!existsSync(neosProtobufUrl)) {
  fail("vendor/neos-ts/neos-protobuf is missing; initialize nested submodules with --recursive");
}

if (!existsSync(gitmodulesUrl)) {
  fail(".gitmodules is missing; add vendor/neos-ts as a git submodule");
}

const gitmodules = readFileSync(gitmodulesUrl, "utf8");
if (!gitmodules.includes("vendor/neos-ts") || !gitmodules.includes("https://github.com/DarkNeos/neos-ts.git")) {
  fail(".gitmodules does not point vendor/neos-ts at https://github.com/DarkNeos/neos-ts.git");
}

const neosPackage = readJson(neosPackageUrl);
if (neosPackage.name !== "neos-ts") {
  fail(`expected Neos package name to be neos-ts, got ${neosPackage.name}`);
}

for (const scriptName of ["dev", "build"]) {
  if (!neosPackage.scripts?.[scriptName]) {
    fail(`vendor/neos-ts/package.json is missing the ${scriptName} script`);
  }
}

for (const dependencyName of ["react", "react-dom", "antd", "@vitejs/plugin-react"]) {
  if (!neosPackage.dependencies?.[dependencyName] && !neosPackage.devDependencies?.[dependencyName]) {
    fail(`vendor/neos-ts/package.json is missing ${dependencyName}`);
  }
}

console.log(`Neos vendor checkout ready: ${neosPackage.name}@${neosPackage.version}`);
```

- [ ] **Step 2: Run the check to verify it fails before the submodule exists**

Run: `node scripts/check-neos-vendor.mjs`

Expected: FAIL with `vendor/neos-ts/package.json is missing`.

- [ ] **Step 3: Add Neos as a recursive submodule**

Run:

```bash
git submodule add https://github.com/DarkNeos/neos-ts.git vendor/neos-ts
git submodule update --init --recursive vendor/neos-ts
```

Expected: `.gitmodules` is created or updated with `vendor/neos-ts`, and `vendor/neos-ts/package.json` exists.

- [ ] **Step 4: Run the static check to verify the checkout**

Run: `node scripts/check-neos-vendor.mjs`

Expected: PASS and prints `Neos vendor checkout ready: neos-ts@0.1.0`.

- [ ] **Step 5: Commit**

```bash
git add .gitmodules vendor/neos-ts scripts/check-neos-vendor.mjs
git commit -m "chore: add Neos vendor runtime check"
```

---

## Task 2: Add Duel Web Wrapper Workspace And Root Scripts

**Files:**
- Create: `packages/duel-web/package.json`
- Modify: `package.json`

- [ ] **Step 1: Write the failing script assertion**

Run:

```bash
node -e "const p=require('./package.json'); if (!p.scripts['dev:duel-web']) throw new Error('missing dev:duel-web script')"
```

Expected: FAIL with `missing dev:duel-web script`.

- [ ] **Step 2: Create `packages/duel-web/package.json`**

```json
{
  "name": "@yugioh-discord-bot/duel-web",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "check:vendor": "node ../../scripts/check-neos-vendor.mjs",
    "setup": "npm --prefix ../../vendor/neos-ts install",
    "dev": "npm --prefix ../../vendor/neos-ts run dev --",
    "build:neos": "npm --prefix ../../vendor/neos-ts run build",
    "smoke": "node ../../scripts/smoke-neos-runtime.mjs"
  }
}
```

This package intentionally does not define `build`, `test`, or `typecheck` scripts yet. That keeps root `turbo run build`, `turbo run test`, and `turbo run typecheck` from depending on Neos while the spike is being validated.

- [ ] **Step 3: Add root convenience scripts**

Modify the root `package.json` scripts block to include these entries:

```json
{
  "dev:duel-web": "npm run dev --workspace=@yugioh-discord-bot/duel-web",
  "setup:duel-web": "npm run setup --workspace=@yugioh-discord-bot/duel-web",
  "build:duel-web": "npm run build:neos --workspace=@yugioh-discord-bot/duel-web",
  "smoke:duel-web": "npm run smoke --workspace=@yugioh-discord-bot/duel-web",
  "check:duel-vendor": "npm run check:vendor --workspace=@yugioh-discord-bot/duel-web"
}
```

Preserve the existing scripts and add these after `dev:web` with trailing commas adjusted for valid JSON.

- [ ] **Step 4: Verify the root scripts exist**

Run:

```bash
node -e "const p=require('./package.json'); for (const name of ['dev:duel-web','setup:duel-web','build:duel-web','smoke:duel-web','check:duel-vendor']) { if (!p.scripts[name]) throw new Error('missing '+name); }"
```

Expected: PASS with no output.

- [ ] **Step 5: Verify the wrapper can call the vendor check**

Run: `npm run check:duel-vendor`

Expected: PASS and prints `Neos vendor checkout ready: neos-ts@0.1.0`.

- [ ] **Step 6: Commit**

```bash
git add package.json packages/duel-web/package.json
git commit -m "chore: add duel web workspace wrapper"
```

---

## Task 3: Add Neos Runtime Smoke Test

**Files:**
- Create: `scripts/smoke-neos-runtime.mjs`

- [ ] **Step 1: Run the missing smoke script to verify the failure**

Run: `npm run smoke:duel-web`

Expected: FAIL with `Cannot find module` for `scripts/smoke-neos-runtime.mjs`.

- [ ] **Step 2: Create the smoke script**

```js
// scripts/smoke-neos-runtime.mjs
import { spawn } from "node:child_process";

const host = "127.0.0.1";
const port = Number(process.env.NEOS_SMOKE_PORT ?? "5174");
const baseUrl = `http://${host}:${port}`;
const timeoutMs = Number(process.env.NEOS_SMOKE_TIMEOUT_MS ?? "45000");

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchUntilReady(url, timeoutMs) {
  const startedAt = Date.now();
  let lastError = null;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return response;
      }
      lastError = new Error(`${url} returned HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await delay(500);
  }

  throw lastError ?? new Error(`${url} did not become ready within ${timeoutMs}ms`);
}

function stopServer(server) {
  if (server.exitCode !== null) {
    return;
  }
  server.kill("SIGTERM");
  setTimeout(() => {
    if (server.exitCode === null) {
      server.kill("SIGKILL");
    }
  }, 3000).unref();
}

const server = spawn(
  "npm",
  ["--prefix", "vendor/neos-ts", "run", "dev", "--", "--host", host, "--port", String(port)],
  {
    cwd: new URL("..", import.meta.url),
    env: { ...process.env, BROWSER: "none" },
    stdio: ["ignore", "pipe", "pipe"],
  },
);

let output = "";
server.stdout.on("data", (chunk) => {
  output += chunk.toString();
});
server.stderr.on("data", (chunk) => {
  output += chunk.toString();
});

try {
  const pageResponse = await fetchUntilReady(baseUrl, timeoutMs);
  const html = await pageResponse.text();
  if (!html.includes('id="root"')) {
    throw new Error("Neos root HTML did not include the React root element");
  }

  const configResponse = await fetchUntilReady(`${baseUrl}/neos.config.json`, timeoutMs);
  const config = await configResponse.json();
  if (!Array.isArray(config.servers) || config.servers.length === 0) {
    throw new Error("neos.config.json did not expose any duel servers");
  }

  console.log(`Neos runtime smoke passed at ${baseUrl} with ${config.servers.length} configured servers`);
} catch (error) {
  console.error(output.trim());
  console.error(`Neos runtime smoke failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  stopServer(server);
}
```

- [ ] **Step 3: Install Neos dependencies**

Run: `npm run setup:duel-web`

Expected: PASS and installs dependencies under `vendor/neos-ts/node_modules`.

- [ ] **Step 4: Run the smoke test**

Run: `npm run smoke:duel-web`

Expected: PASS and prints `Neos runtime smoke passed at http://127.0.0.1:5174`.

- [ ] **Step 5: Run the Neos production build through the wrapper**

Run: `npm run build:duel-web`

Expected: PASS and creates `vendor/neos-ts/dist`.

- [ ] **Step 6: Commit**

```bash
git add scripts/smoke-neos-runtime.mjs
git commit -m "test: add Neos runtime smoke check"
```

---

## Task 4: Document Neos Runtime Setup

**Files:**
- Create: `docs/duel-web-neos-runtime.md`

- [ ] **Step 1: Verify the docs page is missing**

Run: `test -f docs/duel-web-neos-runtime.md`

Expected: FAIL with exit code `1`.

- [ ] **Step 2: Create the runtime docs**

```md
# Neos Duel Web Runtime

This repo keeps the upstream Neos browser client isolated under `vendor/neos-ts` while the first integration spike proves local runtime viability.

## Setup

Initialize the Neos submodule and its nested protobuf submodule:

```bash
git submodule update --init --recursive vendor/neos-ts
```

Install Neos dependencies inside the vendor checkout:

```bash
npm run setup:duel-web
```

## Checks

Verify that the Neos checkout is present and initialized:

```bash
npm run check:duel-vendor
```

Start the Neos Vite dev server and verify the entrypoint plus config endpoint:

```bash
npm run smoke:duel-web
```

Build the Neos app:

```bash
npm run build:duel-web
```

## Development

Run Neos locally through the wrapper workspace:

```bash
npm run dev:duel-web -- --host 0.0.0.0 --port 5173
```

The first spike does not mount Neos inside `packages/web`. Keep Neos isolated until the bridge/result contract work is planned and tested.

## Notes

- `packages/duel-web` intentionally has no `build`, `test`, or `typecheck` script yet, so root Turbo commands are not affected by the Neos spike.
- Neos uses React 18 and Vite; the existing dashboard uses React 19 and Next.js 16. Treat the Neos client as a separate web runtime until a later embedding plan decides otherwise.
- Neos is GPL-3.0. Preserve license notices and keep Neos-derived code easy to audit.
```

- [ ] **Step 3: Verify the docs file exists**

Run: `test -f docs/duel-web-neos-runtime.md`

Expected: PASS with exit code `0`.

- [ ] **Step 4: Commit**

```bash
git add docs/duel-web-neos-runtime.md
git commit -m "docs: document Neos runtime spike"
```

---

## Task 5: Final Verification And PR Update

**Files:**
- No new files.

- [ ] **Step 1: Verify the final diff scope**

Run: `git status --short`

Expected: only intended Neos spike files are modified or untracked before final staging.

- [ ] **Step 2: Run the complete spike verification**

Run:

```bash
npm run check:duel-vendor
npm run setup:duel-web
npm run smoke:duel-web
npm run build:duel-web
```

Expected: all commands exit `0`.

- [ ] **Step 3: Verify existing root test/build commands are not accidentally coupled to Neos**

Run:

```bash
npm test -- --dry=json
```

Expected: if npm rejects `--dry=json`, do not treat that as product failure; instead run `npm test` only if the current branch is known to have a clean baseline. The key requirement is that `packages/duel-web/package.json` still has no `test`, `build`, or `typecheck` script after Task 2.

Then run:

```bash
node -e "const p=require('./packages/duel-web/package.json'); for (const name of ['test','build','typecheck']) { if (p.scripts && p.scripts[name]) throw new Error('duel-web must not define '+name+' during the spike'); }"
```

Expected: PASS with no output.

- [ ] **Step 4: Commit any remaining tracked changes**

If Task 5 produced no file changes, skip this step. If it updated docs or scripts based on verification output, commit those changes:

```bash
git add package.json packages/duel-web/package.json scripts/check-neos-vendor.mjs scripts/smoke-neos-runtime.mjs docs/duel-web-neos-runtime.md .gitmodules vendor/neos-ts
git commit -m "chore: verify Neos runtime spike"
```

- [ ] **Step 5: Push the branch and update the PR**

Run: `git push`

Expected: branch pushes successfully and the PR contains only the Neos design/spec/plan/spike changes.

---

## Implementation Notes

- Use a clean worktree based on latest `origin/main` for implementation.
- Do not copy Neos source files into `packages/web` during this spike.
- Do not add Neos as a root dependency during this spike.
- Do not change Docker Compose until local Vite runtime and build are proven.
- If `vendor/neos-ts/neos-protobuf` fails to initialize from the upstream GitLab URL, stop and record the exact submodule failure. The fallback plan should be a separate decision, not an unreviewed workaround.
