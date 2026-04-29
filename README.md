# Yugioh Discord Bot

A Discord-native bot for tracking Yugioh 1v1 matches, server rankings, approved match history, and tournaments.

## Features

- `/duel` reports a casual 1v1 match.
- `/approve` approves your latest pending match report.
- `/deny` rejects your latest pending match report.
- `/stats` shows lifetime wins, losses, and win rate.
- `/rankings` shows the server leaderboard.
- `/event` creates, joins, starts, shows, reports, and cancels tournaments.
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

1. Run `/stats` and confirm the bot responds with `0W - 0L`.
2. Run `/duel @player result:win` from one account.
3. Run `/approve` from the opponent account.
4. Run `/stats` again and confirm the win/loss changed.
5. Run `/rankings` and confirm approved records are shown.
6. Run `/event create name:locals format:round_robin`.
7. Have at least two players run `/event join name:locals`.
8. Run `/event start name:locals`.
9. Run `/event show name:locals` and confirm open matches are listed.
10. Run `/event report name:locals @player result:win`.
11. Have the opponent run `/approve`.
12. Run `/event show name:locals` and confirm the match count changed.
13. Run `/event cancel name:locals` if you want to clean up the test event.

## Quality Checks

```bash
npm test
npm run typecheck
npm run build
```

## Deployment

For cheap/free hosting, see `docs/deployment/free-cheap-hosting.md`.

## Production Checklist

Before deploying publicly, follow `docs/deployment/operations-checklist.md`.

## Backups

Run `./scripts/backup-sqlite.sh` to create a timestamped SQLite backup in `./backups`.
