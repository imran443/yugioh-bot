import { SlashCommandBuilder } from "discord.js";

const maxTournamentNameLength = 100;
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
    )
    .addStringOption((option) =>
      option
        .setName("tournament")
        .setDescription("Tournament to show stats for")
        .setRequired(false)
        .setMaxLength(maxTournamentNameLength)
        .setAutocomplete(true),
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
          option
            .setName("name")
            .setDescription("Tournament name")
            .setRequired(true)
            .setMaxLength(maxTournamentNameLength),
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
          option
            .setName("name")
            .setDescription("Tournament name")
            .setRequired(true)
            .setMaxLength(maxTournamentNameLength),
        ),
    )
    .addSubcommand((subcommand) => subcommand.setName("list").setDescription("List events"))
    .addSubcommand((subcommand) =>
      subcommand.setName("dashboard").setDescription("Open your private tournament dashboard"),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("signup")
        .setDescription("Post tournament signup")
        .addStringOption((option) =>
          option
            .setName("name")
            .setDescription("Tournament name")
            .setRequired(true)
            .setMaxLength(maxTournamentNameLength)
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
          option
            .setName("name")
            .setDescription("Tournament name")
            .setRequired(true)
            .setMaxLength(maxTournamentNameLength)
            .setAutocomplete(true),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("show")
        .setDescription("Show a tournament")
        .addStringOption((option) =>
          option
            .setName("name")
            .setDescription("Tournament name")
            .setRequired(true)
            .setMaxLength(maxTournamentNameLength)
            .setAutocomplete(true),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("participants")
        .setDescription("List tournament participants")
        .addStringOption((option) =>
          option
            .setName("name")
            .setDescription("Tournament name")
            .setRequired(true)
            .setMaxLength(maxTournamentNameLength)
            .setAutocomplete(true),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("report")
        .setDescription("Report a tournament match")
        .addStringOption((option) =>
          option
            .setName("name")
            .setDescription("Tournament name")
            .setRequired(true)
            .setMaxLength(maxTournamentNameLength)
            .setAutocomplete(true),
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
          option
            .setName("name")
            .setDescription("Tournament name")
            .setRequired(true)
            .setMaxLength(maxTournamentNameLength)
            .setAutocomplete(true),
      ),
    ),
  new SlashCommandBuilder()
    .setName("draft")
    .setDescription("Manage drafts")
    .addSubcommand((subcommand) =>
      subcommand.setName("dashboard").setDescription("Open your private draft dashboard"),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("create")
        .setDescription("Create a new draft")
        .addStringOption((option) =>
          option
            .setName("name")
            .setDescription("Draft name")
            .setRequired(true)
            .setMaxLength(maxTournamentNameLength),
        )
        .addStringOption((option) =>
          option
            .setName("sets")
            .setDescription("Card sets (comma-separated)")
            .setRequired(false)
            .setMaxLength(500)
            .setAutocomplete(true),
        )
        .addStringOption((option) =>
          option
            .setName("includes")
            .setDescription("Cards to include")
            .setRequired(false)
            .setMaxLength(500),
        )
        .addStringOption((option) =>
          option
            .setName("excludes")
            .setDescription("Cards to exclude")
            .setRequired(false)
            .setMaxLength(500),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("join")
        .setDescription("Join a draft")
        .addStringOption((option) =>
          option
            .setName("name")
            .setDescription("Draft name")
            .setRequired(true)
            .setMaxLength(maxTournamentNameLength)
            .setAutocomplete(true),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("start")
        .setDescription("Start a draft")
        .addStringOption((option) =>
          option
            .setName("name")
            .setDescription("Draft name")
            .setRequired(true)
            .setMaxLength(maxTournamentNameLength)
            .setAutocomplete(true),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("export")
        .setDescription("Export your completed draft deck")
        .addStringOption((option) =>
          option
            .setName("name")
            .setDescription("Draft name")
            .setRequired(true)
            .setMaxLength(maxTournamentNameLength)
            .setAutocomplete(true),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("cancel")
        .setDescription("Cancel a draft")
        .addStringOption((option) =>
          option
            .setName("name")
            .setDescription("Draft name")
            .setRequired(true)
            .setMaxLength(maxTournamentNameLength)
            .setAutocomplete(true),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("sets")
        .setDescription("List available card sets")
        .addStringOption((option) =>
          option
            .setName("query")
            .setDescription("Search for a set")
            .setRequired(false)
            .setMaxLength(100)
            .setAutocomplete(true),
        ),
    )
    .addSubcommandGroup((group) =>
      group
        .setName("template")
        .setDescription("Manage draft templates")
        .addSubcommand((subcommand) =>
          subcommand
            .setName("save")
            .setDescription("Save a draft config as a template")
            .addStringOption((option) =>
              option
                .setName("name")
                .setDescription("Template name")
                .setRequired(true)
                .setMaxLength(maxTournamentNameLength),
            )
            .addStringOption((option) =>
              option
                .setName("draft")
                .setDescription("Draft to save from")
                .setRequired(true)
                .setMaxLength(maxTournamentNameLength)
                .setAutocomplete(true),
            ),
        )
        .addSubcommand((subcommand) => subcommand.setName("list").setDescription("List your draft templates"))
        .addSubcommand((subcommand) =>
          subcommand
            .setName("delete")
            .setDescription("Delete a draft template")
            .addStringOption((option) =>
              option
                .setName("name")
                .setDescription("Template name")
                .setRequired(true)
                .setMaxLength(maxTournamentNameLength)
                .setAutocomplete(true),
            ),
        ),
    ),
  new SlashCommandBuilder().setName("help").setDescription("Show available commands"),
].map((command) => command.toJSON());
