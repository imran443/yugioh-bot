# YuGiOh Draft Bot

A Discord bot + web dashboard for tracking YuGiOh matches, running drafts, managing tournaments, and viewing stats.

## Features

### Discord Bot
- `/duel` reports a casual 1v1 match
- `/approve` / `/deny` approves or rejects pending match reports
- `/stats` shows lifetime wins, losses, and win rate (optionally scoped to a tournament)
- `/rankings` shows the server leaderboard
- `/help` shows available bot commands
- `/event dashboard` opens a private tournament dashboard with buttons for open events, signup, match reporting, approvals, stats, creator tools, and help
- `/event` creates, joins, starts, shows, reports, and cancels tournaments with direct creator-seeded participants
- Tournament name autocomplete helps pick existing events in supported options
- Daily reminders ping a configured channel for unplayed tournament matches

### Web Dashboard
- Discord OAuth login (NextAuth.js v5)
- View active, pending, completed, and cancelled drafts
- Create new drafts with set picker and config options
- Create new tournaments with format selection
- Draft detail pages: manage pending drafts (start, cancel, edit), participate in active drafts, view completed draft summaries and export YDK
- Tournament detail pages: view participants, matches, standings; start/cancel tournaments (creator only); report match results
- Guild announcement settings toggles
- Real-time draft updates via Socket.IO

## Local Setup

```bash
npm install
cp .env.example .env
npm run commands:deploy
npm run dev
```

SQLite data is stored in `./data/bot.sqlite` by default.

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `DISCORD_TOKEN` | Yes | Discord bot token |
| `DISCORD_CLIENT_ID` | Yes | Discord application client ID (shared between bot and web OAuth) |
| `DISCORD_CLIENT_SECRET` | Yes | Discord OAuth2 client secret (for web auth) |
| `DISCORD_GUILD_ID` | Yes | Discord server ID for guild-scoped commands |
| `DISCORD_REMINDER_CHANNEL_ID` | No | Channel for daily tournament reminders |
| `DISCORD_DEFAULT_CHANNEL_ID` | No | Default channel for web-created drafts/tournaments |
| `NEXTAUTH_SECRET` | Yes (web) | Generate with `openssl rand -base64 32` |
| `NEXTAUTH_URL` | Yes (web) | `http://localhost:3000` for local, `http://<VM_IP>` or `https://yourdomain.com` for production |
| `NEXT_PUBLIC_WS_URL` | Yes (web) | WebSocket URL: `http://localhost:3001` local, `http://<VM_IP>` or `wss://yourdomain.com` for production |
| `DATABASE_PATH` | No | SQLite file path. Defaults to `./data/bot.sqlite` |
| `REMINDER_CRON` | No | Cron schedule for daily reminders. Defaults to `0 10 * * *` |
| `REMINDER_TIMEZONE` | No | Timezone for reminders. Defaults to `America/New_York` |

## Docker

### Development (with hot reload)

```bash
docker compose up -d --build
```

The `docker-compose.override.yml` is auto-merged for local dev. It switches the web service to a dev target with HMR and bind-mounts source directories.

### Production

```bash
docker compose up -d --build
```

Without the override file, Docker Compose uses the production targets from `docker-compose.yml` which build optimized images for each service.

The stack runs 4 services:
- **bot** — Discord bot (deploys commands on startup)
- **ws** — Socket.IO WebSocket server for real-time draft updates
- **web** — Next.js 16 dashboard
- **caddy** — Reverse proxy (HTTP on port 80, auto-HTTPS with a domain)

## Deployment

### VM Deployment (Hetzner / Any VPS)

The app runs on a VM via Docker Compose with Caddy as a reverse proxy. GitHub Actions deploys on every push to `main`.

**Quick setup:**
1. Create a VM (e.g., Hetzner CAX11, 4GB RAM, Ubuntu 24.04)
2. Install Docker and Git on the VM
3. Clone the repo to `/opt/yugioh-bot`
4. Create `.env` on the VM (see Environment Variables above)
5. Set Discord OAuth redirect URI: `http://<YOUR_IP>/api/auth/callback/discord`
6. Run `docker compose up -d --build`
7. Add GitHub Actions secrets (`VM_HOST`, `VM_USER`, `VM_SSH_PRIVATE_KEY`, `VM_PORT`)

See `docs/deployment/vm-runbook.md` for the full step-by-step guide.

### Adding a Custom Domain (Optional)

For HTTPS with a custom domain:

1. Point your domain's A record to the VM IP
2. Edit `Caddyfile` — replace `:80` with `yourdomain.com`
3. Add `"443:443"` to the caddy ports in `docker-compose.yml`
4. Update `.env`: `NEXTAUTH_URL=https://yourdomain.com` and `NEXT_PUBLIC_WS_URL=https://yourdomain.com`
5. Update Discord redirect URI to `https://yourdomain.com/api/auth/callback/discord`
6. Open firewall port 443
7. `docker compose up -d` — Caddy auto-provisions HTTPS via Let's Encrypt

## Quality Checks

```bash
npm test
npm run typecheck
npm run build
```

## Backups

Run `./scripts/backup-sqlite.sh` to create a timestamped SQLite backup in `./backups`.

## Project Structure

```
packages/
  bot/        Discord bot (discord.js + better-sqlite3)
  web/        Next.js web dashboard (App Router, TailwindCSS v4)
  ws/         Socket.IO WebSocket server (draft real-time updates)
  shared/     Shared library (database schema, services, types)
```