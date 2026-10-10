import { seedIdentity, seedUser } from "./helpers/identity.js";
import { createHmac } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { migrate } from "@yugidraft/shared/db";
import { isDuelKindSetup } from "@yugidraft/shared/duels";
import type { DuelPrivateState } from "@yugidraft/shared/services";
import { createDuelHost, reportSetup, type DuelHost } from "../src/host.js";
import { engineDataDirectory as DATA } from "./engine-data-dir.js";

const SECRET = "report-replay-secret";
type DuelSetup = NonNullable<DuelPrivateState["setup"]>;
const hosts: DuelHost[] = [];
afterEach(async () => {
  while (hosts.length > 0) await hosts.pop()!.close();
  delete process.env.DUEL_SCENARIOS;
  delete process.env.DUEL_REPORT_DIR;
});

async function post(host: DuelHost, body: Record<string, unknown>) {
  const raw = JSON.stringify(body);
  const signature = "sha256=" + createHmac("sha256", SECRET).update(raw).digest("hex");
  const response = await host.handle(new Request("http://localhost/internal/duel", {
    method: "POST",
    headers: { "content-type": "application/json", "x-announce-signature": signature },
    body: raw,
  }));
  return { status: response.status, data: (await response.json()) as Record<string, any> };
}

it("removes private creator and prefix metadata from valid fork report setup", () => {
  const rules: DuelSetup = { engine: "pinned", firstTurnDraw: false, scriptErrorMode: "strict", startupScripts: ["-- fixture"] };
  const setup: DuelSetup = { ...rules, replayFork: {
    ownerUserId: 101, control: "all-manual", origin: {
      sourceSlug: "private-source-fixture", sourceVersion: "source-v1", frameId: "frame-2", step: 2,
      prefixCount: 7, prefixHash: "a".repeat(64), sourceSeats: [{ seat: 0, displayName: null }, { seat: 1, displayName: null }],
    },
  } };
  expect(isDuelKindSetup("replay-fork", setup, "1v1")).toBe(true);
  expect(reportSetup(setup)).toEqual(rules);
  expect(JSON.stringify(reportSetup(setup))).not.toMatch(/replayFork|ownerUserId|private-source-fixture|prefixCount|prefixHash/);
});

describe("a manual report journal replays", () => {
  it("replay-journal.ts replays the journal.jsonl of a real preset duel, startup scripts included", async () => {
    process.env.DUEL_SCENARIOS = "1";
    const dir = mkdtempSync(join(tmpdir(), "duel-report-replay-"));
    process.env.DUEL_REPORT_DIR = dir;
    try {
      const db = new Database(":memory:");
      migrate(db);
      const player = seedIdentity(db, { guildId: "g1", name: "P0", userId: seedUser(db, "u0").userId, discordUserId: seedUser(db, "u0").discordUserId ?? "u0" }).playerId;
      const host = createDuelHost({ db, dataDirectory: DATA, secret: SECRET, searchCards: () => [], pollIntervalMs: 60_000, stallMs: 0 });
      hosts.push(host);
      const who = { guildId: "g1", playerId: player };
      const started = await post(host, { op: "start-preset", presetId: "dust-tornado-chain", ...who });
      expect(started.status).toBe(200);
      const slug = started.data.slug as string;
      const engine = started.data.room.engine as { revision: number; prompt: { id: string; options: Array<{ id: string }> } };
      const pass = engine.prompt.options.find((option) => option.id === "to_ep") ?? engine.prompt.options[0]!;
      const responded = await post(host, {
        op: "respond", slug, ...who,
        command: { promptId: engine.prompt.id, revision: engine.revision, answer: { choice: pass.id } },
      });
      expect(responded.status).toBe(200);
      const row = db.prepare("select id, setup_json from duels where web_slug = ?").get(slug) as { id: number; setup_json: string };
      const setup = JSON.parse(row.setup_json);
      // Stored sequence IDs can have gaps. The report format still uses ordered indices.
      db.prepare("update duel_commands set seq = seq + 1000 where duel_id = ?").run(row.id);
      const reported = await post(host, { op: "report", slug, note: "replay me", ...who });
      expect(reported.status).toBe(200);
      const journal = join(reported.data.path as string, "journal.jsonl");
      const journalText = readFileSync(journal, "utf8");
      const lines = journalText.trim().split("\n").map((line) => JSON.parse(line));
      const header = lines[0]!;
      expect(header).toMatchObject({ format: "yugidraft-duel-journal/1", tableFormat: "1v1", wasmFile: "ocgcore.standard.wasm",
        setup: { firstTurnDraw: false } });
      expect(header.wasmSha).toMatch(/^[0-9a-f]{64}$/);
      expect(header.startupScripts.length).toBeGreaterThan(0);
      expect(header.setup).toEqual(setup);
      expect(journalText).not.toMatch(/replayFork|ownerUserId|private-source-fixture|prefixCount|prefixHash/);
      const commands = lines.filter((line) => "command" in line);
      expect(commands.length).toBeGreaterThan(0);
      expect(commands.map((line) => line.seq)).toEqual(commands.map((_, index) => index + 1));
      const output = execFileSync("npx", ["tsx", "scripts/replay-journal.ts", journal, "--data", DATA], {
        cwd: fileURLToPath(new URL("..", import.meta.url)), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
      });
      expect(output).toMatch(/replayed \d+ of \d+ answers/);
      expect(output).not.toMatch(/mismatch|threw/);
      expect(output).toContain(`sha256 ${header.wasmSha}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
