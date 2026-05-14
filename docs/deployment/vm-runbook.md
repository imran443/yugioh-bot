# VM Deployment Runbook

This runbook covers deploying the YuGiOh bot + web app to a VM. The stack runs via Docker Compose with Caddy as a reverse proxy. GitHub Actions deploys `main` automatically on push.

## Current Repository State

- GitHub repo: `https://github.com/imran443/yugioh-bot`
- Production branch: `main`
- Deploy workflow: `.github/workflows/deploy.yml`
- VM provider: Hetzner Cloud
- VM public IP: `178.105.36.104`
- VM app path: `/opt/yugioh-bot`
- Runtime user: `root`
- Data path: `/opt/yugioh-bot/data/bot.sqlite`

## SSH Access

The deploy key lives at `~/.ssh/hetzner_deploy` on the maintainer's workstation.

```bash
ssh -i ~/.ssh/hetzner_deploy root@178.105.36.104
```

One-liners (run from your workstation, no interactive shell needed):

```bash
# Tail logs
ssh -i ~/.ssh/hetzner_deploy root@178.105.36.104 \
  'cd /opt/yugioh-bot && docker compose -f docker-compose.yml logs --tail=100'

# Inspect production .env
ssh -i ~/.ssh/hetzner_deploy root@178.105.36.104 \
  'grep -E "^(NEXTAUTH_URL|NEXT_PUBLIC_WS_URL|WEB_URL)=" /opt/yugioh-bot/.env'

# Restart a service
ssh -i ~/.ssh/hetzner_deploy root@178.105.36.104 \
  'cd /opt/yugioh-bot && docker compose -f docker-compose.yml restart bot'
```

Optional — add a `~/.ssh/config` entry so you can drop the `-i` flag:

```sshconfig
Host yugioh-bot
    HostName 178.105.36.104
    User root
    IdentityFile ~/.ssh/hetzner_deploy
```

Then `ssh yugioh-bot` works.

The deploy workflow requires these GitHub Actions secrets:

- `VM_HOST`
- `VM_USER`
- `VM_SSH_PRIVATE_KEY`
- `VM_PORT` (optional, defaults to 22)

## Deployment Pipeline

1. Code is pushed to `main` on GitHub.
2. GitHub Actions starts the `Deploy` workflow.
3. The workflow SSHes into the VM.
4. The VM resets `/opt/yugioh-bot` to `origin/main`.
5. Docker Compose rebuilds and restarts all services.
6. Caddy reverse-proxies HTTP on port 80.

Remote deploy command used by the workflow:

```bash
cd /opt/yugioh-bot && \
git fetch --all --prune && \
git reset --hard origin/main && \
docker compose -f docker-compose.yml build && \
docker compose -f docker-compose.yml down --remove-orphans && \
docker compose -f docker-compose.yml up -d && \
docker compose -f docker-compose.yml ps && \
docker compose -f docker-compose.yml logs --tail=40
```

## VM Setup (Hetzner CAX11 or similar)

### Create the Server

1. Go to [hetzner.com/cloud](https://www.hetzner.com/cloud)
2. Create a new project → Add server
3. Location: any
4. Image: Ubuntu 24.04
5. Type: CAX11 (ARM64, 4GB RAM, €3.79/mo)
6. Add your SSH public key
7. Firewall: allow TCP 22, 80, 443
8. Name: `yugioh-bot`
9. Create & Buy

Note the IPv4 address after creation.

### Initial Server Setup

```bash
ssh -i ~/.ssh/hetzner_deploy root@YOUR_VM_IP

apt update && apt upgrade -y
apt install -y docker.io docker-compose-plugin git
```

### Clone the Repo

```bash
mkdir -p /opt && cd /opt
git clone https://github.com/imran443/yugioh-bot.git
cd yugioh-bot
```

### Create `.env`

```bash
cp .env.example .env
nano .env
```

Fill in:

```bash
DISCORD_TOKEN=your_bot_token
DISCORD_CLIENT_ID=your_discord_app_id
DISCORD_CLIENT_SECRET=your_discord_app_secret
DISCORD_GUILD_ID=your_guild_id
DISCORD_REMINDER_CHANNEL_ID=your_channel_id
DISCORD_DEFAULT_CHANNEL_ID=your_default_channel_id

NEXTAUTH_SECRET=  # generate with: openssl rand -base64 32
NEXTAUTH_URL=http://YOUR_VM_IP
NEXT_PUBLIC_WS_URL=http://YOUR_VM_IP

DATABASE_PATH=./data/bot.sqlite
REMINDER_CRON=0 10 * * *
REMINDER_TIMEZONE=America/New_York
```

### Build & Run

```bash
docker compose -f docker-compose.yml up -d --build
```

First build takes 3-5 minutes.

### Verify

```bash
docker compose -f docker-compose.yml ps
docker compose -f docker-compose.yml logs -f
```

Open `http://YOUR_VM_IP` in a browser.

### Discord OAuth Redirect

In the [Discord Developer Portal](https://discord.com/developers/applications) → OAuth2 → Redirects, add:

```
http://YOUR_VM_IP/api/auth/callback/discord
```

## GitHub Actions Secrets

Go to your GitHub repo → Settings → Secrets and variables → Actions, and add:

| Secret | Value |
|--------|-------|
| `VM_HOST` | Your VM's public IP |
| `VM_USER` | `root` |
| `VM_SSH_PRIVATE_KEY` | Full contents of your SSH private key |
| `VM_PORT` | `22` |

After these are set, every push to `main` will auto-deploy.

## Auto Deploy From Main

`.github/workflows/deploy.yml` triggers on every push to `main` and on `workflow_dispatch`.

Normal flow:

1. Work on a branch.
2. Open a pull request.
3. Merge into `main`.
4. GitHub Actions deploys automatically.

## Manual Operations

Run from `/opt/yugioh-bot` on the VM.

```bash
# View status
docker compose -f docker-compose.yml ps

# View logs
docker compose -f docker-compose.yml logs --tail=200

# Follow logs
docker compose -f docker-compose.yml logs -f

# Restart a service
docker compose -f docker-compose.yml restart bot

# Manual update
git fetch --all --prune && git reset --hard origin/main
docker compose -f docker-compose.yml up -d --build

# Stop all
docker compose -f docker-compose.yml down
```

## Adding HTTPS with a Domain

1. Point your domain's A record to the VM IP.
2. Edit `Caddyfile` — replace `:80` with `yourdomain.com`.
3. Update `.env` on the VM:
   ```
   NEXTAUTH_URL=https://yourdomain.com
   NEXT_PUBLIC_WS_URL=https://yourdomain.com
   ```
4. Update Discord redirect URI to `https://yourdomain.com/api/auth/callback/discord`.
5. Open port 443 in the firewall:
   ```bash
   ufw allow 443/tcp
   ```
6. Restart: `docker compose -f docker-compose.yml up -d` — Caddy provisions HTTPS via Let's Encrypt automatically.

## VM Setup Checklist

- [ ] VM created (Hetzner CAX11 or similar, 4GB+ RAM)
- [ ] SSH key added
- [ ] Firewall allows TCP 22, 80, 443
- [ ] Docker and Docker Compose installed
- [ ] Repo cloned to `/opt/yugioh-bot`
- [ ] `.env` created with all values
- [ ] First `docker compose -f docker-compose.yml up -d --build` succeeds
- [ ] `http://YOUR_VM_IP` loads in browser
- [ ] Discord OAuth redirect added
- [ ] GitHub Actions secrets configured
- [ ] Push to `main` triggers successful auto-deploy
