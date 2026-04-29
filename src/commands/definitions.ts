import { SlashCommandBuilder } from "discord.js";

export const commandDefinitions = [
  new SlashCommandBuilder()
    .setName("duel")
    .setDescription("Report a Yugioh duel result")
    .addUserOption((option) =>
      option.setName("player").setDescription("The player you dueled").setRequired(true),
    )
    .addStringOption((option) =>
      option
        .setName("result")
        .setDescription("Your result")
        .setRequired(true)
        .addChoices({ name: "win", value: "win" }, { name: "loss", value: "loss" }),
    ),
  new SlashCommandBuilder()
    .setName("approve")
    .setDescription("Approve your latest pending duel report"),
  new SlashCommandBuilder().setName("deny").setDescription("Deny your latest pending duel report"),
  new SlashCommandBuilder()
    .setName("stats")
    .setDescription("Show player stats")
    .addUserOption((option) =>
      option.setName("player").setDescription("The player to show").setRequired(false),
    ),
  new SlashCommandBuilder().setName("rankings").setDescription("Show server rankings"),
  new SlashCommandBuilder()
    .setName("event")
    .setDescription("Manage tournaments")
    .addSubcommand((subcommand) =>
      subcommand
        .setName("create")
        .setDescription("Create a tournament")
        .addStringOption((option) =>
          option.setName("name").setDescription("Tournament name").setRequired(true),
        )
        .addStringOption((option) =>
          option
            .setName("format")
            .setDescription("Tournament format")
            .setRequired(true)
            .addChoices(
              { name: "round robin", value: "round_robin" },
              { name: "single elimination", value: "single_elim" },
            ),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("join")
        .setDescription("Join a tournament")
        .addStringOption((option) =>
          option.setName("name").setDescription("Tournament name").setRequired(true),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("start")
        .setDescription("Start a tournament")
        .addStringOption((option) =>
          option.setName("name").setDescription("Tournament name").setRequired(true),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("show")
        .setDescription("Show a tournament")
        .addStringOption((option) =>
          option.setName("name").setDescription("Tournament name").setRequired(true),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("report")
        .setDescription("Report a tournament match")
        .addStringOption((option) =>
          option.setName("name").setDescription("Tournament name").setRequired(true),
        )
        .addUserOption((option) =>
          option.setName("player").setDescription("The player you dueled").setRequired(true),
        )
        .addStringOption((option) =>
          option
            .setName("result")
            .setDescription("Your result")
            .setRequired(true)
            .addChoices({ name: "win", value: "win" }, { name: "loss", value: "loss" }),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("cancel")
        .setDescription("Cancel a tournament")
        .addStringOption((option) =>
          option.setName("name").setDescription("Tournament name").setRequired(true),
        ),
    ),
].map((command) => command.toJSON());
