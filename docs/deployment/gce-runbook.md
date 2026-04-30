# GCE Deployment Runbook

This runbook is the catch-up guide for the current production setup. The bot runs on a Google Cloud Free Tier Compute Engine VM, and GitHub Actions deploys `main` to the VM over SSH.

## Current Repository State

- GitHub repo: `https://github.com/imran443/yugioh-bot`
- Production branch: `main`
- Deploy workflow: `.github/workflows/deploy.yml`
- VM app path: `/opt/yugioh-discord-bot`
- Runtime user on VM: `deploy`
- Bot data path on VM: `/opt/yugioh-discord-bot/data/bot.sqlite`

The deploy workflow requires these GitHub Actions secrets:

- `GCE_HOST`
- `GCE_USER`
- `GCE_SSH_PRIVATE_KEY`
- `GCE_PORT`

## Deployment Pipeline

1. Code is pushed to `main` on GitHub.
2. GitHub Actions starts the `Deploy` workflow.
3. The workflow SSHes into the Google Compute Engine VM as `deploy`.
4. The VM resets `/opt/yugioh-discord-bot` to `origin/main`.
5. Docker Compose rebuilds and restarts the bot.
6. Container startup runs `npm run commands:deploy:prod && npm start`.
7. SQLite persists in `./data` on the VM through the Compose volume.

Merging a pull request into `main` counts as a push to `main`, so it triggers this same deployment workflow. You can also run it manually from GitHub Actions with `workflow_dispatch`.

Remote deploy command used by the workflow:

```bash
cd /opt/yugioh-discord-bot && \
git fetch --all --prune && \
git reset --hard origin/main && \
docker compose up -d --build && \
docker compose ps && \
docker compose logs --tail=80 bot
```

## Free-Tier VM Settings

Use these settings to stay within Google Cloud Compute Engine Free Tier as closely as possible:

- Region: `us-central1`, `us-east1`, or `us-west1`
- Machine type: `e2-micro`
- OS: Debian 12
- Boot disk type: Standard persistent disk
- Boot disk size: `30 GB`
- Backups: disabled
- Ops Agent: disabled
- HTTP firewall: disabled
- HTTPS firewall: disabled
- External IP: static and attached to the VM
- Network Service Tier: Standard if available

Set a billing budget alert before running the VM. A reserved static IP can cost money if it is not attached to a running VM.

## VM Setup Status Checklist

Use this checklist to see where you are.

- [ ] GCE VM created with free-tier settings
- [ ] Static external IP attached to VM
- [ ] Docker and Git installed on VM
- [ ] `deploy` Linux user created
- [ ] `deploy` added to the `docker` group
- [ ] `/opt/yugioh-discord-bot` created and owned by `deploy`
- [ ] Repo cloned into `/opt/yugioh-discord-bot`
- [ ] `/opt/yugioh-discord-bot/.env` created on VM
- [ ] First manual `docker compose up -d --build` succeeds
- [ ] GitHub Actions deploy SSH key created
- [ ] Deploy public key added to `/home/deploy/.ssh/authorized_keys`
- [ ] GitHub Actions secrets added
- [ ] Manual GitHub Actions deploy run succeeds

## Current Working State

The deployment pipeline is considered working when a GitHub Actions `Deploy` run shows the remote SSH command completing and the VM shows the bot container as `Up`.

Recent successful signs:

- `docker compose ps` showed `yugioh-discord-bot-bot-1` as `Up`.
- Container startup ran `npm run commands:deploy:prod`.
- Logs showed `Deployed 7 guild commands`.
- Logs showed `Logged in as Yugioh Bot#0731`.

The npm major-version notice is informational. The Discord.js `ready` deprecation warning is non-blocking, but should be cleaned up before upgrading to Discord.js v15.

## Continue From Deploy User Setup

If you have already created the `deploy` user and assigned `/opt/yugioh-discord-bot`, continue here.

Switch to the deploy user:

```bash
sudo -iu deploy
```

Verify the account and permissions:

```bash
whoami
id
ls -ld /opt/yugioh-discord-bot
```

Expected:

- `whoami` prints `deploy`
- `id` includes `docker`
- `/opt/yugioh-discord-bot` is owned by `deploy deploy`

Clone the repo:

```bash
git clone https://github.com/imran443/yugioh-bot.git /opt/yugioh-discord-bot
cd /opt/yugioh-discord-bot
```

## Create The VM Environment File

Create the file:

```bash
nano /opt/yugioh-discord-bot/.env
```

Paste values from Discord Developer Portal and your server/channel IDs:

```bash
DISCORD_TOKEN=your_bot_token
DISCORD_CLIENT_ID=your_discord_client_id
DISCORD_GUILD_ID=your_discord_server_id
DATABASE_PATH=./data/bot.sqlite
REMINDER_CRON=0 10 * * *
REMINDER_TIMEZONE=America/New_York
DISCORD_REMINDER_CHANNEL_ID=your_channel_id
```

Save in nano:

- Press `Ctrl+O`
- Press Enter
- Press `Ctrl+X`

Never commit `.env`. It stays only on the VM.

## First Manual Deploy

Run as `deploy` on the VM:

```bash
cd /opt/yugioh-discord-bot
docker compose up -d --build
docker compose logs -f bot
```

Look for successful command deployment and bot login. Stop following logs with `Ctrl+C`.

Check status:

```bash
docker compose ps
```

The `bot` service should be `Up`.

## Create GitHub Actions Deploy Key

Run this on your local machine, not on the VM:

```bash
ssh-keygen -t ed25519 -C "github-actions-yugioh-bot" -f ./gce_deploy_key
```

This creates:

- `gce_deploy_key`: private key, goes into GitHub Actions secret `GCE_SSH_PRIVATE_KEY`
- `gce_deploy_key.pub`: public key, goes onto the VM

Add the public key on the VM:

```bash
sudo mkdir -p /home/deploy/.ssh
sudo chmod 700 /home/deploy/.ssh
printf '%s\n' '<paste gce_deploy_key.pub contents here>' | sudo tee -a /home/deploy/.ssh/authorized_keys
sudo chmod 600 /home/deploy/.ssh/authorized_keys
sudo chown -R deploy:deploy /home/deploy/.ssh
```

## Add GitHub Actions Secrets

In GitHub:

1. Open `https://github.com/imran443/yugioh-bot`.
2. Go to `Settings`.
3. Go to `Secrets and variables` -> `Actions`.
4. Add these repository secrets:

```text
GCE_HOST=<your static external IP>
GCE_USER=deploy
GCE_PORT=22
GCE_SSH_PRIVATE_KEY=<contents of local gce_deploy_key, not .pub>
```

After these secrets are added, the deploy workflow will stop skipping and will SSH into the VM.

## Trigger GitHub Actions Deploy

In GitHub:

1. Open `Actions`.
2. Select `Deploy`.
3. Click `Run workflow`.
4. Choose `main`.
5. Run it.

Expected result:

- Workflow connects to the VM over SSH.
- VM pulls `origin/main`.
- Docker Compose rebuilds and restarts the bot.
- Workflow prints the latest bot logs.

## Auto Deploy From Main

`.github/workflows/deploy.yml` deploys on every push to `main`:

```yaml
on:
  push:
    branches:
      - main
  workflow_dispatch:
```

Normal release flow:

1. Work on a branch.
2. Open a pull request.
3. Merge the pull request into `main`.
4. GitHub Actions automatically deploys `main` to the VM.
5. Confirm the `Deploy` workflow is green.
6. Smoke test `/help` and `/event dashboard` in Discord.

Direct pushes to `main` also deploy immediately. Avoid pushing unverified changes directly to `main` unless you intend to deploy them.

## Manual Operations

Run these from `/opt/yugioh-discord-bot` on the VM.

View status:

```bash
docker compose ps
```

View logs:

```bash
docker compose logs --tail=200 bot
```

Follow logs:

```bash
docker compose logs -f bot
```

Restart bot:

```bash
docker compose restart bot
```

Manual update:

```bash
git fetch --all --prune
git reset --hard origin/main
docker compose up -d --build
```

Stop bot:

```bash
docker compose down
```

Back up SQLite:

```bash
./scripts/backup-sqlite.sh
```

## Discord Smoke Test

After the container is up, test in Discord:

```text
/help
/event dashboard
```

Both commands should respond from the live VM-hosted bot.

## After Each Deploy

Check GitHub Actions first. Then verify the VM if anything looks wrong:

```bash
cd /opt/yugioh-discord-bot
docker compose ps
docker compose logs --tail=100 bot
```

Expected signs:

- `bot` service is `Up`.
- Logs include command deployment.
- Logs include `Logged in as ...`.
- Discord commands respond in the server.
