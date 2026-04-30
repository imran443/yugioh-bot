# Google Compute Engine Deployment

This guide deploys the Discord bot to a Google Cloud Free Tier Compute Engine VM and uses GitHub Actions to deploy future pushes over SSH.

For a catch-up checklist of the current setup and day-to-day commands, see `docs/deployment/gce-runbook.md`.

## Cost Guardrails

Use a free-tier eligible Compute Engine setup:

- Machine type: `e2-micro`
- Region: `us-central1`, `us-east1`, or `us-west1`
- Disk: standard persistent disk, kept within free-tier limits
- One VM only

Google Cloud requires a billing account. Set a budget alert before running the bot.

## 1. Create The VM

Create a Linux VM:

- OS: Debian 12 or Ubuntu LTS
- Machine: `e2-micro`
- Region: `us-central1`, `us-east1`, or `us-west1`
- Boot disk: standard persistent disk
- External IP: enabled

Reserve a static external IP and assign it to the VM so GitHub Actions has a stable SSH target.

## 2. Install Dependencies On The VM

SSH into the VM, then run the Debian install commands below. For Ubuntu, replace `https://download.docker.com/linux/debian` with `https://download.docker.com/linux/ubuntu`.

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl git gnupg
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/debian/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg
echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/debian \
  $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | \
  sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
```

## 3. Create Deploy User

```bash
sudo adduser deploy
sudo usermod -aG docker deploy
sudo mkdir -p /opt/yugioh-discord-bot
sudo chown -R deploy:deploy /opt/yugioh-discord-bot
```

Log out and back in after adding `deploy` to the Docker group.

## 4. Create SSH Deploy Key

On your local machine:

```bash
ssh-keygen -t ed25519 -C "github-actions-yugioh-bot" -f ./gce_deploy_key
```

On the VM, add the public key to the deploy user. Replace the placeholder with the contents of `gce_deploy_key.pub`:

```bash
sudo mkdir -p /home/deploy/.ssh
sudo chmod 700 /home/deploy/.ssh
printf '%s\n' '<paste gce_deploy_key.pub here>' | sudo tee -a /home/deploy/.ssh/authorized_keys
sudo chmod 600 /home/deploy/.ssh/authorized_keys
sudo chown -R deploy:deploy /home/deploy/.ssh
```

## 5. Clone The Repo On The VM

As the `deploy` user:

```bash
sudo -iu deploy
git clone https://github.com/imran443/yugioh-bot.git /opt/yugioh-discord-bot
cd /opt/yugioh-discord-bot
```

If the repository is private, use a deploy key or GitHub token with read access.

## 6. Add Bot Environment Variables On The VM

Create `/opt/yugioh-discord-bot/.env`:

```bash
DISCORD_TOKEN=
DISCORD_CLIENT_ID=
DISCORD_GUILD_ID=
DATABASE_PATH=./data/bot.sqlite
REMINDER_CRON=0 10 * * *
REMINDER_TIMEZONE=America/New_York
DISCORD_REMINDER_CHANNEL_ID=
```

Keep this file on the VM. Do not commit it.

## 7. Run First Manual Deploy

```bash
cd /opt/yugioh-discord-bot
docker compose up -d --build
docker compose logs -f bot
```

Confirm the bot logs in and Discord commands are deployed.

## 8. Add GitHub Actions Secrets

In GitHub, open the repo and go to Settings -> Secrets and variables -> Actions. Add:

- `GCE_HOST`: VM static external IP or DNS name
- `GCE_USER`: `deploy`
- `GCE_SSH_PRIVATE_KEY`: contents of `gce_deploy_key`
- `GCE_PORT`: `22` if using the default SSH port

## 9. Trigger Deploy

Push to `main` or run the `Deploy` workflow manually from the GitHub Actions tab.

Merging a pull request into `main` also triggers deployment because GitHub records the merge as a push to `main`.

Until `GCE_HOST`, `GCE_USER`, and `GCE_SSH_PRIVATE_KEY` are configured, the workflow skips deployment cleanly.

## Troubleshooting

Check service status:

```bash
cd /opt/yugioh-discord-bot
docker compose ps
docker compose logs --tail=200 bot
```

Restart the bot:

```bash
docker compose restart bot
```

Rebuild manually:

```bash
git fetch --all --prune
git reset --hard origin/main
docker compose up -d --build
```

Back up SQLite:

```bash
./scripts/backup-sqlite.sh
```
