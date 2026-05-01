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
      "draft",
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

  it("defines event list, dashboard, and signup subcommands", () => {
    const eventCommand = commandDefinitions.find((command) => command.name === "event")!;
    const subcommands = eventCommand.options?.filter(isSubcommandOption) ?? [];
    const listSubcommand = subcommands.find((option) => option.name === "list")!;
    const dashboardSubcommand = subcommands.find((option) => option.name === "dashboard")!;
    const signupSubcommand = subcommands.find((option) => option.name === "signup")!;
    const signupOptions = signupSubcommand.options ?? [];
    const nameOption = signupOptions.find((option) => option.name === "name")!;
    const roleOption = signupOptions.find((option) => option.name === "role")!;

    expect(listSubcommand.options ?? []).toEqual([]);
    expect(dashboardSubcommand.options ?? []).toEqual([]);
    expect(isStringOption(nameOption)).toBe(true);
    if (!isStringOption(nameOption)) {
      throw new Error("signup name option must be a string option");
    }
    expect(nameOption.required).toBe(true);
    expect(nameOption.autocomplete).toBe(true);
    expect(isRoleOption(roleOption)).toBe(true);
    expect(roleOption.required).toBe(false);
  });

  it("defines an event participants subcommand with tournament name autocomplete", () => {
    const eventCommand = commandDefinitions.find((command) => command.name === "event")!;
    const subcommands = eventCommand.options?.filter(isSubcommandOption) ?? [];
    const participantsSubcommand = subcommands.find((option) => option.name === "participants")!;
    const nameOption = stringOptionFor(participantsSubcommand, "name");

    expect(nameOption.required).toBe(true);
    expect(nameOption.max_length).toBe(100);
    expect(nameOption.autocomplete).toBe(true);
  });

  it("enables autocomplete on tournament name options", () => {
    const eventCommand = commandDefinitions.find((command) => command.name === "event")!;
    const subcommands = eventCommand.options?.filter(isSubcommandOption) ?? [];

    for (const name of ["start", "signup", "show", "participants", "report", "cancel"]) {
      const subcommand = subcommands.find((option) => option.name === name)!;
      const nameOption = stringOptionFor(subcommand, "name");

      expect(nameOption.required).toBe(true);
      expect(nameOption.autocomplete).toBe(true);
    }
  });

  it("caps tournament string options at Discord's choice value limit", () => {
    const eventCommand = commandDefinitions.find((command) => command.name === "event")!;
    const subcommands = eventCommand.options?.filter(isSubcommandOption) ?? [];

    for (const subcommandName of [
      "create",
      "join",
      "start",
      "signup",
      "show",
      "participants",
      "report",
      "cancel",
    ]) {
      const subcommand = subcommands.find((option) => option.name === subcommandName)!;
      const nameOption = stringOptionFor(subcommand, "name");

      expect(nameOption.max_length).toBe(100);
    }

    const statsCommand = commandDefinitions.find((command) => command.name === "stats")!;
    const tournamentOption = (statsCommand.options ?? []).find(
      (option) => option.name === "tournament",
    )!;

    expect(isStringOption(tournamentOption)).toBe(true);
    if (!isStringOption(tournamentOption)) {
      throw new Error("stats tournament option must be a string option");
    }
    expect(tournamentOption.max_length).toBe(100);
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

  it("defines draft dashboard, join, start, and export subcommands", () => {
    const draftCommand = commandDefinitions.find((command) => command.name === "draft")!;
    const subcommands = draftCommand.options?.filter(isSubcommandOption) ?? [];

    expect(subcommands.map((s) => s.name)).toEqual(["dashboard", "create", "join", "start", "export", "cancel", "sets"]);

    for (const subcommandName of ["join", "start", "export", "cancel"]) {
      const subcommand = subcommands.find((option) => option.name === subcommandName)!;
      const nameOption = stringOptionFor(subcommand, "name");

      expect(nameOption.required).toBe(true);
      expect(nameOption.max_length).toBe(100);
      expect(nameOption.autocomplete).toBe(true);
    }
  });

  it("defines draft template subcommand group with save, list, and delete", () => {
    const draftCommand = commandDefinitions.find((command) => command.name === "draft")!;
    const templateGroup = draftCommand.options?.find(
      (option): option is Extract<APIApplicationCommandOption, { type: ApplicationCommandOptionType.SubcommandGroup }> =>
        option.type === ApplicationCommandOptionType.SubcommandGroup && option.name === "template",
    )!;

    expect(templateGroup).toBeDefined();

    const templateSubcommands = (templateGroup.options ?? []).filter(isSubcommandOption);

    expect(templateSubcommands.map((s) => s.name)).toEqual(["save", "list", "delete"]);

    const saveSubcommand = templateSubcommands.find((s) => s.name === "save")!;
    const saveNameOption = stringOptionFor(saveSubcommand, "name");

    expect(saveNameOption.required).toBe(true);
    expect(saveNameOption.max_length).toBe(100);

    const saveDraftOption = stringOptionFor(saveSubcommand, "draft");

    expect(saveDraftOption.required).toBe(true);
    expect(saveDraftOption.autocomplete).toBe(true);

    const deleteSubcommand = templateSubcommands.find((s) => s.name === "delete")!;
    const deleteNameOption = stringOptionFor(deleteSubcommand, "name");

    expect(deleteNameOption.required).toBe(true);
    expect(deleteNameOption.autocomplete).toBe(true);
  });
});
