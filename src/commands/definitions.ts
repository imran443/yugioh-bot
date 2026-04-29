import { SlashCommandBuilder } from "discord.js";

const playerSeedOptions = Array.from({ length: 8 }, (_, index) => `player${index + 1}`);

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
        )
        .addUserOption((option) =>
          option.setName(playerSeedOptions[0]).setDescription("Seeded player 1").setRequired(false),
        )
        .addUserOption((option) =>
          option.setName(playerSeedOptions[1]).setDescription("Seeded player 2").setRequired(false),
        )
        .addUserOption((option) =>
          option.setName(playerSeedOptions[2]).setDescription("Seeded player 3").setRequired(false),
        )
        .addUserOption((option) =>
          option.setName(playerSeedOptions[3]).setDescription("Seeded player 4").setRequired(false),
        )
        .addUserOption((option) =>
          option.setName(playerSeedOptions[4]).setDescription("Seeded player 5").setRequired(false),
        )
        .addUserOption((option) =>
          option.setName(playerSeedOptions[5]).setDescription("Seeded player 6").setRequired(false),
        )
        .addUserOption((option) =>
          option.setName(playerSeedOptions[6]).setDescription("Seeded player 7").setRequired(false),
        )
        .addUserOption((option) =>
          option.setName(playerSeedOptions[7]).setDescription("Seeded player 8").setRequired(false),
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
    .addSubcommand((subcommand) => subcommand.setName("list").setDescription("List events"))
    .addSubcommand((subcommand) =>
      subcommand
        .setName("signup")
        .setDescription("Post tournament signup")
        .addStringOption((option) =>
          option
            .setName("name")
            .setDescription("Tournament name")
            .setRequired(true)
            .setAutocomplete(true),
        )
        .addRoleOption((option) =>
          option.setName("role").setDescription("Role to notify").setRequired(false),
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
