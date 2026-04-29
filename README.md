# Yugioh Discord Bot

A Discord-native bot for tracking Yugioh 1v1 matches, server rankings, approved match history, and tournaments.

## Features

- `/duel` reports a casual 1v1 match.
- `/approve` approves your latest pending match report.
- `/deny` rejects your latest pending match report.
- `/stats` shows lifetime wins, losses, and win rate.
- `/stats` can include a tournament option to show your player stats for that tournament.
- `/rankings` shows the server leaderboard.
- `/help` shows available bot commands.
- `/event list` shows current tournaments.
- `/event signup` posts a tournament signup message with a Join Tournament button and optional role mention.
- `/event` creates, joins, starts, shows, reports, and cancels tournaments, including direct creator-seeded participants.
- Tournament name autocomplete helps pick existing events in supported tournament options.
- Daily reminders ping a configured channel for unplayed tournament matches.

## Discord Setup

1. Create an application in the Discord Developer Portal.
2. Add a bot user to the application.
3. Copy the bot token into `.env` as `DISCORD_TOKEN`.
4. Copy the application client ID into `.env` as `DISCORD_CLIENT_ID`.
5. Copy your test server ID into `.env` as `DISCORD_GUILD_ID`.
6. Copy the channel ID for reminders into `.env` as `DISCORD_REMINDER_CHANNEL_ID`.
7. Invite the bot to your server with slash command and message sending permissions.

## Local Setup

```bash
npm install
cp .env.example .env
npm run commands:deploy
npm run dev
```

SQLite data is stored in `./data/bot.sqlite` by default.

## Environment Variables

- `DISCORD_TOKEN`: Discord bot token.
- `DISCORD_CLIENT_ID`: Discord application client ID.
- `DISCORD_GUILD_ID`: Discord server ID for fast guild command deployment.
- `DISCORD_REMINDER_CHANNEL_ID`: Channel where daily tournament reminders are posted.
- `DATABASE_PATH`: SQLite file path. Defaults to `./data/bot.sqlite`.
- `REMINDER_CRON`: Cron schedule for daily reminders. Defaults to `0 10 * * *`.
- `REMINDER_TIMEZONE`: Timezone for reminders, such as `America/New_York`.

## Manual Test Checklist

Use a test Discord server and two Discord accounts if possible.

1. Run `docker compose up -d --build`; the container deploys slash commands before starting the bot.
2. Run `/help` and confirm the command summary appears.
3. Run `/stats` and confirm the bot responds with `0W - 0L`.
4. Run `/duel @player result:win` from one account.
5. Run `/approve` from the opponent account.
6. Run `/stats` again and confirm the win/loss changed.
7. Run `/rankings` and confirm approved records are shown.
8. Run `/event create name:locals format:round_robin player1:@player1 player2:@player2` and confirm the seeded participant count is shown.
9. Run `/event list` and confirm `locals` appears.
10. Confirm autocomplete suggestions match the option context: `/event signup` and `/event start` suggest your pending events, `/event show` suggests server events, `/event report` suggests active events you are in, `/event cancel` suggests your pending or active events, and `/stats tournament` suggests active or completed events.
11. Run `/event signup name:locals role:@role` and confirm the signup post mentions the role and includes a Join Tournament button.
12. Click Join Tournament from another account and confirm the player is added and receives an ephemeral reply. Click again and confirm participants are not duplicated.
13. Run `/event start name:locals`.
14. Run `/stats player:@player1 tournament:locals` and confirm that player's stats for the tournament appear.
15. Run `/stats player:@player1` with no tournament option and confirm active tournament stats appear when that player is in exactly one active tournament.
16. Run `/event show name:locals` and confirm the open match count is shown.
17. Run `/event report name:locals @player result:win`.
18. Have the opponent run `/approve`.
19. Run `/event show name:locals` and confirm the match count changed.
20. Run `/event cancel name:locals` if you want to clean up the test event.

## Quality Checks

```bash
npm test
npm run typecheck
npm run build
```

## Docker

Build and run locally:

```bash
docker compose up -d --build
docker compose logs -f bot
```

The Compose startup command runs `npm run commands:deploy:prod` before `npm start`, so slash command changes propagate whenever the container is rebuilt and restarted.

SQLite is stored in `./data/bot.sqlite`. Keep this directory backed up.

This Dockerfile uses `node:22-bookworm-slim` instead of Alpine to reduce native dependency issues with `better-sqlite3`.

## Deployment

For cheap/free hosting, see `docs/deployment/free-cheap-hosting.md`.

## Production Checklist

Before deploying publicly, follow `docs/deployment/operations-checklist.md`.

## Backups

Run `./scripts/backup-sqlite.sh` to create a timestamped SQLite backup in `./backups`.
