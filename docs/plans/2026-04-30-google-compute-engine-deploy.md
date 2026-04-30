# Google Compute Engine Deploy Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add GitHub Actions SSH deployment documentation and workflow support for running the bot on a Google Cloud Free Tier Compute Engine VM.

**Architecture:** Keep the current Docker Compose and SQLite architecture. A single Compute Engine VM runs the bot from `/opt/yugioh-discord-bot`; GitHub Actions deploys by SSHing into the VM, resetting to `origin/main`, rebuilding the Compose service, and printing logs. Discord secrets stay on the VM in `.env`; GitHub stores only SSH deployment credentials.

**Tech Stack:** GitHub Actions, SSH, Google Compute Engine, Docker Compose, Debian or Ubuntu Linux, TypeScript, discord.js, SQLite.

---

### Task 1: Add GitHub Actions Deployment Workflow

**Files:**
- Create: `.github/workflows/deploy.yml`

**Step 1: Create the workflow directory if needed**

Run:

```bash
mkdir -p .github/workflows
```

Expected: directory exists.

**Step 2: Add the workflow file**

Create `.github/workflows/deploy.yml`:

```yaml
name: Deploy

on:
  push:
    branches:
      - main
  workflow_dispatch:

concurrency:
  group: deploy-production
  cancel-in-progress: false

jobs:
  deploy:
    name: Deploy to Google Compute Engine
    runs-on: ubuntu-latest
    timeout-minutes: 20
    env:
      GCE_HOST: ${{ secrets.GCE_HOST }}
      GCE_USER: ${{ secrets.GCE_USER }}
      GCE_SSH_PRIVATE_KEY: ${{ secrets.GCE_SSH_PRIVATE_KEY }}
      GCE_PORT: ${{ secrets.GCE_PORT || '22' }}

    steps:
      - name: Skip deploy when VM secrets are not configured
        if: ${{ env.GCE_HOST == '' || env.GCE_USER == '' || env.GCE_SSH_PRIVATE_KEY == '' }}
        run: echo "GCE deploy secrets are not configured yet; skipping deploy."

      - name: Configure SSH key
        if: ${{ env.GCE_HOST != '' && env.GCE_USER != '' && env.GCE_SSH_PRIVATE_KEY != '' }}
        run: |
          mkdir -p ~/.ssh
          chmod 700 ~/.ssh
          printf '%s\n' "$GCE_SSH_PRIVATE_KEY" > ~/.ssh/gce_deploy_key
          chmod 600 ~/.ssh/gce_deploy_key

      - name: Trust VM host key
        if: ${{ env.GCE_HOST != '' && env.GCE_USER != '' && env.GCE_SSH_PRIVATE_KEY != '' }}
        run: |
          ssh-keyscan -p "$GCE_PORT" -H "$GCE_HOST" >> ~/.ssh/known_hosts

      - name: Deploy over SSH
        if: ${{ env.GCE_HOST != '' && env.GCE_USER != '' && env.GCE_SSH_PRIVATE_KEY != '' }}
        run: |
          ssh -i ~/.ssh/gce_deploy_key \
            -p "$GCE_PORT" \
            "$GCE_USER@$GCE_HOST" \
            'cd /opt/yugioh-discord-bot && git fetch --all --prune && git reset --hard origin/main && docker compose up -d --build && docker compose ps && docker compose logs --tail=80 bot'
```

**Step 3: Validate workflow syntax locally**

Run:

```bash
git diff -- .github/workflows/deploy.yml
```

Expected: workflow has `push` on `main`, `workflow_dispatch`, SSH setup, and remote deploy command.
It should also skip cleanly while VM secrets are not configured.

**Step 4: Commit**

```bash
git add .github/workflows/deploy.yml
git commit -m "ci: add gce deploy workflow"
```

---

### Task 2: Add Google Compute Engine Deployment Guide

**Files:**
- Create: `docs/deployment/google-compute-engine.md`

**Step 1: Write the deployment guide**

Create `docs/deployment/google-compute-engine.md`:

```markdown
# Google Compute Engine Deployment

This guide deploys the Discord bot to a Google Cloud Free Tier Compute Engine VM and uses GitHub Actions to deploy future pushes over SSH.

## Cost Guardrails

Use a free-tier eligible Compute Engine setup:

- Machine type: `e2-micro`
- Region: `us-central1`, `us-east1`, or `us-west1`
- Disk: standard persistent disk, kept within free-tier limits
- One VM only

Google Cloud requires a billing account. Monitor billing and set a budget alert.

## 1. Create The VM

Create a Linux VM:

- OS: Debian 12 or Ubuntu LTS
- Machine: `e2-micro`
- Region: `us-central1`, `us-east1`, or `us-west1`
- Boot disk: standard persistent disk
- External IP: enabled

Reserve a static external IP and assign it to the VM so GitHub Actions has a stable SSH target.

## 2. Install Dependencies On The VM

SSH into the VM, then run:

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl git gnupg
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/debian/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg
echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/debian \
  $(. /etc/os-release && echo \"$VERSION_CODENAME\") stable" | \
  sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
```

If using Ubuntu, replace the Docker repository URL with `https://download.docker.com/linux/ubuntu`.

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

On the VM, add the public key:

```bash
sudo mkdir -p /home/deploy/.ssh
sudo chmod 700 /home/deploy/.ssh
sudo tee -a /home/deploy/.ssh/authorized_keys < gce_deploy_key.pub
sudo chmod 600 /home/deploy/.ssh/authorized_keys
sudo chown -R deploy:deploy /home/deploy/.ssh
```

## 5. Clone The Repo On The VM

As the `deploy` user:

```bash
sudo -iu deploy
git clone <your-github-repo-url> /opt/yugioh-discord-bot
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
```

**Step 2: Review guide**

Run:

```bash
git diff -- docs/deployment/google-compute-engine.md
```

Expected: guide includes cost guardrails, VM setup, Docker install, deploy user, SSH keys, `.env`, first manual deploy, GitHub secrets, and troubleshooting.

**Step 3: Commit**

```bash
git add docs/deployment/google-compute-engine.md
git commit -m "docs: add google compute deployment guide"
```

---

### Task 3: Link Deployment Guide From README

**Files:**
- Modify: `README.md`

**Step 1: Update the Deployment section**

Change:

```markdown
For cheap/free hosting, see `docs/deployment/free-cheap-hosting.md`.
```

To:

```markdown
For Google Cloud Free Tier VM deployment with GitHub Actions, see `docs/deployment/google-compute-engine.md`.

For other cheap/free hosting options, see `docs/deployment/free-cheap-hosting.md`.
```

**Step 2: Review README diff**

Run:

```bash
git diff -- README.md
```

Expected: README links the Google Compute Engine guide.

**Step 3: Commit**

```bash
git add README.md
git commit -m "docs: link gce deployment guide"
```

---

### Task 4: Verify Repository State

**Files:**
- Verify all changed files.

**Step 1: Run local checks**

Run:

```bash
npm test
npm run typecheck
npm run build
docker compose build
```

Expected: all commands pass.

**Step 2: Check git status**

Run:

```bash
git status --short
```

Expected: clean working tree after commits.

---

### Task 5: Manual Google Cloud Setup

**Files:**
- No repository changes.

**Step 1: Create GCP project and billing guardrails**

In Google Cloud Console:

- Create or select a project.
- Enable billing.
- Create a budget alert.
- Use a free-tier eligible region.

Expected: project can create Compute Engine resources and has budget alerting.

**Step 2: Create VM**

Use:

- `e2-micro`
- Debian 12 or Ubuntu LTS
- standard persistent disk
- static external IP
- SSH enabled

Expected: VM is reachable over SSH.

**Step 3: Complete the VM guide**

Follow `docs/deployment/google-compute-engine.md` through the first manual deploy.

Expected: bot is online and Discord commands respond.

---

### Task 6: Enable GitHub Actions Deployment

**Files:**
- GitHub repository settings only.

**Step 1: Add repository secrets**

Add:

- `GCE_HOST`
- `GCE_USER`
- `GCE_SSH_PRIVATE_KEY`
- `GCE_PORT`

Expected: secrets are available to GitHub Actions.

**Step 2: Trigger workflow manually**

In GitHub Actions, run the `Deploy` workflow with `workflow_dispatch`.

Expected: workflow connects to VM, updates repo, rebuilds container, and prints bot logs.

**Step 3: Verify Discord**

In Discord, run:

```text
/help
/event dashboard
```

Expected: live bot responds.

---

### Task 7: Push Local Repo To GitHub

**Files:**
- Git remote configuration only.

**Step 1: Add GitHub remote**

Run:

```bash
git remote add origin <your-github-repo-url>
```

If `origin` already exists, run:

```bash
git remote set-url origin <your-github-repo-url>
```

**Step 2: Rename branch to main if needed**

Run:

```bash
git branch -M main
```

**Step 3: Push**

Run:

```bash
git push -u origin main
```

Expected: repository is on GitHub and future pushes to `main` can deploy.
