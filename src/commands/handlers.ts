import { ActionRowBuilder, ButtonBuilder, ButtonStyle, type InteractionReplyOptions } from "discord.js";
import { formatLeaderboard, formatStats } from "../formatters/stats.js";
import type { PlayerRepository } from "../repositories/players.js";
import type { CardCatalogService } from "../services/card-catalog.js";
import type { DraftImageService } from "../services/draft-images.js";
import type { DraftService } from "../services/drafts.js";
import type { MatchService } from "../services/matches.js";
import type { TournamentFormat, TournamentService } from "../services/tournaments.js";

export type DiscordUserLike = {
  id: string;
  username: string;
  displayName?: string;
};

export type DiscordRoleLike = {
  id: string;
  name: string;
};

export type CommandReplyLike = {
  content: string;
  ephemeral?: boolean;
  components?: InteractionReplyOptions["components"];
};

export type CommandInteractionLike = {
  commandName: string;
  channelId: string | null;
  guildId: string | null;
  user: DiscordUserLike;
  options: {
    getSubcommand(): string;
    getString(name: string, required?: boolean): string | null;
    getRole(name: string, required?: boolean): DiscordRoleLike | null;
    getUser(name: string, required?: boolean): DiscordUserLike | null;
  };
  reply(message: string | CommandReplyLike): Promise<void> | void;
};

export type DraftNotifier = {
  sendPickPrompt(input: {
    channelId: string;
    userId: string;
    draftId: number;
    draftName: string;
  }): Promise<void>;
};

type CommandDependencies = {
  players: PlayerRepository;
  matches: MatchService;
  tournaments: TournamentService;
  drafts: DraftService;
  cards: CardCatalogService;
  draftImages: DraftImageService;
  notifier: DraftNotifier;
};

const playerSeedOptionNames = Array.from({ length: 8 }, (_, index) => `player${index + 1}`);
const tournamentListSectionLimit = 5;
const tournamentParticipantListLimit = 25;

const helpMessage = [
  "Duel commands: /duel, /approve, /deny, /stats, /rankings",
  "Tournament commands: /event dashboard, /event create, /event signup, /event join, /event list, /event start, /event show, /event participants, /event report, /event cancel",
].join("\n");

function tournamentDashboardReply(): CommandReplyLike {
  return {
    content: [
      "Tournament Dashboard",
      "Use these buttons to find events, join, report matches, approve results, and see command help.",
    ].join("\n"),
    ephemeral: true,
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId("dashboard_create_event")
          .setLabel("Create Event")
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId("dashboard_open_events")
          .setLabel("Open Events")
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId("dashboard_my_events")
          .setLabel("My Events")
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId("dashboard_report_match")
          .setLabel("Report Match")
          .setStyle(ButtonStyle.Success),
      ),
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId("dashboard_pending_approvals")
          .setLabel("Approvals")
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId("dashboard_stats")
          .setLabel("Stats")
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId("dashboard_creator_tools")
          .setLabel("Creator Tools")
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId("dashboard_help")
          .setLabel("Help")
          .setStyle(ButtonStyle.Secondary),
      ),
    ],
  };
}

function draftDashboardReply(): CommandReplyLike {
  return {
    content: [
      "Draft Dashboard",
      "Use these buttons to create a draft, browse open drafts, and export completed decks.",
    ].join("\n"),
    ephemeral: true,
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId("draft_create")
          .setLabel("Create Draft")
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId("draft_open")
          .setLabel("Open Drafts")
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId("draft_export")
          .setLabel("Export Deck")
          .setStyle(ButtonStyle.Secondary),
      ),
    ],
  };
}

function displayName(user: DiscordUserLike): string {
  return user.displayName ?? user.username;
}

function requireGuildId(interaction: CommandInteractionLike): string {
  if (!interaction.guildId) {
    throw new Error("This command can only be used in a server");
  }

  return interaction.guildId;
}

function requireUserOption(interaction: CommandInteractionLike, name: string): DiscordUserLike {
  const user = interaction.options.getUser(name, true);

  if (!user) {
    throw new Error(`Missing user option: ${name}`);
  }

  return user;
}

function requireStringOption(interaction: CommandInteractionLike, name: string): string {
  const value = interaction.options.getString(name, true);

  if (!value) {
    throw new Error(`Missing string option: ${name}`);
  }

  return value;
}

function winnerFromResult(result: string, reporterId: number, opponentId: number): number {
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

function requireDraft(deps: CommandDependencies, guildId: string, name: string) {
  const draft = deps.drafts.findByName(guildId, name);

  if (!draft) {
    throw new Error(`Draft not found: ${name}`);
  }

  return draft;
}

function requireEventCreator(tournament: { createdByUserId: string }, userId: string): void {
  if (tournament.createdByUserId !== userId) {
    throw new Error("Only the event creator can do that");
  }
}

function requireDraftCreator(draft: { createdByUserId: string }, userId: string): void {
  if (draft.createdByUserId !== userId) {
    throw new Error("Only the draft creator can do that");
  }
}

function assertPendingTournament(tournament: { status: string }): void {
  if (tournament.status !== "pending") {
    throw new Error("Tournament has already started");
  }
}

function formatTournamentList(
  active: ReturnType<TournamentService["listByStatus"]>,
  pending: ReturnType<TournamentService["listByStatus"]>,
  deps: CommandDependencies,
): string {
  const activeLines = active.slice(0, tournamentListSectionLimit).map(
    (tournament) =>
      `- ${tournament.name} (${tournament.format}): ${deps.tournaments.openMatches(tournament.id).filter((match) => match.status === "open").length} open match(es)`,
  );
  const pendingLines = pending.slice(0, tournamentListSectionLimit).map(
    (tournament) =>
      `- ${tournament.name} (${tournament.format}): ${deps.tournaments.participants(tournament.id).length} participant(s)`,
  );
  const extraActiveCount = active.length - activeLines.length;
  const extraPendingCount = pending.length - pendingLines.length;

  if (activeLines.length === 0 && pendingLines.length === 0) {
    return "No active or pending events.";
  }

  return [
    ...(activeLines.length > 0
      ? [
          "Active events:",
          ...activeLines,
          ...(extraActiveCount > 0 ? [`...and ${extraActiveCount} more active event(s).`] : []),
        ]
      : []),
    ...(pendingLines.length > 0
      ? [
          "Pending events:",
          ...pendingLines,
          ...(extraPendingCount > 0 ? [`...and ${extraPendingCount} more pending event(s).`] : []),
        ]
      : []),
  ].join("\n");
}

function formatTournamentParticipants(
  tournamentName: string,
  participants: ReturnType<TournamentService["participantRecords"]>,
): string {
  if (participants.length === 0) {
    return `${tournamentName} has no participants yet.`;
  }

  const visibleParticipants = participants.slice(0, tournamentParticipantListLimit);
  const hiddenCount = participants.length - visibleParticipants.length;

  return [
    `${tournamentName} participants (${participants.length}):`,
    ...visibleParticipants.map((participant, index) => `${index + 1}. ${participant.displayName}`),
    ...(hiddenCount > 0 ? [`...and ${hiddenCount} more participant(s).`] : []),
  ].join("\n");
}

export function tournamentSignupPostReply(input: {
  id: number;
  name: string;
  format: string;
  prefix?: string;
  seededCount?: number;
}): CommandReplyLike {
  const seededText = input.seededCount
    ? ` Seeded ${input.seededCount} participant(s).`
    : "";
  const prefix = input.prefix ?? "";

  return {
    content: `${prefix}Signups are open for ${input.name} (${input.format}).${seededText} Click Join Tournament to enter.`,
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`join_tournament:${input.id}`)
          .setLabel("Join Tournament")
          .setStyle(ButtonStyle.Primary),
      ),
    ],
  };
}

export function draftSignupPostReply(input: { id: number; name: string }): CommandReplyLike {
  return {
    content: `Signups are open for ${input.name}. Click Join Draft to enter.`,
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`join_draft:${input.id}`)
          .setLabel("Join Draft")
          .setStyle(ButtonStyle.Primary),
      ),
    ],
  };
}

async function handleDuel(
  interaction: CommandInteractionLike,
  deps: CommandDependencies,
): Promise<void> {
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

async function handleApprove(
  interaction: CommandInteractionLike,
  deps: CommandDependencies,
): Promise<void> {
  const guildId = requireGuildId(interaction);
  const player = deps.players.upsert(guildId, interaction.user.id, displayName(interaction.user));
  const match = deps.matches.latestPendingForOpponent(player.id);

  if (!match) {
    await interaction.reply("You have no pending duel reports to approve.");
    return;
  }

  deps.matches.approve(match.id, player.id);
  await interaction.reply(`Approved match #${match.id}.`);
}

async function handleDeny(
  interaction: CommandInteractionLike,
  deps: CommandDependencies,
): Promise<void> {
  const guildId = requireGuildId(interaction);
  const player = deps.players.upsert(guildId, interaction.user.id, displayName(interaction.user));
  const match = deps.matches.latestPendingForOpponent(player.id);

  if (!match) {
    await interaction.reply("You have no pending duel reports to deny.");
    return;
  }

  deps.matches.deny(match.id, player.id);
  await interaction.reply(`Denied match #${match.id}.`);
}

async function handleStats(
  interaction: CommandInteractionLike,
  deps: CommandDependencies,
): Promise<void> {
  const guildId = requireGuildId(interaction);
  const targetUser = interaction.options.getUser("player") ?? interaction.user;
  const player = deps.players.upsert(guildId, targetUser.id, displayName(targetUser));
  const tournamentName = interaction.options.getString("tournament");

  if (tournamentName) {
    const tournament = requireTournament(deps, guildId, tournamentName);
    const stats = deps.tournaments.stats(tournament.id, player.id);

    await interaction.reply(formatStats(`${player.displayName} in ${tournament.name}`, stats));
    return;
  }

  const activeTournaments = deps.tournaments.activeForPlayer(guildId, player.id);

  if (activeTournaments.length === 1) {
    const tournament = activeTournaments[0];
    const stats = deps.tournaments.stats(tournament.id, player.id);

    await interaction.reply(formatStats(`${player.displayName} in ${tournament.name}`, stats));
    return;
  }

  if (activeTournaments.length > 1) {
    await interaction.reply(
      `${player.displayName} is in multiple active tournaments. Specify one with tournament: ${activeTournaments.map((tournament) => tournament.name).join(", ")}`,
    );
    return;
  }

  const stats = deps.matches.stats(player.id);

  await interaction.reply(formatStats(player.displayName, stats));
}

async function handleRankings(
  interaction: CommandInteractionLike,
  deps: CommandDependencies,
): Promise<void> {
  const guildId = requireGuildId(interaction);
  const rows = deps.matches.leaderboard(guildId);

  await interaction.reply(formatLeaderboard(rows));
}

async function handleHelp(interaction: CommandInteractionLike): Promise<void> {
  await interaction.reply(helpMessage);
}

async function handleEvent(
  interaction: CommandInteractionLike,
  deps: CommandDependencies,
): Promise<void> {
  const guildId = requireGuildId(interaction);
  const subcommand = interaction.options.getSubcommand();

  switch (subcommand) {
    case "create": {
      const name = requireStringOption(interaction, "name");
      const format = requireStringOption(interaction, "format") as TournamentFormat;
      const tournament = deps.tournaments.create(guildId, name, format, interaction.user.id);
      const seededUserIds = new Set<string>();

      for (const optionName of playerSeedOptionNames) {
        const user = interaction.options.getUser(optionName);

        if (!user || seededUserIds.has(user.id)) {
          continue;
        }

        seededUserIds.add(user.id);
        const player = deps.players.upsert(guildId, user.id, displayName(user));
        deps.tournaments.join(tournament.id, player.id);
      }

      const seededCount = seededUserIds.size;

      await interaction.reply(tournamentSignupPostReply({ ...tournament, seededCount }));
      return;
    }
    case "join": {
      const name = requireStringOption(interaction, "name");
      const tournament = requireTournament(deps, guildId, name);
      const player = deps.players.upsert(guildId, interaction.user.id, displayName(interaction.user));
      deps.tournaments.join(tournament.id, player.id);
      await interaction.reply(`Joined event: ${tournament.name}.`);
      return;
    }
    case "list": {
      const active = deps.tournaments.listByStatus(guildId, ["active"]);
      const pending = deps.tournaments.listByStatus(guildId, ["pending"]);
      await interaction.reply(formatTournamentList(active, pending, deps));
      return;
    }
    case "dashboard": {
      await interaction.reply(tournamentDashboardReply());
      return;
    }
    case "signup": {
      const name = requireStringOption(interaction, "name");
      const tournament = requireTournament(deps, guildId, name);
      const role = interaction.options.getRole("role");
      const roleMention = role ? `<@&${role.id}> ` : "";

      requireEventCreator(tournament, interaction.user.id);
      assertPendingTournament(tournament);
      await interaction.reply(tournamentSignupPostReply({ ...tournament, prefix: roleMention }));
      return;
    }
    case "start": {
      const name = requireStringOption(interaction, "name");
      const tournament = requireTournament(deps, guildId, name);
      requireEventCreator(tournament, interaction.user.id);
      deps.tournaments.start(tournament.id);
      await interaction.reply(`Started event: ${tournament.name}.`);
      return;
    }
    case "show": {
      const name = requireStringOption(interaction, "name");
      const tournament = requireTournament(deps, guildId, name);
      const openMatches = deps.tournaments.openMatches(tournament.id);
      await interaction.reply(`${tournament.name}: ${openMatches.length} open match(es).`);
      return;
    }
    case "participants": {
      const name = requireStringOption(interaction, "name");
      const tournament = requireTournament(deps, guildId, name);
      const participants = deps.tournaments.participantRecords(tournament.id);
      await interaction.reply(formatTournamentParticipants(tournament.name, participants));
      return;
    }
    case "report": {
      const name = requireStringOption(interaction, "name");
      const tournament = requireTournament(deps, guildId, name);
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
    case "cancel": {
      const name = requireStringOption(interaction, "name");
      const tournament = requireTournament(deps, guildId, name);
      requireEventCreator(tournament, interaction.user.id);
      deps.tournaments.cancel(tournament.id);
      await interaction.reply(`Cancelled event: ${tournament.name}.`);
      return;
    }
    default:
      throw new Error(`Unsupported event subcommand: ${subcommand}`);
  }
}

async function handleDraft(
  interaction: CommandInteractionLike,
  deps: CommandDependencies,
): Promise<void> {
  const guildId = requireGuildId(interaction);

  switch (interaction.options.getSubcommand()) {
    case "dashboard":
      await interaction.reply(draftDashboardReply());
      return;
    case "join": {
      const name = requireStringOption(interaction, "name");
      const draft = requireDraft(deps, guildId, name);
      const player = deps.players.upsert(guildId, interaction.user.id, displayName(interaction.user));
      deps.drafts.join(draft.id, player.id);
      await interaction.reply(`Joined draft: ${draft.name}.`);
      return;
    }
    case "start": {
      const name = requireStringOption(interaction, "name");
      const draft = requireDraft(deps, guildId, name);
      requireDraftCreator(draft, interaction.user.id);
      const startedDraft = deps.drafts.start(draft.id);

      for (const draftPlayer of deps.drafts.players(startedDraft.id)) {
        const matchingPlayer = deps.players.findById(draftPlayer.playerId);

        if (!matchingPlayer || matchingPlayer.guildId !== guildId) {
          continue;
        }

        await deps.notifier.sendPickPrompt({
          channelId: startedDraft.channelId,
          userId: matchingPlayer.discordUserId,
          draftId: startedDraft.id,
          draftName: startedDraft.name,
        });
      }

      await interaction.reply(`Started draft: ${startedDraft.name}.`);
      return;
    }
    case "export": {
      const name = requireStringOption(interaction, "name");
      const draft = requireDraft(deps, guildId, name);
      const player = deps.players.upsert(guildId, interaction.user.id, displayName(interaction.user));
      const ydk = deps.drafts.exportYdk(draft.id, player.id);
      const safeName = draft.name.replace(/[^a-zA-Z0-9]/g, "-");

      await interaction.reply({
        content: `Exported ${draft.name}.`,
        ephemeral: true,
        files: [{ attachment: Buffer.from(ydk, "utf8"), name: `${safeName}.ydk` }],
      });
      return;
    }
    default:
      throw new Error(`Unsupported draft subcommand: ${interaction.options.getSubcommand()}`);
  }
}

export async function handleCommand(
  interaction: CommandInteractionLike,
  deps: CommandDependencies,
): Promise<void> {
  switch (interaction.commandName) {
    case "duel":
      await handleDuel(interaction, deps);
      return;
    case "approve":
      await handleApprove(interaction, deps);
      return;
    case "deny":
      await handleDeny(interaction, deps);
      return;
    case "stats":
      await handleStats(interaction, deps);
      return;
    case "rankings":
      await handleRankings(interaction, deps);
      return;
    case "event":
      await handleEvent(interaction, deps);
      return;
    case "draft":
      await handleDraft(interaction, deps);
      return;
    case "help":
      await handleHelp(interaction);
      return;
    default:
      throw new Error(`Unsupported command: ${interaction.commandName}`);
  }
}
