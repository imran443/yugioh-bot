# Yugioh Discord Bot

A Discord bot for tracking Yugioh matches and tournaments, with a web dashboard for creating drafts, managing tournaments, and viewing stats.

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
- View active, pending, completed, and cancelled drafts
- Create new drafts with set picker and config options
- Create new tournaments with format selection
- Draft detail pages: manage pending drafts (start, cancel, edit), participate in active drafts, view completed draft summaries and export YDK
- Tournament detail pages: view participants, matches, standings; start/cancel tournaments (creator only); report match results
- Guild announcement settings toggles

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
| `NEXTAUTH_URL` | Yes (web) | `http://localhost:3000` for local, `http://<IP>:3000` for GCE, `https://yourdomain.com` for production |
| `NEXT_PUBLIC_WS_URL` | Yes (web) | WebSocket URL: `http://localhost:3001` local, `http://<IP>:3001` or `wss://yourdomain.com/ws` for production |
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

The Dockerfile uses `corepack` to match the `packageManager` field in `package.json`, ensuring consistent npm versions across local dev and Docker builds. No manual npm version patching needed.

Adding a new workspace package? Add its `package.json` copy line in the Dockerfile `deps` stage — there's a comment marking where.

## Deployment

### Google Compute Engine (Free Tier)

The bot runs on a single GCE `e2-micro` VM. GitHub Actions deploys on every push to `main`.

**Quick setup:**
1. Create a GCE VM (Debian 12, `e2-micro`, static external IP)
2. Install Docker and Git on the VM
3. Create a `deploy` user with Docker group access
4. Clone the repo to `/opt/yugioh-discord-bot`
5. Create `.env` on the VM (see Environment Variables above)
6. Set Discord redirect URI: `http://<YOUR_IP>:3000/api/auth/callback/discord`
7. Run `docker compose up -d --build`
8. Add GitHub Actions secrets (`GCE_HOST`, `GCE_USER`, `GCE_SSH_PRIVATE_KEY`, `GCE_PORT`)

See `docs/deployment/gce-runbook.md` for the full step-by-step guide and `docs/deployment/google-compute-engine.md` for initial VM provisioning.

### Adding a Custom Domain (Optional)

For HTTPS with a custom domain, add Caddy as a reverse proxy:

1. Point your domain's A record to the GCE external IP
2. Create a `Caddyfile` in the project root:
   ```
   yourdomain.com {
       reverse_proxy web:3000
   }
   ```
3. Uncomment the `caddy` service in `docker-compose.yml`
4. Remove `ports: "3000:3000"` from the `web` service
5. Update `.env`: `NEXTAUTH_URL=https://yourdomain.com` and `NEXT_PUBLIC_WS_URL=wss://yourdomain.com/ws`
6. Update Discord redirect URI to `https://yourdomain.com/api/auth/callback/discord`
7. Open GCE firewall ports 80 and 443
8. `docker compose up -d --build` — Caddy auto-provisions HTTPS via Let's Encrypt

You can also use Caddy without a domain (HTTP-only on port 80) if you just want a reverse proxy. See `docs/deployment/gce-runbook.md` for details.

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