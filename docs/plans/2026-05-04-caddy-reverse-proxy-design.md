# Design: Caddy Reverse Proxy for Production

**Date:** 2026-05-04  
**Status:** Approved

## Problem

Two issues exist with the current production setup:

1. The `ws` service (Socket.IO, port 3001) has no `ports` mapping in `docker-compose.yml`, so browsers cannot reach it. Draft room real-time features are broken in production.
2. The web app is exposed on `:3000`, meaning the production URL is `http://IP:3000` — non-standard and not upgradeable to HTTPS without adding a reverse proxy anyway.

## Decision

Add Caddy as a reverse proxy in `docker-compose.yml`. Caddy listens on port 80 and routes all traffic through a single entry point:

- `/socket.io/*` → `ws:3001`
- `/*` → `web:3000`

No domain is required. No TLS is configured. Adding a domain later requires changing one line in the Caddyfile.

## Architecture

```
Browser
  │
  ▼ port 80 (HTTP)
Caddy (caddy:2-alpine)
  ├── /socket.io/* ──► ws:3001 (Socket.IO + WebSocket upgrades)
  └── /*           ──► web:3000 (Next.js)

Bot ──► SQLite on ./data (unchanged)
```

## File Changes

### New: `Caddyfile` (repo root)

```
:80 {
    handle /socket.io/* {
        reverse_proxy ws:3001
    }
    reverse_proxy web:3000
}
```

Committed to git. To add a domain later, replace `:80` with `yourdomain.com`.

### `docker-compose.yml`

- Enable the `caddy` service (currently commented out)
- Mount `./Caddyfile:/etc/caddy/Caddyfile:ro`
- Uncomment `caddy_data` and `caddy_config` named volumes
- Remove `ports: "3000:3000"` from `web` — Caddy is the only ingress
- `ws` service needs no port mapping — Caddy reaches it on the internal network

### `docker-compose.override.yml` (dev only)

- Add `ports: ["3000:3000", "3001:3001"]` to `web` and `ws` so local dev still works without Caddy

### `.env.example`

- `NEXTAUTH_URL`: comment updated to `http://YOUR_GCE_EXTERNAL_IP` (no `:3000`)
- `NEXT_PUBLIC_WS_URL`: comment updated to `http://YOUR_GCE_EXTERNAL_IP` (no port, Caddy routes `/socket.io/*`)

### `docs/deployment/gce-runbook.md`

- Update env var examples to reflect new URL format (no port suffix)
- Note port 80 firewall rule required instead of 3000/3001
- Collapse the optional Caddy section — Caddy is now the default

## Post-Deploy Steps (Manual, on GCE VM)

After merging and the GitHub Actions deploy completes:

1. Update `.env` on the VM:
   - `NEXTAUTH_URL=http://YOUR_EXTERNAL_IP` (remove `:3000`)
   - `NEXT_PUBLIC_WS_URL=http://YOUR_EXTERNAL_IP` (remove `:3001`)
2. Update Discord OAuth2 redirect URI in the Developer Portal:
   - `http://YOUR_EXTERNAL_IP/api/auth/callback/discord` (remove `:3000`)
3. Open port 80 on GCE firewall if not already open:
   ```bash
   gcloud compute firewall-rules create allow-http --allow tcp:80 --direction=INGRESS
   ```
4. Run `docker compose up -d --build` on the VM to pick up the new config.

## What Does Not Change

- Bot service — untouched
- All application code, auth logic, database — untouched
- Local dev — direct `:3000` / `:3001` access still works via the override file
