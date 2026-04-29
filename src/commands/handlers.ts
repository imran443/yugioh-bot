import type { PlayerRepository } from "../repositories/players.js";
import type { MatchService } from "../services/matches.js";
import type { TournamentFormat, TournamentService } from "../services/tournaments.js";

export type DiscordUserLike = {
  id: string;
  username: string;
  displayName?: string;
};

export type CommandInteractionLike = {
  commandName: string;
  guildId: string | null;
  user: DiscordUserLike;
  options: {
    getSubcommand(): string;
    getString(name: string, required?: boolean): string | null;
    getUser(name: string, required?: boolean): DiscordUserLike | null;
  };
  reply(message: string | { content: string; ephemeral?: boolean }): Promise<void> | void;
};

type CommandDependencies = {
  players: PlayerRepository;
  matches: MatchService;
  tournaments: TournamentService;
};

function displayName(user: DiscordUserLike) {
  return user.displayName ?? user.username;
}

function requireGuildId(interaction: CommandInteractionLike) {
  if (!interaction.guildId) {
    throw new Error("This command can only be used in a server");
  }

  return interaction.guildId;
}

function requireUserOption(interaction: CommandInteractionLike, name: string) {
  const user = interaction.options.getUser(name, true);

  if (!user) {
    throw new Error(`Missing user option: ${name}`);
  }

  return user;
}

function requireStringOption(interaction: CommandInteractionLike, name: string) {
  const value = interaction.options.getString(name, true);

  if (!value) {
    throw new Error(`Missing string option: ${name}`);
  }

  return value;
}

function winnerFromResult(result: string, reporterId: number, opponentId: number) {
  if (result === "win") {
    return reporterId;
  }

  if (result === "loss") {
    return opponentId;
  }

  throw new Error("Result must be win or loss");
}

function requireTournament(deps: CommandDependencies, guildId: string, name: string) {
  const tournament = deps.tournaments.findByName(guildId, name);

  if (!tournament) {
    throw new Error(`Tournament not found: ${name}`);
  }

  return tournament;
}

async function handleDuel(interaction: CommandInteractionLike, deps: CommandDependencies) {
  const guildId = requireGuildId(interaction);
  const opponentUser = requireUserOption(interaction, "player");
  const result = requireStringOption(interaction, "result");
  const reporter = deps.players.upsert(guildId, interaction.user.id, displayName(interaction.user));
  const opponent = deps.players.upsert(guildId, opponentUser.id, displayName(opponentUser));
  const winnerId = winnerFromResult(result, reporter.id, opponent.id);
  const match = deps.matches.report({
    guildId,
    reporterId: reporter.id,
    opponentId: opponent.id,
    winnerId,
    source: "casual",
  });

  await interaction.reply(
    `Duel reported as ${result}. ${opponent.displayName} must /approve or /deny it. Match #${match.id}`,
  );
}

async function handleApprove(interaction: CommandInteractionLike, deps: CommandDependencies) {
  const guildId = requireGuildId(interaction);
  const player = deps.players.upsert(guildId, interaction.user.id, displayName(interaction.user));
  const match = deps.matches.latestPendingForPlayer(player.id);

  if (!match) {
    await interaction.reply("You have no pending duel reports to approve.");
    return;
  }

  deps.matches.approve(match.id, player.id);
  await interaction.reply(`Approved match #${match.id}.`);
}

async function handleDeny(interaction: CommandInteractionLike, deps: CommandDependencies) {
  const guildId = requireGuildId(interaction);
  const player = deps.players.upsert(guildId, interaction.user.id, displayName(interaction.user));
  const match = deps.matches.latestPendingForPlayer(player.id);

  if (!match) {
    await interaction.reply("You have no pending duel reports to deny.");
    return;
  }

  deps.matches.deny(match.id, player.id);
  await interaction.reply(`Denied match #${match.id}.`);
}

async function handleStats(interaction: CommandInteractionLike, deps: CommandDependencies) {
  const guildId = requireGuildId(interaction);
  const targetUser = interaction.options.getUser("player") ?? interaction.user;
  const player = deps.players.upsert(guildId, targetUser.id, displayName(targetUser));
  const stats = deps.matches.stats(player.id);
  const total = stats.wins + stats.losses;
  const winRate = total === 0 ? 0 : Math.round((stats.wins / total) * 100);

  await interaction.reply(`${player.displayName}: ${stats.wins}W - ${stats.losses}L (${winRate}% win rate)`);
}

async function handleRankings(interaction: CommandInteractionLike, deps: CommandDependencies) {
  const guildId = requireGuildId(interaction);
  const rows = deps.matches.leaderboard(guildId);

  if (rows.length === 0) {
    await interaction.reply("No players have been tracked yet.");
    return;
  }

  await interaction.reply(
    rows
      .map((row, index) => `${index + 1}. ${row.displayName}: ${row.wins}W - ${row.losses}L`)
      .join("\n"),
  );
}

async function handleEvent(interaction: CommandInteractionLike, deps: CommandDependencies) {
  const guildId = requireGuildId(interaction);
  const subcommand = interaction.options.getSubcommand();
  const name = requireStringOption(interaction, "name");

  if (subcommand === "create") {
    const format = requireStringOption(interaction, "format") as TournamentFormat;
    const tournament = deps.tournaments.create(guildId, name, format, interaction.user.id);
    await interaction.reply(`Event created: ${tournament.name} (${tournament.format}).`);
    return;
  }

  const tournament = requireTournament(deps, guildId, name);

  if (subcommand === "join") {
    const player = deps.players.upsert(guildId, interaction.user.id, displayName(interaction.user));
    deps.tournaments.join(tournament.id, player.id);
    await interaction.reply(`Joined event: ${tournament.name}.`);
    return;
  }

  if (subcommand === "start") {
    deps.tournaments.start(tournament.id);
    await interaction.reply(`Started event: ${tournament.name}.`);
    return;
  }

  if (subcommand === "show") {
    const openMatches = deps.tournaments.openMatches(tournament.id);
    await interaction.reply(`${tournament.name}: ${openMatches.length} open match(es).`);
    return;
  }

  if (subcommand === "report") {
    const opponentUser = requireUserOption(interaction, "player");
    const result = requireStringOption(interaction, "result");
    const reporter = deps.players.upsert(guildId, interaction.user.id, displayName(interaction.user));
    const opponent = deps.players.upsert(guildId, opponentUser.id, displayName(opponentUser));
    const winnerId = winnerFromResult(result, reporter.id, opponent.id);
    const match = deps.tournaments.report(tournament.id, reporter.id, opponent.id, winnerId);
    await interaction.reply(
      `Event match reported as ${result}. ${opponent.displayName} must /approve or /deny it. Match #${match.id}`,
    );
    return;
  }

  if (subcommand === "cancel") {
    deps.tournaments.cancel(tournament.id);
    await interaction.reply(`Cancelled event: ${tournament.name}.`);
    return;
  }

  throw new Error(`Unsupported event subcommand: ${subcommand}`);
}

export async function handleCommand(interaction: CommandInteractionLike, deps: CommandDependencies) {
  if (interaction.commandName === "duel") {
    await handleDuel(interaction, deps);
    return;
  }

  if (interaction.commandName === "approve") {
    await handleApprove(interaction, deps);
    return;
  }

  if (interaction.commandName === "deny") {
    await handleDeny(interaction, deps);
    return;
  }

  if (interaction.commandName === "stats") {
    await handleStats(interaction, deps);
    return;
  }

  if (interaction.commandName === "rankings") {
    await handleRankings(interaction, deps);
    return;
  }

  if (interaction.commandName === "event") {
    await handleEvent(interaction, deps);
    return;
  }

  throw new Error(`Unsupported command: ${interaction.commandName}`);
}
