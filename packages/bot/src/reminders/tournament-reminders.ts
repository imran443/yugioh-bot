import type Database from "better-sqlite3";

export type TournamentReminderTarget = {
  guildId: string;
  tournamentName: string;
  roundNumber: number;
  playerOneDiscordUserId: string;
  playerTwoDiscordUserId: string;
};

export function selectTournamentReminderTargets(
  db: Database.Database,
  guildId?: string,
): TournamentReminderTarget[] {
  return db
    .prepare(
      `
      select
        t.guild_id,
        t.name as tournament_name,
        tm.round_number,
        p1.discord_user_id as player_one_discord_user_id,
        p2.discord_user_id as player_two_discord_user_id
      from tournament_matches tm
      join tournaments t on t.id = tm.tournament_id
      join players p1 on p1.id = tm.player_one_id
      join players p2 on p2.id = tm.player_two_id
      where t.status = 'active'
        and tm.status = 'open'
        and tm.player_two_id is not null
        and (? is null or t.guild_id = ?)
      order by t.name asc, tm.round_number asc, tm.id asc
    `,
    )
    .all(guildId ?? null, guildId ?? null)
    .map((row: any) => ({
      guildId: row.guild_id,
      tournamentName: row.tournament_name,
      roundNumber: row.round_number,
      playerOneDiscordUserId: row.player_one_discord_user_id,
      playerTwoDiscordUserId: row.player_two_discord_user_id,
    }));
}

export function formatTournamentReminder(targets: TournamentReminderTarget[]) {
  if (targets.length === 0) {
    return null;
  }

  const lines = targets.map(
    (target) =>
      `- ${target.tournamentName} round ${target.roundNumber}: <@${target.playerOneDiscordUserId}> vs <@${target.playerTwoDiscordUserId}>`,
  );

  return ["Tournament matches still need to be played:", ...lines].join("\n");
}
