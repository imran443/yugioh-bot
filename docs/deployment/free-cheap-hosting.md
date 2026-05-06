# Cheap Deployment Options

## Recommendation

Run the app as a Docker Compose service on an always-on VM. Do not use serverless functions or hosts that sleep — Discord bots need a persistent websocket connection.

## Best Options

1. Hetzner Cloud CAX11 (ARM64, 4GB RAM, ~€3.79/mo) — recommended
2. Existing home server, NAS, or Raspberry Pi
3. Other small paid VMs with persistent storage

## Hetzner Quick Setup

1. Create a CAX11 server (Ubuntu 24.04, ARM64)
2. Add your SSH key in the Hetzner Cloud Console
3. Allow TCP ports 22, 80, 443 in the firewall
4. Install Docker: `curl -fsSL https://get.docker.com | sh`
5. Clone the repo, create `.env`, run `docker compose up -d --build`

See `docs/deployment/vm-runbook.md` for the full guide.

## Updating

```bash
cd /opt/yugioh-bot
git fetch --all --prune && git reset --hard origin/main
docker compose up -d --build
```

Or push to `main` and let GitHub Actions deploy automatically.

## Backups

```bash
./scripts/backup-sqlite.sh
```

Optional daily cron:
```cron
0 3 * * * cd /opt/yugioh-bot && ./scripts/backup-sqlite.sh >> backup.log 2>&1
```

## Avoid

- Serverless functions
- Free hosts that sleep
- Ephemeral container storage without a mounted volume
- Multiple running bot replicas sharing the same SQLite database