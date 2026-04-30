# Google Compute Engine Deploy Design

## Goal

Deploy the Discord bot to a Google Cloud Free Tier Compute Engine VM, keep SQLite data on the VM's persistent disk, and deploy new code from GitHub using GitHub Actions over SSH.

## Hosting Choice

Use a single Google Compute Engine VM instead of Cloud Run, Vercel, or Render free web services. The bot uses the Discord gateway through `discord.js`, so it needs a long-running process. Serverless request/response platforms are a poor fit unless the bot is rewritten around Discord HTTP interactions and an external database.

The VM should use a free-tier eligible machine and region:

- Machine type: `e2-micro`
- Region: `us-central1`, `us-east1`, or `us-west1`
- Disk: standard persistent boot disk, kept within the free-tier allowance
- OS: Debian 12 or Ubuntu LTS

## Architecture

GitHub is the source of truth for code. The VM runs Docker Compose from a checked-out copy of the repository in `/opt/yugioh-discord-bot`. The existing `docker-compose.yml` starts the bot with:

```bash
npm run commands:deploy:prod && npm start
```

That keeps slash-command deployment tied to every container rebuild. The bot stores SQLite data under `./data/bot.sqlite`, which maps to the VM filesystem through the existing Compose volume:

```yaml
volumes:
  - ./data:/app/data
```

Because the VM uses persistent disk, this data survives container rebuilds and VM restarts.

## Deployment Flow

On every push to the production branch, GitHub Actions connects to the VM with SSH and runs a remote deploy script.

Remote deploy commands:

```bash
cd /opt/yugioh-discord-bot
git fetch --all --prune
git reset --hard origin/main
docker compose up -d --build
docker compose ps
docker compose logs --tail=80 bot
```

The workflow should also support manual deployment through `workflow_dispatch`.

## Secret Handling

Discord secrets stay on the VM in `/opt/yugioh-discord-bot/.env`. They should not be stored in GitHub Actions.

The VM `.env` contains:

```bash
DISCORD_TOKEN=
DISCORD_CLIENT_ID=
DISCORD_GUILD_ID=
DATABASE_PATH=./data/bot.sqlite
REMINDER_CRON=0 10 * * *
REMINDER_TIMEZONE=America/New_York
DISCORD_REMINDER_CHANNEL_ID=
```

GitHub Actions stores only deployment connection secrets:

- `GCE_HOST`: VM static external IP or DNS name
- `GCE_USER`: deploy user, usually `deploy`
- `GCE_SSH_PRIVATE_KEY`: private key for the deploy user
- `GCE_PORT`: optional, defaults to `22`

This keeps the Discord bot token off GitHub while still enabling automated deploys.

## VM Setup

Manual VM preparation is required once:

1. Create the VM in a free-tier eligible region.
2. Reserve a static external IP so GitHub Actions has a stable target.
3. Install Docker, the Docker Compose plugin, and Git.
4. Create a `deploy` user.
5. Add the deploy user to the `docker` group.
6. Add the GitHub Actions deploy public SSH key to `/home/deploy/.ssh/authorized_keys`.
7. Clone the repository to `/opt/yugioh-discord-bot`.
8. Create `/opt/yugioh-discord-bot/.env` with Discord secrets.
9. Run `docker compose up -d --build` once manually to verify the bot starts.

## Repository Changes

Add:

- `.github/workflows/deploy.yml` for SSH-based deploys on push to `main` and manual dispatch.
- `docs/deployment/google-compute-engine.md` with exact VM setup, GitHub secret setup, and deploy troubleshooting steps.

Update:

- `README.md` to link the Google Compute Engine deployment guide.

## Error Handling

The workflow should fail if SSH cannot connect, if `git fetch` or `git reset` fails, if Docker build fails, or if Compose cannot start the service. Logs from the bot container should be printed at the end of the deploy for quick diagnosis.

The VM should keep Docker's `restart: unless-stopped` behavior from `docker-compose.yml`, so the bot restarts after Docker daemon or VM restarts.

## Testing

Before enabling GitHub Actions deploys:

1. Run local verification:

```bash
npm test
npm run typecheck
npm run build
docker compose build
```

2. Run a manual VM deploy:

```bash
cd /opt/yugioh-discord-bot
docker compose up -d --build
docker compose logs -f bot
```

3. Trigger the GitHub Actions workflow manually.
4. Push a small docs-only commit and confirm the workflow deploys successfully.
5. In Discord, run `/help` and `/event dashboard` to confirm the live bot responds.

## References

- GitHub Actions workflow syntax: https://docs.github.com/en/actions/writing-workflows/workflow-syntax-for-github-actions
- GitHub Actions repository secrets: https://docs.github.com/en/actions/security-for-github-actions/security-guides/using-secrets-in-github-actions
- Google Compute Engine static external IPs: https://cloud.google.com/compute/docs/ip-addresses/configure-static-external-ip-address
- Google Cloud Free Tier: https://cloud.google.com/free/docs/free-cloud-features
