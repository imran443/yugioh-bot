import { spawn } from "node:child_process";
import { getNeosViteCommand } from "./neos-dev-launcher.mjs";

let command;

try {
  command = getNeosViteCommand(process.argv.slice(2));
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

const child = spawn(command.command, command.args, {
  cwd: command.cwd,
  stdio: "inherit",
  env: { ...process.env, BROWSER: "none" },
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }

  process.exit(code ?? 0);
});
