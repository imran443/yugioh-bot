import { ApplicationCommandOptionType, type APIApplicationCommandOption } from "discord.js";
import { describe, expect, it } from "vitest";
import { commandDefinitions } from "../../src/commands/definitions.js";

function isSubcommandOption(option: APIApplicationCommandOption) {
  return option.type === ApplicationCommandOptionType.Subcommand;
}

function isUserOption(option: APIApplicationCommandOption) {
  return option.type === ApplicationCommandOptionType.User;
}

function isStringOption(option: APIApplicationCommandOption) {
  return option.type === ApplicationCommandOptionType.String;
}

function stringOptionFor(
  subcommand: Extract<
    APIApplicationCommandOption,
    { type: ApplicationCommandOptionType.Subcommand }
  >,
  name: string,
) {
  const option = (subcommand.options ?? []).find((candidate) => candidate.name === name)!;

  if (!isStringOption(option)) {
    throw new Error(`${subcommand.name} ${name} option must be a string option`);
  }

  return option;
}

function isRoleOption(option: APIApplicationCommandOption) {
  return option.type === ApplicationCommandOptionType.Role;
}

describe("command definitions", () => {
  it("uses the approved simple command names", () => {
    expect(commandDefinitions.map((command) => command.name)).toEqual([
      "duel",
      "approve",
      "deny",
      "stats",
      "rankings",
      "event",
      "help",
    ]);
  });

  it("defines optional player seed options for event create", () => {
    const eventCommand = commandDefinitions.find((command) => command.name === "event")!;
    const createSubcommand = eventCommand.options
      ?.filter(isSubcommandOption)
      .find((option) => option.name === "create")!;
    const seedOptions = (createSubcommand.options ?? [])
      .filter(isUserOption)
      .filter((option) => option.name.startsWith("player"));

    expect(seedOptions?.map((option) => option.name)).toEqual([
      "player1",
      "player2",
      "player3",
      "player4",
      "player5",
      "player6",
      "player7",
      "player8",
    ]);
    expect(seedOptions?.every((option) => option.required === false)).toBe(true);
  });

  it("defines event list and signup subcommands", () => {
    const eventCommand = commandDefinitions.find((command) => command.name === "event")!;
    const subcommands = eventCommand.options?.filter(isSubcommandOption) ?? [];
    const listSubcommand = subcommands.find((option) => option.name === "list")!;
    const signupSubcommand = subcommands.find((option) => option.name === "signup")!;
    const signupOptions = signupSubcommand.options ?? [];
    const nameOption = signupOptions.find((option) => option.name === "name")!;
    const roleOption = signupOptions.find((option) => option.name === "role")!;

    expect(listSubcommand.options ?? []).toEqual([]);
    expect(isStringOption(nameOption)).toBe(true);
    if (!isStringOption(nameOption)) {
      throw new Error("signup name option must be a string option");
    }
    expect(nameOption.required).toBe(true);
    expect(nameOption.autocomplete).toBe(true);
    expect(isRoleOption(roleOption)).toBe(true);
    expect(roleOption.required).toBe(false);
  });

  it("enables autocomplete on tournament name options", () => {
    const eventCommand = commandDefinitions.find((command) => command.name === "event")!;
    const subcommands = eventCommand.options?.filter(isSubcommandOption) ?? [];

    for (const name of ["start", "signup", "show", "report", "cancel"]) {
      const subcommand = subcommands.find((option) => option.name === name)!;
      const nameOption = stringOptionFor(subcommand, "name");

      expect(nameOption.required).toBe(true);
      expect(nameOption.autocomplete).toBe(true);
    }
  });

  it("defines an optional stats tournament autocomplete option", () => {
    const statsCommand = commandDefinitions.find((command) => command.name === "stats")!;
    const tournamentOption = (statsCommand.options ?? []).find(
      (option) => option.name === "tournament",
    )!;

    expect(isStringOption(tournamentOption)).toBe(true);
    if (!isStringOption(tournamentOption)) {
      throw new Error("stats tournament option must be a string option");
    }
    expect(tournamentOption.required).toBe(false);
    expect(tournamentOption.autocomplete).toBe(true);
  });
});
