# Docker Compose HMR Default Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make local Docker development use HMR by default with plain `docker compose up`, while keeping production behavior unchanged.

**Architecture:** Promote the existing dev override into a tracked `docker-compose.override.yml` so local Compose automatically loads the HMR configuration. Keep `docker-compose.yml` unchanged for production, and update docs/runbooks so production always uses `docker compose -f docker-compose.yml ...` explicitly.

**Tech Stack:** Docker Compose, Next.js 16, Node.js, Markdown docs

---

### Task 1: Promote the dev override to the default local override

**Files:**
- Create: `docker-compose.override.yml`
- Delete: `docker-compose.dev.yml`
- Reference: `docker-compose.yml`

**Step 1: Copy the dev override into the tracked override file**

Create `docker-compose.override.yml` with the same functional content currently in `docker-compose.dev.yml`:
- `web.build.target: web-dev`
- `web.ports: ["3000:3000"]`
- polling env vars
- bind mounts for `packages/web/app`, `packages/web/src`, `packages/shared/src`, `packages/shared/dist`
- anonymous volume for `/app/packages/web/.next`
- `ws.ports: ["3001:3001"]`

**Step 2: Remove the old alternate dev file**

Delete `docker-compose.dev.yml` so there is only one source of truth for local dev overrides.

**Step 3: Validate merged local config**

Run:
```bash
docker compose config --quiet
```

Expected: no output.

**Step 4: Validate explicit production config**

Run:
```bash
docker compose -f docker-compose.yml config --quiet
```

Expected: no output.

---

### Task 2: Update local and production docs

**Files:**
- Modify: `README.md`
- Modify: `docs/deployment/operations-checklist.md`
- Modify: `docs/deployment/free-cheap-hosting.md`
- Modify: `docs/deployment/vm-runbook.md`

**Step 1: Update README local dev guidance**

In `README.md`:
- keep local dev as plain `docker compose up -d --build`
- remove language about manually creating or relying on an untracked override
- explain that tracked `docker-compose.override.yml` is used automatically for local HMR

**Step 2: Update README production guidance**

In `README.md` production section, change plain compose commands to explicit base-file commands:

```bash
docker compose -f docker-compose.yml up -d --build
```

Add one short note explaining that production uses the base file explicitly so local dev overrides are not loaded.

**Step 3: Update deployment docs**

In the deployment docs listed above, replace human-run production commands such as:

```bash
docker compose up -d --build
```

with:

```bash
docker compose -f docker-compose.yml up -d --build
```

Also update any `docker compose up -d`, `docker compose build`, `docker compose ps`, or `docker compose logs ...` production snippets to use the same explicit file form where appropriate.

**Step 4: Re-scan for remaining production doc references**

Run:
```bash
rg "docker compose up -d|docker compose build|docker compose ps|docker compose logs" README.md docs/deployment
```

Expected: remaining plain commands should only be intentional local-dev usage, not production guidance.

---

### Task 3: Verify HMR behavior end-to-end

**Files:**
- No code changes expected

**Step 1: Start the local Docker dev stack**

Run:
```bash
docker compose up -d --build
```

Expected: `web` uses the `web-dev` target and becomes available on `http://localhost:3000`.

**Step 2: Confirm source mounts are live**

Make a minimal temporary edit to a file under `packages/web/src` or `packages/web/app`.

Expected: the running site updates without rebuilding the image.

**Step 3: Check shared package behavior**

If shared code is part of the active page path, rebuild only the shared package:

```bash
docker compose exec web npm run build --workspace=@yugidraft/shared
```

Expected: shared changes become visible without rebuilding the whole stack.

**Step 4: Confirm production resolution remains base-only**

Run:
```bash
docker compose -f docker-compose.yml config
```

Expected: output resolves from the base file only, without the local dev override fields.

---

### Task 4: Commit

```bash
git add docker-compose.override.yml docker-compose.dev.yml README.md docs/deployment/operations-checklist.md docs/deployment/free-cheap-hosting.md docs/deployment/vm-runbook.md docs/plans/2026-05-06-docker-compose-hmr-default-design.md docs/plans/2026-05-06-docker-compose-hmr-default-implementation.md
git commit -m "make docker compose dev use HMR by default"
```
