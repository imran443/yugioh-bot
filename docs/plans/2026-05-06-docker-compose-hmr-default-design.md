# Docker Compose HMR Default Design

**Goal:** Make local Docker development use Next.js HMR by default with plain `docker compose up`, without disturbing production behavior.

**Problem:** The repo currently ships `docker-compose.dev.yml`, but Docker Compose only auto-merges `docker-compose.override.yml`. That means local developers who run plain `docker compose up` without first copying the dev file silently get the production `web` target instead of `web-dev`. The result is a workflow that often requires rebuilds for normal frontend changes.

**Root Cause:** The local dev HMR setup exists, but it is not on the default Docker Compose code path. The setup depends on a manual copy step that is easy to miss and easy to drift from the documented behavior.

## Approved Approach

Use a tracked `docker-compose.override.yml` for local development defaults, and keep `docker-compose.yml` as the production-safe base file.

### Local Development

Plain `docker compose up -d --build` should:
- auto-merge `docker-compose.override.yml`
- build the `web` service from the `web-dev` target
- bind-mount the web source directories needed for HMR
- expose `3000` and `3001` for direct local access
- enable polling-based file watching for Docker-hosted development

This removes the manual copy step and makes the default local command match the expected developer experience.

### Production Safety

Production must continue using only `docker-compose.yml`.

To guarantee that, all production documentation and operational commands should use explicit base-file invocation:

```bash
docker compose -f docker-compose.yml up -d --build
```

Using `-f docker-compose.yml` prevents Docker Compose from implicitly loading `docker-compose.override.yml`, so the production stack remains unchanged.

The GitHub deployment workflow already does this, so no workflow change is required.

## File Changes

### Add

- `docker-compose.override.yml`

This file should become the single tracked source of truth for local Docker dev overrides. Its content should match the current intended dev setup:
- `web.build.target: web-dev`
- `web` port mapping on `3000`
- `ws` port mapping on `3001`
- polling env vars for file watching
- bind mounts for `packages/web/app`, `packages/web/src`, and shared package source/dist
- anonymous volume for `/app/packages/web/.next`

### Retire or Simplify

- `docker-compose.dev.yml`

This file should no longer be the active source of truth. The safest options are:
- remove it entirely, or
- leave a short comment-only placeholder pointing developers to `docker-compose.override.yml`

Prefer removing it to avoid split-brain configuration.

### Update Docs

- `README.md`
- deployment/runbook docs that currently say production should use plain `docker compose up -d --build`

Docs should clearly distinguish:

**Local dev:**
```bash
docker compose up -d --build
```

**Production:**
```bash
docker compose -f docker-compose.yml up -d --build
```

## Scope Boundaries

This change is only meant to fix the default Docker dev path and make HMR reliable for the files already intended to be hot-reloaded.

It should not:
- change production service definitions in `docker-compose.yml`
- change the GitHub deploy workflow
- broaden hot reload to every config file in the repo

Config files like `next.config.ts`, `postcss.config.mjs`, and `tsconfig.json` can remain rebuild-required unless there is a specific reason to hot-reload them.

## Verification

### Local Dev Verification

1. Run:
   ```bash
   docker compose config --quiet
   ```
   Expected: no output.

2. Run:
   ```bash
   docker compose up -d --build
   ```

3. Edit a file under `packages/web/app` or `packages/web/src`.
   Expected: the running web container picks up the change without rebuilding the image.

4. Edit shared package code and rebuild only the shared workspace if needed.
   Expected: shared changes become visible without rebuilding the full container image.

### Production Safety Verification

1. Run:
   ```bash
   docker compose -f docker-compose.yml config --quiet
   ```
   Expected: no output.

2. Confirm the explicit base-file command resolves to the production targets only.

## Outcome

After this change:
- local developers get HMR with plain `docker compose up`
- production remains unchanged when run with explicit `-f docker-compose.yml`
- the repo no longer depends on a hidden manual copy step for Docker dev correctness
