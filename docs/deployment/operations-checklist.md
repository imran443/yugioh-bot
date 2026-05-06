# Production Operations Checklist

## Before First Deploy

- Create a Discord test server.
- Create the Discord application and bot user.
- Copy the bot token, client ID, and client secret.
- Invite the bot with minimal required permissions.
- Create `.env` on the host from `.env.example` and fill in all values.
- Generate `NEXTAUTH_SECRET`: `openssl rand -base64 32`
- Set `NEXTAUTH_URL` and `NEXT_PUBLIC_WS_URL` to your VM IP or domain.
- Set Discord OAuth redirect URI: `http://<IP>/api/auth/callback/discord`
- Confirm `DATABASE_PATH` points inside the mounted `data/` directory.
- Confirm `DISCORD_REMINDER_CHANNEL_ID` points at the reminder channel.
- Confirm `REMINDER_CRON` and `REMINDER_TIMEZONE` match the server's expected reminder time.
- Ensure VM firewall allows TCP ports 22, 80, 443 (both OS-level and cloud-level).
- Add GitHub Actions secrets (`VM_HOST`, `VM_USER`, `VM_SSH_PRIVATE_KEY`, `VM_PORT`).

## Deploy Smoke Test

- Run `docker compose up -d --build`.
- Run `docker compose logs -f` and confirm all 4 services start.
- Visit `http://<IP>` and confirm the web dashboard loads.
- Click "Sign in with Discord" and confirm OAuth works.
- In Discord, run `/stats` and confirm the bot responds.
- Run a test `/duel`, `/approve`, and `/rankings` flow.
- Create a test `/event`, join, start, and show it.

## Ongoing Operations

- Review logs after each deploy: `docker compose logs --tail=50`
- Back up `./data/bot.sqlite` daily.
- Copy backups off the VM periodically.
- Keep the host OS patched: `apt update && apt upgrade -y`
- Rotate secrets if ever exposed.
- Do not run multiple bot replicas against the same SQLite file.

## Discord Notes

- Guild commands update faster and are better during development.
- Global commands can take longer to propagate.
- The bot needs permission to send messages in the reminder channel.