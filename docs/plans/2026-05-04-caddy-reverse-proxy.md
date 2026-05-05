# Caddy Reverse Proxy Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Enable Caddy as the default production reverse proxy, routing port 80 to both the Next.js web app and Socket.IO server, fixing the currently broken WebSocket in production.

**Architecture:** Caddy runs as a Docker Compose service on port 80, proxying `/socket.io/*` to `ws:3001` and all other traffic to `web:3000`. The web service drops its direct port mapping so Caddy is the only ingress. Dev override restores direct port access so local development is unaffected.

**Tech Stack:** Caddy 2 Alpine, Docker Compose, Socket.IO

---

### Task 1: Create Caddyfile

**Files:**
- Create: `Caddyfile` (repo root)

**Step 1: Create the file**

```
:80 {
    handle /socket.io/* {
        reverse_proxy ws:3001
    }
    reverse_proxy web:3000
}
```

The `handle` block for `/socket.io/*` must come first. Caddy matches `handle` blocks in order and the trailing wildcard ensures all Socket.IO paths (including `/socket.io/`) are captured. WebSocket upgrade headers are forwarded automatically by Caddy's `reverse_proxy`.

**Step 2: Verify file is at repo root**

```bash
ls Caddyfile
```
Expected: `Caddyfile`

---

### Task 2: Update docker-compose.yml

**Files:**
- Modify: `docker-compose.yml`

**Step 1: Enable the caddy service**

Replace the commented-out `caddy` block and `volumes` section with:

```yaml
  caddy:
    image: caddy:2-alpine
    restart: unless-stopped
    ports:
      - "80:80"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy_data:/data
      - caddy_config:/config
    depends_on:
      - web
      - ws

volumes:
  caddy_data:
  caddy_config:
```

**Step 2: Remove ports from web service**

The `web` service currently has:
```yaml
    ports:
      - "3000:3000"
```
Remove those two lines. Caddy is now the only ingress for the web container.

**Step 3: Verify compose file is valid**

```bash
docker compose config --quiet
```
Expected: no output (silent = valid)

---

### Task 3: Update docker-compose.override.yml for dev

**Files:**
- Modify: `docker-compose.override.yml`

**Step 1: Add port mappings to web and ws services**

The override file already has a `web` service block. Add `ports` to it and add a new `ws` entry:

```yaml
  web:
    build:
      target: web-dev
    ports:
      - "3000:3000"
    environment:
      # ...existing env vars...
```

And add a ws block:
```yaml
  ws:
    ports:
      - "3001:3001"
```

This restores direct dev access to Next.js on `:3000` and Socket.IO on `:3001` without needing Caddy running locally.

**Step 2: Verify override is valid**

```bash
docker compose config --quiet
```
Expected: no output

---

### Task 4: Update .env.example

**Files:**
- Modify: `.env.example`

**Step 1: Update the comments for web-related vars**

Change:
```
# Local: http://localhost:3000 | Production: https://your-domain.com
NEXTAUTH_URL=
```
To:
```
# Local: http://localhost:3000 | Production: http://YOUR_GCE_EXTERNAL_IP
NEXTAUTH_URL=
```

Change:
```
NEXT_PUBLIC_WS_URL=http://localhost:3001
```
To:
```
# Local: http://localhost:3001 | Production: http://YOUR_GCE_EXTERNAL_IP (Caddy routes /socket.io/*)
NEXT_PUBLIC_WS_URL=http://localhost:3001
```

---

### Task 5: Update gce-runbook.md

**Files:**
- Modify: `docs/deployment/gce-runbook.md`

**Step 1: Update the env file section**

In the "Create The VM Environment File" section, update the example values:

```
NEXTAUTH_URL=http://YOUR_GCE_EXTERNAL_IP
NEXT_PUBLIC_WS_URL=http://YOUR_GCE_EXTERNAL_IP
```

Remove the port suffix from both. Add a note explaining Caddy routes `/socket.io/*` to the ws container so `NEXT_PUBLIC_WS_URL` needs no port.

**Step 2: Update the Discord redirect URI**

Change:
```
http://YOUR_GCE_EXTERNAL_IP:3000/api/auth/callback/discord
```
To:
```
http://YOUR_GCE_EXTERNAL_IP/api/auth/callback/discord
```

**Step 3: Update the firewall section**

Add a note that port 80 must be open on GCE. Port 3000 and 3001 no longer need to be exposed. Add the command:

```bash
gcloud compute firewall-rules create allow-http --allow tcp:80 --direction=INGRESS
```

**Step 4: Update the "Adding HTTPS with Caddy (Optional)" section**

Since Caddy is now the default, replace that section with:

```markdown
## Adding HTTPS with a Domain

Caddy is already running. To add a domain:

1. Point your domain's A record to the GCE external IP.
2. Edit `Caddyfile` — replace `:80` with `yourdomain.com`:
   ```
   yourdomain.com {
       handle /socket.io/* {
           reverse_proxy ws:3001
       }
       reverse_proxy web:3000
   }
   ```
3. Update `.env` on the VM:
   ```
   NEXTAUTH_URL=https://yourdomain.com
   NEXT_PUBLIC_WS_URL=https://yourdomain.com
   ```
4. Update Discord redirect URI to `https://yourdomain.com/api/auth/callback/discord`.
5. Open port 443 on GCE firewall:
   ```bash
   gcloud compute firewall-rules create allow-https --allow tcp:443 --direction=INGRESS
   ```
6. `docker compose up -d --build` — Caddy provisions HTTPS automatically via Let's Encrypt.
```

**Step 5: Update the VM Setup Status Checklist**

Add two new checklist items:
```markdown
- [ ] `Caddyfile` present at `/opt/yugioh-discord-bot/Caddyfile` (deployed via git)
- [ ] Port 80 open on GCE firewall
```

---

### Task 6: Commit all changes

**Step 1: Stage and commit**

```bash
git add Caddyfile docker-compose.yml docker-compose.override.yml .env.example docs/deployment/gce-runbook.md docs/plans/2026-05-04-caddy-reverse-proxy-design.md docs/plans/2026-05-04-caddy-reverse-proxy.md
git commit -m "feat: enable Caddy as default reverse proxy for production"
```

**Step 2: Verify clean working tree**

```bash
git status
```
Expected: `nothing to commit, working tree clean`

---

## Post-Merge Steps (Manual — on GCE VM)

These are NOT code tasks. Do them after the PR is merged and GitHub Actions deploys.

1. **Update `.env` on the VM:**
   ```
   NEXTAUTH_URL=http://YOUR_EXTERNAL_IP
   NEXT_PUBLIC_WS_URL=http://YOUR_EXTERNAL_IP
   ```

2. **Update Discord OAuth2 redirect URI** in the Developer Portal:
   ```
   http://YOUR_EXTERNAL_IP/api/auth/callback/discord
   ```

3. **Open port 80 on GCE firewall** (if not already open):
   ```bash
   gcloud compute firewall-rules create allow-http --allow tcp:80 --direction=INGRESS
   ```

4. **Run on VM:**
   ```bash
   cd /opt/yugioh-discord-bot
   docker compose up -d --build
   docker compose ps
   ```
   Expected: `caddy`, `web`, `ws`, `bot` all show `Up`.

5. **Smoke test:**
   - Open `http://YOUR_EXTERNAL_IP` in a browser — web app should load
   - Navigate to a draft room and confirm the WebSocket connects (no connection error in browser console)
   - Discord bot commands still respond
