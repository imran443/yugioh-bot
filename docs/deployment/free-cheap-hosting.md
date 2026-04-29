# Free and Cheap Deployment

## Recommendation

Run the bot as a Docker Compose service on an always-on VM. Do not use serverless functions or hosts that sleep, because Discord bots need a persistent websocket connection.

## Best Options

1. Oracle Cloud Always Free VM
2. Existing home server, NAS, or Raspberry Pi
3. Small paid VM or container host with persistent storage

Oracle Cloud Always Free is the best free cloud option if you can get capacity. A home server is the best free option if you already have reliable always-on hardware. A small paid VM is the simplest fallback.

## Oracle Cloud Always Free Setup

1. Create an Always Free VM.
2. Install Docker and Docker Compose.
3. Clone the bot repository.
4. Create `.env` from `.env.example` and fill in Discord values.
5. Run `docker compose up -d --build`.
6. Run `docker compose logs -f bot` to verify it connected.

## VM Commands

```bash
sudo apt update
sudo apt install -y ca-certificates curl git
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER
```

Log out and back in after adding the Docker group.

Then deploy:

```bash
git clone <repo-url> yugioh-discord-bot
cd yugioh-discord-bot
cp .env.example .env
nano .env
docker compose up -d --build
docker compose logs -f bot
```

Register slash commands from the built container:

```bash
docker compose run --rm bot npm run commands:deploy:prod
```

## Updating the Bot

```bash
git pull
docker compose up -d --build
docker compose logs -f bot
```

## Data Persistence

SQLite lives in `./data/bot.sqlite` on the VM. Do not delete this directory.

## Backups

Install SQLite CLI on the VM:

```bash
sudo apt install -y sqlite3
```

Create a backup manually:

```bash
./scripts/backup-sqlite.sh
```

Optional daily cron:

```cron
0 3 * * * cd /home/ubuntu/yugioh-discord-bot && ./scripts/backup-sqlite.sh >> backup.log 2>&1
```

Periodically copy `./backups` off the VM.

## Avoid

- Serverless functions
- Free hosts that sleep
- Ephemeral container storage without a mounted volume
- Multiple running bot replicas sharing the same SQLite database
