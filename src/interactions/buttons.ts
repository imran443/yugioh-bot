import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  type InteractionReplyOptions,
} from "discord.js";
import { formatStats } from "../formatters/stats.js";
import type { DiscordUserLike } from "../commands/handlers.js";
import type { PlayerRepository } from "../repositories/players.js";
import type { MatchService } from "../services/matches.js";
import type { Tournament, TournamentMatch, TournamentService } from "../services/tournaments.js";

export type ButtonInteractionLike = {
  customId: string;
  guildId: string | null;
  user: DiscordUserLike;
  reply(
    message: { content: string; ephemeral: boolean; components?: InteractionReplyOptions["components"] },
  ): Promise<void> | void;
};

type ButtonDependencies = {
  matches: MatchService;
  players: PlayerRepository;
  tournaments: TournamentService;
};

const dashboardEventListLimit = 10;
const creatorToolEventLimit = 5;

function requireGuildId(interaction: ButtonInteractionLike): string {
  if (!interaction.guildId) {
    throw new Error("This interaction can only be used in a server");
  }

  return interaction.guildId;
}

function displayName(user: DiscordUserLike): string {
  return user.displayName ?? user.username;
}

function requireEventCreator(tournament: { createdByUserId: string }, userId: string): void {
  if (tournament.createdByUserId !== userId) {
    throw new Error("Only the event creator can do that");
  }
}

function openEventsReply(tournaments: ReturnType<TournamentService["listByStatus"]>) {
  if (tournaments.length === 0) {
    return { content: "No open events right now.", ephemeral: true };
  }

  const visibleTournaments = tournaments.slice(0, 5);
  const hiddenCount = tournaments.length - visibleTournaments.length;

  return {
    content: [
      "Open events:",
      ...visibleTournaments.map((tournament) => `- ${tournament.name} (${tournament.format})`),
      ...(hiddenCount > 0 ? [`...and ${hiddenCount} more event(s).`] : []),
    ].join("\n"),
    ephemeral: true,
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        ...visibleTournaments.map((tournament) =>
          new ButtonBuilder()
            .setCustomId(`join_tournament:${tournament.id}`)
            .setLabel(`Join ${tournament.name}`.slice(0, 80))
            .setStyle(ButtonStyle.Primary),
        ),
      ),
    ],
  };
}

function participantNameById(deps: ButtonDependencies, tournamentId: number, playerId: number): string {
  return (
    deps.tournaments
      .participantRecords(tournamentId)
      .find((participant) => participant.playerId === playerId)?.displayName ?? `Player ${playerId}`
  );
}

function opponentIdFor(match: TournamentMatch, playerId: number): number {
  if (match.playerOneId === playerId && match.playerTwoId !== null) {
    return match.playerTwoId;
  }

  if (match.playerTwoId === playerId) {
    return match.playerOneId;
  }

  throw new Error("You are not in this tournament match");
}

function resultButtonsReply(match: TournamentMatch, opponentName: string) {
  return {
    content: `Report your match against ${opponentName}. What was your result?`,
    ephemeral: true,
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`dashboard_report_result:${match.id}:win`)
          .setLabel("I Won")
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(`dashboard_report_result:${match.id}:loss`)
          .setLabel("I Lost")
          .setStyle(ButtonStyle.Danger),
      ),
    ],
  };
}

function reportMatchChoicesReply(deps: ButtonDependencies, tournament: Tournament, playerId: number) {
  const openMatches = deps.tournaments.openMatchesForPlayer(tournament.id, playerId).slice(0, 5);

  if (openMatches.length === 0) {
    return { content: "You have no open matches to report in this tournament.", ephemeral: true };
  }

  return {
    content: [
      `Choose a match to report for ${tournament.name}:`,
      ...openMatches.map((match) => {
        const opponentId = opponentIdFor(match, playerId);
        return `- Round ${match.roundNumber}: ${participantNameById(deps, tournament.id, opponentId)}`;
      }),
    ].join("\n"),
    ephemeral: true,
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        ...openMatches.map((match) => {
          const opponentId = opponentIdFor(match, playerId);
          return new ButtonBuilder()
            .setCustomId(`dashboard_report_match:${match.id}`)
            .setLabel(participantNameById(deps, tournament.id, opponentId).slice(0, 80))
            .setStyle(ButtonStyle.Primary);
        }),
      ),
    ],
  };
}

function myEventsReply(tournaments: ReturnType<TournamentService["forPlayer"]>) {
  if (tournaments.length === 0) {
    return { content: "You are not in any pending or active events.", ephemeral: true };
  }

  const visibleTournaments = tournaments.slice(0, dashboardEventListLimit);
  const hiddenCount = tournaments.length - visibleTournaments.length;

  return {
    content: [
      "Your events:",
      ...visibleTournaments.map((tournament) =>
        `- ${tournament.name} (${tournament.status}, ${tournament.format})`,
      ),
      ...(hiddenCount > 0 ? [`...and ${hiddenCount} more event(s).`] : []),
    ].join("\n"),
    ephemeral: true,
  };
}

function creatorEventActionsReply(tournament: Tournament) {
  return {
    content: [
      `Creator tools: ${tournament.name}`,
      "Use /event signup name:<name> to post a public signup message.",
    ].join("\n"),
    ephemeral: true,
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`dashboard_start:${tournament.id}`)
          .setLabel(`Start ${tournament.name}`.slice(0, 80))
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(`dashboard_cancel:${tournament.id}`)
          .setLabel(`Cancel ${tournament.name}`.slice(0, 80))
          .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
          .setCustomId(`dashboard_participants:${tournament.id}`)
          .setLabel("Participants")
          .setStyle(ButtonStyle.Secondary),
      ),
    ],
  };
}

function creatorEventChoicesReply(tournaments: Tournament[], offset = 0) {
  const safeOffset = Math.max(0, Math.min(offset, Math.max(tournaments.length - 1, 0)));
  const visibleTournaments = tournaments.slice(safeOffset, safeOffset + creatorToolEventLimit);
  const hiddenBeforeCount = safeOffset;
  const hiddenAfterCount = tournaments.length - safeOffset - visibleTournaments.length;
  const components = [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      ...visibleTournaments.map((tournament) =>
        new ButtonBuilder()
          .setCustomId(`dashboard_creator_event:${tournament.id}`)
          .setLabel(tournament.name.slice(0, 80))
          .setStyle(ButtonStyle.Primary),
      ),
    ),
  ];

  if (hiddenBeforeCount > 0 || hiddenAfterCount > 0) {
    const pagingButtons = new ActionRowBuilder<ButtonBuilder>();

    if (hiddenBeforeCount > 0) {
      pagingButtons.addComponents(
        new ButtonBuilder()
          .setCustomId(`dashboard_creator_tools_page:${Math.max(safeOffset - creatorToolEventLimit, 0)}`)
          .setLabel("Previous")
          .setStyle(ButtonStyle.Secondary),
      );
    }

    if (hiddenAfterCount > 0) {
      pagingButtons.addComponents(
        new ButtonBuilder()
          .setCustomId(`dashboard_creator_tools_page:${safeOffset + creatorToolEventLimit}`)
          .setLabel("Next")
          .setStyle(ButtonStyle.Secondary),
      );
    }

    components.push(pagingButtons);
  }

  return {
    content: [
      "Choose an event to manage:",
      ...visibleTournaments.map((tournament) => `- ${tournament.name} (${tournament.status}, ${tournament.format})`),
      ...(hiddenAfterCount > 0 ? [`...and ${hiddenAfterCount} more event(s).`] : []),
    ].join("\n"),
    ephemeral: true,
    components,
  };
}

async function handleJoinTournament(
  interaction: ButtonInteractionLike,
  deps: ButtonDependencies,
  tournamentId: number,
): Promise<void> {
  const guildId = requireGuildId(interaction);
  const tournament = deps.tournaments.findById(tournamentId);

  if (tournament.guildId !== guildId) {
    throw new Error("Tournament not found in this server");
  }

  const player = deps.players.upsert(guildId, interaction.user.id, displayName(interaction.user));

  deps.tournaments.join(tournament.id, player.id);
  await interaction.reply({ content: `Joined event: ${tournament.name}.`, ephemeral: true });
}

async function handleReportResult(
  interaction: ButtonInteractionLike,
  deps: ButtonDependencies,
  tournamentMatchId: number,
  result: string,
): Promise<void> {
  const guildId = requireGuildId(interaction);
  const player = deps.players.upsert(guildId, interaction.user.id, displayName(interaction.user));
  const tournamentMatch = deps.tournaments.findTournamentMatchById(tournamentMatchId);
  const tournament = deps.tournaments.findById(tournamentMatch.tournamentId);

  if (tournament.guildId !== guildId) {
    throw new Error("Tournament not found in this server");
  }

  const opponentId = opponentIdFor(tournamentMatch, player.id);
  const winnerId = result === "win" ? player.id : opponentId;
  const match = deps.tournaments.reportTournamentMatch(tournamentMatch.id, player.id, winnerId);

  await interaction.reply({
    content: `Match reported as ${result}. Your opponent must approve or deny it. Match #${match.id}`,
    ephemeral: true,
  });
}

export async function handleButton(
  interaction: ButtonInteractionLike,
  deps: ButtonDependencies,
): Promise<void> {
  const joinMatch = /^join_tournament:(\d+)$/.exec(interaction.customId);

  if (joinMatch) {
    await handleJoinTournament(interaction, deps, Number(joinMatch[1]));
    return;
  }

  if (interaction.customId === "dashboard_create_event") {
    await interaction.reply({
      content: "Choose a tournament format:",
      ephemeral: true,
      components: [
        new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId("dashboard_create_event_format")
            .setPlaceholder("Select tournament format")
            .addOptions(
              { label: "Round Robin", value: "round_robin" },
              { label: "Single Elimination", value: "single_elim" },
            ),
        ),
      ],
    });
    return;
  }

  if (interaction.customId === "dashboard_help") {
    await interaction.reply({
      content: [
        "Tournament commands:",
        "- Open this dashboard: /event dashboard",
        "- Create an event: /event create",
        "- Join from dashboard: Open Events > Join",
        "- Report from dashboard: Report Match",
        "- Approve or deny from dashboard: Approvals",
      ].join("\n"),
      ephemeral: true,
    });
    return;
  }

  if (interaction.customId === "dashboard_open_events") {
    const guildId = requireGuildId(interaction);
    await interaction.reply(openEventsReply(deps.tournaments.listByStatus(guildId, ["pending"])));
    return;
  }

  if (interaction.customId === "dashboard_my_events") {
    const guildId = requireGuildId(interaction);
    const player = deps.players.upsert(guildId, interaction.user.id, displayName(interaction.user));
    const tournaments = deps.tournaments.forPlayer(guildId, player.id);

    await interaction.reply(myEventsReply(tournaments));
    return;
  }

  if (interaction.customId === "dashboard_stats") {
    const guildId = requireGuildId(interaction);
    const player = deps.players.upsert(guildId, interaction.user.id, displayName(interaction.user));
    const activeTournaments = deps.tournaments.activeForPlayer(guildId, player.id);

    if (activeTournaments.length === 1) {
      const tournament = activeTournaments[0];
      await interaction.reply({
        content: formatStats(
          `${player.displayName} in ${tournament.name}`,
          deps.tournaments.stats(tournament.id, player.id),
        ),
        ephemeral: true,
      });
      return;
    }

    await interaction.reply({ content: formatStats(player.displayName, deps.matches.stats(player.id)), ephemeral: true });
    return;
  }

  if (interaction.customId === "dashboard_report_match") {
    const guildId = requireGuildId(interaction);
    const player = deps.players.upsert(guildId, interaction.user.id, displayName(interaction.user));
    const activeTournaments = deps.tournaments.activeForPlayer(guildId, player.id);

    if (activeTournaments.length === 0) {
      await interaction.reply({
        content: "You are not in any active tournaments with matches to report.",
        ephemeral: true,
      });
      return;
    }

    if (activeTournaments.length > 1) {
      await interaction.reply({
        content: "Choose a tournament to report from:",
        ephemeral: true,
        components: [
          new ActionRowBuilder<ButtonBuilder>().addComponents(
            ...activeTournaments.slice(0, 5).map((tournament) =>
              new ButtonBuilder()
                .setCustomId(`dashboard_report_tournament:${tournament.id}`)
                .setLabel(tournament.name.slice(0, 80))
                .setStyle(ButtonStyle.Primary),
            ),
          ),
        ],
      });
      return;
    }

    await interaction.reply(reportMatchChoicesReply(deps, activeTournaments[0], player.id));
    return;
  }

  const reportTournamentMatch = /^dashboard_report_tournament:(\d+)$/.exec(interaction.customId);

  if (reportTournamentMatch) {
    const guildId = requireGuildId(interaction);
    const player = deps.players.upsert(guildId, interaction.user.id, displayName(interaction.user));
    const tournament = deps.tournaments.findById(Number(reportTournamentMatch[1]));

    if (tournament.guildId !== guildId) {
      throw new Error("Tournament not found in this server");
    }

    await interaction.reply(reportMatchChoicesReply(deps, tournament, player.id));
    return;
  }

  const reportMatch = /^dashboard_report_match:(\d+)$/.exec(interaction.customId);

  if (reportMatch) {
    const guildId = requireGuildId(interaction);
    const player = deps.players.upsert(guildId, interaction.user.id, displayName(interaction.user));
    const tournamentMatch = deps.tournaments.findTournamentMatchById(Number(reportMatch[1]));
    const tournament = deps.tournaments.findById(tournamentMatch.tournamentId);

    if (tournament.guildId !== guildId) {
      throw new Error("Tournament not found in this server");
    }

    const opponentId = opponentIdFor(tournamentMatch, player.id);
    await interaction.reply(
      resultButtonsReply(tournamentMatch, participantNameById(deps, tournament.id, opponentId)),
    );
    return;
  }

  const reportResult = /^dashboard_report_result:(\d+):(win|loss)$/.exec(interaction.customId);

  if (reportResult) {
    await handleReportResult(interaction, deps, Number(reportResult[1]), reportResult[2]);
    return;
  }

  if (interaction.customId === "dashboard_pending_approvals") {
    const guildId = requireGuildId(interaction);
    const player = deps.players.upsert(guildId, interaction.user.id, displayName(interaction.user));
    const match = deps.matches.latestPendingForOpponent(player.id);

    if (!match) {
      await interaction.reply({ content: "You have no pending approvals.", ephemeral: true });
      return;
    }

    await interaction.reply({
      content: `Match #${match.id} is waiting for your approval.`,
      ephemeral: true,
      components: [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId(`dashboard_approve:${match.id}`)
            .setLabel("Approve")
            .setStyle(ButtonStyle.Success),
          new ButtonBuilder()
            .setCustomId(`dashboard_deny:${match.id}`)
            .setLabel("Deny")
            .setStyle(ButtonStyle.Danger),
        ),
      ],
    });
    return;
  }

  const approveMatch = /^dashboard_approve:(\d+)$/.exec(interaction.customId);

  if (approveMatch) {
    const guildId = requireGuildId(interaction);
    const player = deps.players.upsert(guildId, interaction.user.id, displayName(interaction.user));
    const match = deps.matches.approve(Number(approveMatch[1]), player.id);

    await interaction.reply({ content: `Approved match #${match.id}.`, ephemeral: true });
    return;
  }

  const denyMatch = /^dashboard_deny:(\d+)$/.exec(interaction.customId);

  if (denyMatch) {
    const guildId = requireGuildId(interaction);
    const player = deps.players.upsert(guildId, interaction.user.id, displayName(interaction.user));
    const match = deps.matches.deny(Number(denyMatch[1]), player.id);

    await interaction.reply({ content: `Denied match #${match.id}.`, ephemeral: true });
    return;
  }

  if (interaction.customId === "dashboard_creator_tools") {
    const guildId = requireGuildId(interaction);
    const tournaments = deps.tournaments.createdBy(guildId, interaction.user.id, ["pending", "active"]);

    if (tournaments.length === 0) {
      await interaction.reply({ content: "You have no pending or active events to manage.", ephemeral: true });
      return;
    }

    await interaction.reply(
      tournaments.length === 1 ? creatorEventActionsReply(tournaments[0]) : creatorEventChoicesReply(tournaments),
    );
    return;
  }

  const creatorToolsPage = /^dashboard_creator_tools_page:(\d+)$/.exec(interaction.customId);

  if (creatorToolsPage) {
    const guildId = requireGuildId(interaction);
    const tournaments = deps.tournaments.createdBy(guildId, interaction.user.id, ["pending", "active"]);

    if (tournaments.length === 0) {
      await interaction.reply({ content: "You have no pending or active events to manage.", ephemeral: true });
      return;
    }

    await interaction.reply(creatorEventChoicesReply(tournaments, Number(creatorToolsPage[1])));
    return;
  }

  const creatorEvent = /^dashboard_creator_event:(\d+)$/.exec(interaction.customId);

  if (creatorEvent) {
    const guildId = requireGuildId(interaction);
    const tournament = deps.tournaments.findById(Number(creatorEvent[1]));

    if (tournament.guildId !== guildId) {
      throw new Error("Tournament not found in this server");
    }

    requireEventCreator(tournament, interaction.user.id);
    await interaction.reply(creatorEventActionsReply(tournament));
    return;
  }

  const startTournament = /^dashboard_start:(\d+)$/.exec(interaction.customId);

  if (startTournament) {
    const guildId = requireGuildId(interaction);
    const tournament = deps.tournaments.findById(Number(startTournament[1]));

    if (tournament.guildId !== guildId) {
      throw new Error("Tournament not found in this server");
    }

    requireEventCreator(tournament, interaction.user.id);
    deps.tournaments.start(tournament.id);
    await interaction.reply({ content: `Started event: ${tournament.name}.`, ephemeral: true });
    return;
  }

  const cancelTournament = /^dashboard_cancel:(\d+)$/.exec(interaction.customId);

  if (cancelTournament) {
    const guildId = requireGuildId(interaction);
    const tournament = deps.tournaments.findById(Number(cancelTournament[1]));

    if (tournament.guildId !== guildId) {
      throw new Error("Tournament not found in this server");
    }

    requireEventCreator(tournament, interaction.user.id);
    deps.tournaments.cancel(tournament.id);
    await interaction.reply({ content: `Cancelled event: ${tournament.name}.`, ephemeral: true });
    return;
  }

  const participants = /^dashboard_participants:(\d+)$/.exec(interaction.customId);

  if (participants) {
    const guildId = requireGuildId(interaction);
    const tournament = deps.tournaments.findById(Number(participants[1]));

    if (tournament.guildId !== guildId) {
      throw new Error("Tournament not found in this server");
    }

    const participantRecords = deps.tournaments.participantRecords(tournament.id);
    await interaction.reply({
      content:
        participantRecords.length === 0
          ? `${tournament.name} has no participants yet.`
          : [
              `${tournament.name} participants (${participantRecords.length}):`,
              ...participantRecords.slice(0, 25).map((participant, index) => `${index + 1}. ${participant.displayName}`),
            ].join("\n"),
      ephemeral: true,
    });
    return;
  }

  throw new Error("Unsupported button interaction");
}
