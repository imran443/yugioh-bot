# Production Operations Checklist

## Before First Deploy

- Create a Discord test server.
- Create the Discord application and bot user.
- Invite the bot with minimal required permissions.
- Use guild-scoped commands while testing.
- Create `.env` on the host and keep it out of git.
- Confirm `DATABASE_PATH` points inside the mounted `data/` directory.
- Confirm `DISCORD_REMINDER_CHANNEL_ID` points at the reminder channel.
- Confirm `REMINDER_CRON` and `REMINDER_TIMEZONE` match the server's expected reminder time.

## Deploy Smoke Test

- Run `docker compose up -d --build`.
- Run `docker compose logs -f bot` and confirm the bot logs in.
- Run `npm run commands:deploy` locally, or `docker compose run --rm bot npm run commands:deploy:prod` on the VM, before first deploy.
- In Discord, run `/stats` and confirm the bot responds.
- Run a test `/duel`, `/approve`, and `/rankings` flow.
- Create a test `/event`, join, start, and show it.

## Ongoing Operations

- Review logs after each deploy.
- Back up `./data/bot.sqlite` daily.
- Copy backups off the VM periodically.
- Keep the host OS patched.
- Rotate `DISCORD_TOKEN` if it is ever exposed.
- Do not run multiple bot replicas against the same SQLite file.

## Discord Notes

- Guild commands update faster and are better during development.
- Global commands can take longer to propagate.
- The bot needs permission to send messages in the reminder channel.
