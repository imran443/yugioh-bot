import type { Browser, BrowserContext, Page, TestInfo } from "@playwright/test";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createHmac } from "node:crypto";
import { join, relative } from "node:path";
import { duelDataDir, guildId, multiStatusDir, ports, repoRoot } from "../stack/env.mjs";
import { cardCode } from "./cards";
import { attachFailureEvidence, PlayerEvidence, roomBody, type RoomBody } from "./evidence";
import { authFile, type PlayerKey } from "./players";
import type { TimelineEntry } from "./timeline";
import { checklistVerdicts, publicCodesOf, scanLeaks, type BoardSeat, type Leak, type StepRecord, type Verdict } from "./multi-verdict";
import { stallMsFromEnv } from "./watch";
import { expect } from "@playwright/test";
import { expectRooftop } from "./tag";

// Evidence runner for the multi-seat scenario presets. One `PresetRun` drives one preset in a real browser:
// seat 0 (the test user) and one spectator page, the walk through the checklist over the room API, one snapshot for each
// revision (screenshots, room JSON, prompt, LP, eliminated), a stall rule, and at the end the host report,
// the journal, the stack log and a merged timeline. Everything lands in `.status/e2e-multi/<runId>/<presetId>/`.

// ---- static preset list ---------------------------------------------------------------------------------

export interface StaticPreset {
  id: string;
  format: string;
  multi: boolean;
}

/**
 * The preset ids and formats, read from the duel host sources at test-definition time (the stack is not up yet).
 * `runPreset` asks the running host (`list-presets`) and reports a difference in the evidence.
 */
export function staticPresets(): StaticPreset[] {
  const dir = join(repoRoot, "packages/duel-server/src/presets");
  const out: StaticPreset[] = [];
  for (const file of readdirSync(dir).filter((name) => name.endsWith(".ts") && !["index.ts", "types.ts", "board.ts", "catalog.ts"].includes(name))) {
    const text = readFileSync(join(dir, file), "utf8");
    const parts = text.split(/\n\s*id: "/).slice(1);
    for (const part of parts) {
      const id = part.slice(0, part.indexOf('"'));
      const format = /format: "(\w+)"/.exec(part)?.[1] ?? "1v1";
      out.push({ id, format, multi: format !== "1v1" });
    }
  }
  return out;
}

export function coreTag(): string {
  try {
    const text = readFileSync(join(duelDataDir, "ocgcore.multi.SOURCE"), "utf8");
    return /^tag=(.*)$/m.exec(text)?.[1]?.trim() ?? "unknown";
  } catch {
    return "no ocgcore.multi.SOURCE";
  }
}

export const runId = (): string => process.env.E2E_MULTI_RUN_ID ?? "manual";
export const runDir = (): string => join(multiStatusDir, runId());

// ---- room types (only the fields used here) -------------------------------------------------------------

interface Option {
  id: string;
  label: string;
  card?: { code: number; name: string };
  controller?: number;
  values?: number[];
}
interface Prompt {
  id: string;
  seat: number;
  kind: string;
  title: string;
  description?: string;
  options: Option[];
  min?: number;
  max?: number;
  cancelable?: boolean;
  context?: { type: string };
}
type Room = RoomBody & { error?: string; inviteCode?: string };

function promptOf(room: Room | null): Prompt | null {
  return ((room?.engine as { prompt?: Prompt | null } | null | undefined)?.prompt ?? null) as Prompt | null;
}

// ---- seats and contexts ---------------------------------------------------------------------------------

export interface OpenSeat {
  key: PlayerKey;
  context: BrowserContext;
  page: Page;
  rec: PlayerEvidence;
}

/** One logged-in context with the evidence recorder. The caller closes it. */
export async function openSeat(browser: Browser, key: PlayerKey, startedAt: number): Promise<OpenSeat> {
  const context = await browser.newContext({ storageState: authFile(key) });
  const rec = new PlayerEvidence(key, context, startedAt);
  return { key, context, page: await context.newPage(), rec };
}

// ---- the human player's moves ---------------------------------------------------------------------------

interface Want {
  verb: "activate" | "summon";
  card: string;
}
interface Plan {
  wants: Want[];
  /** Seat to pick in a "pick one opponent" prompt. */
  opponent?: number;
  /** Card name to announce in a "name a card" prompt. */
  announce?: string;
}

/** What the tester does in each preset (the checklist, as moves). An unknown preset falls back to the checklist text. */
const PLANS: Record<string, Plan> = {
  "raigeki-dark-hole-ffa4": { wants: [{ verb: "activate", card: "Raigeki" }, { verb: "activate", card: "Dark Hole" }] },
  "raigeki-dark-hole-tag": { wants: [{ verb: "activate", card: "Raigeki" }, { verb: "activate", card: "Dark Hole" }] },
  "ffa3-mind-crush-pick": { wants: [{ verb: "activate", card: "Mind Crush" }], opponent: 2, announce: "Sangan" },
  "ffa3-rules-opponent-lp": { wants: [{ verb: "activate", card: "Hinotama" }], opponent: 2 },
  "ffa3-rules-opponent-field": { wants: [{ verb: "activate", card: "Raigeki" }] },
  "ffa3-rules-activated-lock": { wants: [{ verb: "activate", card: "Abyss Dweller" }, { verb: "activate", card: "Dark Hole" }] },
  "ffa3-rules-resource-rotation": { wants: [{ verb: "activate", card: "Creature Swap" }] },
  "mind-crush-ffa4-pick": { wants: [{ verb: "activate", card: "Mind Crush" }], opponent: 1, announce: "Sangan" },
  "tag-lp-solemn-partner": { wants: [{ verb: "summon", card: "Celtic Guardian" }] },
  "tag-jinzo-blocks-traps": { wants: [{ verb: "summon", card: "Celtic Guardian" }] },
  "negation-veiler-ffa4": { wants: [{ verb: "activate", card: "Pot of Greed" }, { verb: "activate", card: "Pot of Greed" }] },
  "ffa4-chain-order-heavy-storm": { wants: [{ verb: "activate", card: "Heavy Storm" }] },
  "ffa4-surrender-in-chain": { wants: [{ verb: "activate", card: "Heavy Storm" }] },
  "ffa3-table-battle": { wants: [{ verb: "activate", card: "Raigeki" }] },
  "ffa3-turn-player-last": { wants: [{ verb: "activate", card: "Heavy Storm" }] },
  "ffa3-table-chain": { wants: [{ verb: "activate", card: "Heavy Storm" }] },
};

export function planFor(id: string, checklist: string[]): Plan {
  const known = PLANS[id];
  if (known) return { ...known, wants: [...known.wants] };
  const wants: Want[] = [];
  for (const line of checklist) {
    const activate = /Activate ([A-Z][\w' ,-]*?)(?: \(|[.]| then|, )/.exec(line)?.[1];
    if (activate && activate !== "it") wants.push({ verb: "activate", card: activate.trim() });
    const summon = /Normal Summon ([A-Z][\w' -]*?)(?:[.,]| then)/.exec(line)?.[1];
    if (summon) wants.push({ verb: "summon", card: summon.trim() });
  }
  return { wants };
}

const PASS_IDS = ["to_ep", "to_m2", "to_bp"];

function optionMatches(option: Option, name: string): boolean {
  return option.card?.name === name || option.label.includes(name);
}

export interface Decision {
  answer: Record<string, unknown>;
  note: string;
  want?: Want;
}

/** One answer for one prompt of seat 0: the next wanted card when it is offered, else pass (the scripted bot default). */
export function decide(prompt: Prompt, plan: Plan): Decision {
  if (prompt.kind === "choice") {
    for (const want of plan.wants) {
      const prefixes = want.verb === "summon" ? ["summon:"] : ["activate:", "card:"];
      const option = prompt.options.find((entry) => prefixes.some((prefix) => entry.id.startsWith(prefix)) && optionMatches(entry, want.card));
      if (option) return { answer: { choice: option.id }, note: `${want.verb} ${want.card}`, want };
    }
    const opponents = prompt.options.filter((entry) => entry.id.startsWith("opt:") && entry.controller !== undefined && entry.controller !== 0);
    if (opponents.length > 0) {
      const preferred = opponents.find((entry) => entry.controller === plan.opponent) ?? opponents[0]!;
      return { answer: { choice: preferred.id }, note: `pick opponent seat ${preferred.controller}` };
    }
    const yes = prompt.options.find((entry) => entry.id === "yes");
    const no = prompt.options.find((entry) => entry.id === "no");
    if (yes && no) return { answer: { choice: "no" }, note: "default: decline" };
    if (prompt.cancelable && (prompt.min ?? 1) === 0) return { answer: { cancel: true }, note: "default: pass (cancel)" };
    for (const id of PASS_IDS) if (prompt.options.some((entry) => entry.id === id)) return { answer: { choice: id }, note: "default: pass" };
    const first = prompt.options[0];
    return first ? { answer: { choice: first.id }, note: "default: first legal option" } : { answer: { cancel: true }, note: "default: no options, cancel" };
  }
  if (prompt.kind === "announce-card") {
    if (plan.announce) return { answer: { cardCode: cardCode(plan.announce) }, note: `announce ${plan.announce}` };
    return prompt.cancelable ? { answer: { cancel: true }, note: "default: cancel announce" } : { answer: { cardCode: 0 }, note: "default: announce nothing" };
  }
  if (prompt.kind === "number") {
    const value = prompt.options[0]?.values?.[0] ?? prompt.min ?? 0;
    return { answer: { value }, note: "default: first number" };
  }
  if (prompt.cancelable && (prompt.min ?? 1) === 0) return { answer: { cancel: true }, note: "default: cancel" };
  const count = Math.max(prompt.min ?? 1, 1);
  return { answer: { selected: prompt.options.slice(0, count).map((entry) => entry.id) }, note: `default: first ${count} option(s)` };
}

// ---- the run --------------------------------------------------------------------------------------------

export type Status = "pass" | "fail" | "stall";

export interface PresetResult {
  preset: string;
  status: Status;
  coreTag: string;
  turnReached: number;
  lastPrompt: string | null;
  evidenceDir: string;
  firstError: string | null;
  runId: string;
  format: string;
  seats: number;
  revision: number;
  stalledSeat: number | null;
  seconds: number;
  checklistUnmet: string[];
  seed: string[] | null;
  checklist: Verdict[];
  invariants: { status: "ran" | "skipped"; note: string; violations: number };
  leaks: { scanned: number; found: number };
  debugTrace: "used" | "absent" | "failed";
}

interface SeatLine {
  seat: number;
  lp: number | null;
  eliminated: boolean;
  team: number | null;
}

function seatLines(room: Room | null): SeatLine[] {
  return (room?.engine?.seats ?? []).map((seat) => ({ seat: seat.seat, lp: seat.lp ?? null, eliminated: seat.eliminated === true, team: seat.team ?? null }));
}

function promptLine(prompt: Prompt | null): string | null {
  return prompt ? `${prompt.kind} "${prompt.title}" (seat ${prompt.seat})` : null;
}

/** E2E_SEED: four decimal strings "a,b,c,d", or one number that we spread into four. */
export function seedFromEnv(): string[] | null {
  const raw = process.env.E2E_SEED?.trim();
  if (!raw) return null;
  const parts = raw.split(/[,\s]+/).filter(Boolean);
  if (parts.length === 4 && parts.every((part) => /^\d{1,20}$/.test(part))) return parts;
  if (parts.length === 1 && /^\d{1,15}$/.test(parts[0]!)) {
    const n = BigInt(parts[0]!);
    return [n, n * 7n + 1n, n * 13n + 2n, n * 31n + 3n].map(String);
  }
  throw new Error(`E2E_SEED must be four decimal numbers "a,b,c,d" or one number, got: ${raw}`);
}

/**
 * The debug trace of one duel: through the web route (`/api/duels/<slug>/debug-trace`), and directly from the e2e duel host
 * when the web route answers 404 (an older web build, or scenarios off in the web).
 */
async function debugTraceCall(request: { get: (url: string, options?: { timeout?: number }) => Promise<{ status: () => number; text: () => Promise<string> }> } | null, slug: string, playerId: number, timeoutMs: number): Promise<{ status: number; body: unknown }> {
  if (request) {
    const response = await request.get(`/api/duels/${encodeURIComponent(slug)}/debug-trace`, { timeout: timeoutMs });
    if (response.status() !== 404) {
      const text = await response.text();
      try {
        return { status: response.status(), body: JSON.parse(text) };
      } catch {
        return { status: response.status(), body: text.slice(0, 500) };
      }
    }
  }
  return hostCall({ op: "debug-trace", slug, guildId, playerId }, timeoutMs);
}

/** A signed call to the e2e duel host (127.0.0.1, e2e port only). Used for ops that the web has no route for. */
async function hostCall(body: Record<string, unknown>, timeoutMs = 6000): Promise<{ status: number; body: unknown }> {
  const secret = process.env.E2E_DUEL_SECRET ?? "";
  const raw = JSON.stringify(body);
  const signature = "sha256=" + createHmac("sha256", secret).update(raw).digest("hex");
  const response = await fetch(`http://127.0.0.1:${ports.duel}/internal/duel`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-announce-signature": signature },
    body: raw,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  try {
    return { status: response.status, body: JSON.parse(text) };
  } catch {
    return { status: response.status, body: text.slice(0, 500) };
  }
}

type AnyView = { revision?: number; seats?: Array<Record<string, unknown>>; chain?: Array<{ seat: number; name?: string }>; events?: StepRecord["events"]; turn?: number; turnSeat?: number; phase?: string; result?: unknown; prompt?: Prompt | null };

function boardOf(view: AnyView | null | undefined): BoardSeat[] {
  const names = (list: unknown) => (Array.isArray(list) ? list : []).filter(Boolean).map((card) => String((card as { name?: string; code?: number }).name ?? (card as { code?: number }).code ?? "?"));
  return (view?.seats ?? []).map((seat, index) => ({
    seat: Number(seat.seat ?? index),
    lp: typeof seat.lp === "number" ? seat.lp : null,
    eliminated: seat.eliminated === true,
    team: typeof seat.team === "number" ? seat.team : null,
    monsters: names(seat.monsters),
    spells: names(seat.spells),
    grave: names(seat.graveyard),
    handCount: Array.isArray(seat.hand) ? seat.hand.length : 0,
  }));
}

const pad = (n: number) => String(n).padStart(3, "0");

export class PresetRun {
  readonly startedAt = Date.now();
  readonly dir: string;
  private readonly notes: TimelineEntry[] = [];
  private readonly errors: string[] = [];
  private readonly steps: Array<Record<string, unknown>> = [];
  private readonly driverLog: Array<Record<string, unknown>> = [];
  private seat0!: OpenSeat;
  private spectator: OpenSeat | null = null;
  private slug = "";
  private status: Status = "fail";
  private turnReached = 0;
  private lastPromptText: string | null = null;
  private revision = -1;
  private stalledSeat: number | null = null;
  private lastTurnSeat: number | null = null;
  private stallFile: string | null = null;
  private listed: Record<string, unknown> | null = null;
  private plan: Plan = { wants: [] };
  private shots = 0;
  private reportPath: string | null = null;
  private wantsLeft: Want[] = [];
  private unmet: string[] = [];
  private records: StepRecord[] = [];
  private traceState: "unknown" | "used" | "absent" | "failed" = "unknown";
  private traceViews: Array<{ seats: unknown[]; spectator: unknown }> = [];
  private observing = false;
  private traceRevisions = new Set<number>();
  private leaks: Leak[] = [];
  private leakScans = 0;
  private publicCodes = new Set<number>();
  private seed: string[] | null = null;
  private seat0Player = Number(process.env.E2E_SEAT0_PLAYER_ID ?? 1);
  private checklistVerdicts: Verdict[] = [];
  private invariantInfo: PresetResult["invariants"] = { status: "skipped", note: "not run", violations: 0 };
  private hostOpen: Array<{ seat: number; kind: string; title: string; options: string[] }> = [];

  constructor(
    private readonly browser: Browser,
    private readonly testInfo: TestInfo,
    readonly presetId: string,
    private readonly expectedFormat: string,
  ) {
    this.dir = join(runDir(), presetId);
    mkdirSync(join(this.dir, "steps"), { recursive: true });
  }

  private note(text: string, level: TimelineEntry["level"] = "info", data?: Record<string, unknown>): void {
    const now = Date.now();
    this.notes.push({ t: now, at: new Date(now).toISOString(), source: "watcher", kind: "room", level, text, ...(data ? { data } : {}) });
  }

  private fail(message: string): void {
    if (!this.errors.includes(message)) this.errors.push(message);
  }

  private write(name: string, value: unknown): void {
    const path = join(this.dir, name);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value, null, 1));
  }

  /** The whole run. Never throws: the outcome is in `status` and `errors`. Call `finish` after it. */
  async execute(): Promise<void> {
    const maxMs = Number(process.env.E2E_MULTI_MAX_MS ?? 150_000);
    const stallMs = (() => {
      const value = stallMsFromEnv();
      return value > 0 ? value : Number.POSITIVE_INFINITY;
    })();
    try {
      this.seat0 = await openSeat(this.browser, "p1", this.startedAt);
      // Is the preset known, and is it available? Errors are evidence, not test code.
      const list = await this.seat0.context.request.get("/api/duels/preset");
      const listBody = (await list.json().catch(() => null)) as { presets?: Array<Record<string, unknown>>; error?: string } | null;
      this.write("list-presets.json", { status: list.status(), body: listBody });
      if (!list.ok()) return this.fail(`list-presets answered HTTP ${list.status()}: ${JSON.stringify(listBody).slice(0, 300)}`);
      this.listed = listBody?.presets?.find((entry) => entry.id === this.presetId) ?? null;
      if (!this.listed) return this.fail(`The duel host does not list preset ${this.presetId}.`);
      if (this.listed.available === false) return this.fail(`Preset ${this.presetId} is not available: ${String(this.listed.unavailableReason)}`);
      const checklist = (this.listed.checklist as string[] | undefined) ?? [];
      this.plan = planFor(this.presetId, checklist);
      this.wantsLeft = [...this.plan.wants];
      this.write("preset.json", { preset: this.listed, plan: this.plan, coreTag: coreTag(), runId: runId() });

      this.seed = seedFromEnv();
      let started: { ok: () => boolean; status: () => number };
      let startedBody: { slug?: string; error?: string } | null;
      {
        // The web route takes the seed. When it answers 404 (an older web build), call the e2e duel host directly.
        const data: { presetId: string; seed?: string[] } = { presetId: this.presetId, ...(this.seed ? { seed: this.seed } : {}) };
        const response = await this.seat0.context.request.post("/api/duels/preset", { data, headers: { "Content-Type": "application/json" } });
        if (response.status() === 404 && this.seed) {
          const playerId = Number(process.env.E2E_SEAT0_PLAYER_ID ?? 1);
          const direct = await hostCall({ op: "start-preset", presetId: this.presetId, seed: this.seed, guildId, playerId }, 60_000);
          const hostData = direct.body as { slug?: string; session?: { slug?: string }; error?: string } | null;
          startedBody = { slug: hostData?.slug ?? hostData?.session?.slug, error: hostData?.error };
          started = { ok: () => direct.status < 400, status: () => direct.status };
        } else {
          startedBody = (await response.json().catch(() => null)) as { slug?: string; error?: string } | null;
          started = response;
        }
      }
      this.write("start-preset.json", { status: started.status(), seed: this.seed, body: startedBody });
      if (!started.ok() || !startedBody?.slug) return this.fail(`start-preset answered HTTP ${started.status()}: ${JSON.stringify(startedBody).slice(0, 400)}`);
      this.slug = startedBody.slug;
      this.note(`preset ${this.presetId} started as ${this.slug}${this.seed ? ` with seed ${this.seed.join(",")}` : ""}`);

      await this.openPages();
      this.observing = true;
      const observer = this.observeEngine();
      try {
        await this.playUntilDone(maxMs, stallMs);
      } finally {
        this.observing = false;
        await observer;
      }
    } catch (error) {
      this.fail(`The run threw: ${String(error instanceof Error ? (error.stack ?? error.message) : error).slice(0, 1500)}`);
    }
  }

  /** Screenshot rendering must not prevent us from seeing the bots' short chain windows. */
  private async observeEngine(): Promise<void> {
    while (this.observing) {
      await this.trace("poll", false, true);
      await this.sleep(80);
    }
  }

  /** Seat 0 room page and one spectator page. A page problem is evidence; the run goes on over the API. */
  private async openPages(): Promise<void> {
    const url = `/duels/${encodeURIComponent(this.slug)}`;
    try {
      await this.seat0.page.goto(url, { timeout: 30_000 });
      const gate = this.seat0.page.getByTestId("duel-window-gate");
      const board = this.seat0.page.getByRole("region", { name: "Duel field" });
      await gate.or(board).first().waitFor({ timeout: 30_000 });
      if (await gate.isVisible()) await this.seat0.page.getByRole("button", { name: "Open here instead" }).click();
      await board.waitFor({ timeout: 15_000 });
      if (this.expectedFormat === "ffa3" || this.expectedFormat === "ffa4") {
        await expect(this.seat0.page.locator(`[data-table-stage='${this.expectedFormat}']`)).toBeVisible();
        await expect(this.seat0.page.locator("[data-table-shell]")).toBeVisible();
        await expect(this.seat0.page.locator("[data-lp-seat]")).toHaveCount(this.expectedFormat === "ffa3" ? 3 : 4);
      }
      if (this.expectedFormat === "tag") {
        await expectRooftop(this.seat0.page);
        await expect(this.seat0.page.locator("[data-table-stage='tag'] [data-lp-seat]")).toHaveCount(4);
      }
    } catch (error) {
      this.note(`seat 0 page did not show the duel field: ${String(error).slice(0, 200)}`, "error");
      this.fail(`Seat 0 room page did not show the duel field: ${String(error).split("\n")[0]}`);
    }
    try {
      this.spectator = await openSeat(this.browser, "p2", this.startedAt);
      const room = roomBody(await this.seat0.rec.room(this.slug)) as Room | null;
      const code = room?.inviteCode;
      if (code) {
        const accepted = await this.spectator.context.request.post(`/api/duels/${encodeURIComponent(this.slug)}/invite`, { data: { inviteCode: code }, headers: { "Content-Type": "application/json" } });
        if (!accepted.ok()) this.note(`spectator invite answered HTTP ${accepted.status()}`, "warn");
      } else this.note("seat 0 room has no invite code; the spectator may be refused", "warn");
      await this.spectator.page.goto(url, { timeout: 30_000 });
      await this.spectator.page.getByRole("region", { name: "Duel field" }).waitFor({ timeout: 20_000 }).catch((error) => {
        this.note(`spectator page did not show the duel field: ${String(error).slice(0, 200)}`, "error");
      });
    } catch (error) {
      this.note(`spectator page failed: ${String(error).slice(0, 200)}`, "error");
    }
  }

  private async playUntilDone(maxMs: number, stallMs: number): Promise<void> {
    const seats = Number(this.listed?.seats ?? 4);
    const targetTurn = Number(process.env.E2E_MULTI_TURNS ?? seats + 1);
    let lastChange = Date.now();
    let badReads = 0;
    let failedAnswers = 0;
    let lastSent: { promptId: string; at: number } | null = null;
    while (Date.now() - this.startedAt < maxMs) {
      const read = await this.seat0.rec.room(this.slug);
      const room = roomBody(read) as Room | null;
      if (!room || !room.session) {
        badReads += 1;
        if (badReads >= 6) {
          const message = `The room API of seat 0 gave no duel 6 times in a row: ${JSON.stringify(read).slice(0, 300)}`;
          if (this.revision >= 0) {
            // The duel had started and then the server stopped answering: the core or the host is stuck. That is a stall.
            this.status = "stall";
            this.stalledSeat = this.lastTurnSeat;
            this.note(`host unresponsive after revision ${this.revision}: ${message}`, "error");
            await this.traceOnce("hang-debug-trace.json");
          }
          return this.fail(message);
        }
        await this.sleep(400);
        continue;
      }
      badReads = 0;
      const engine = room.engine;
      const revision = engine?.revision ?? -1;
      const prompt = promptOf(room);
      if (revision !== this.revision && revision >= 0) {
        this.revision = revision;
        lastChange = Date.now();
        failedAnswers = 0;
        await this.snapshot(room, prompt);
      }
      this.turnReached = Math.max(this.turnReached, engine?.turn ?? 0);
      this.lastTurnSeat = engine?.turnSeat ?? this.lastTurnSeat;
      if (prompt) this.lastPromptText = promptLine(prompt);
      const session = room.session;
      if (session.status !== "active") {
        this.note(`duel status is ${session.status}: ${session.resultReason ?? "no reason"}`);
        // Completion proves the preset only after all intended moves were played.
        if (session.status === "completed" || engine?.result) {
          if (this.wantsLeft.length === 0) this.status = "pass";
          else this.fail(`The duel completed before checklist moves were done: ${this.wantsLeft.map((want) => `${want.verb} ${want.card}`).join(", ")}`);
        }
        else this.fail(`The duel ended with status ${session.status}: ${session.resultReason ?? (room.error ?? "no reason")}`);
        return;
      }
      if (room.error) this.fail(`The room reports an error: ${room.error}`);
      if (this.wantsLeft.length === 0 && this.turnReached >= targetTurn) {
        this.status = "pass";
        this.note(`reached turn ${this.turnReached} with the checklist moves done`);
        return;
      }
      // Seat 0 holds the prompt: answer it.
      if (prompt && prompt.seat === 0 && (!lastSent || lastSent.promptId !== prompt.id || Date.now() - lastSent.at > 2500)) {
        const decision = decide(prompt, { ...this.plan, wants: this.wantsLeft });
        lastSent = { promptId: prompt.id, at: Date.now() };
        const sent = await this.seat0.context.request.post(`/api/duels/${encodeURIComponent(this.slug)}/actions`, {
          data: { promptId: prompt.id, revision, answer: decision.answer },
          headers: { "Content-Type": "application/json" },
        });
        const body = await sent.text().catch(() => "");
        this.driverLog.push({ at: new Date().toISOString(), revision, promptId: prompt.id, kind: prompt.kind, title: prompt.title, note: decision.note, answer: decision.answer, http: sent.status(), body: sent.ok() ? undefined : body.slice(0, 500) });
        if (sent.ok()) {
          if (decision.want) this.wantsLeft = this.wantsLeft.filter((want) => want !== decision.want);
        } else {
          failedAnswers += 1;
          this.note(`answer rejected (${sent.status()}): ${body.slice(0, 200)}`, "error");
          if (failedAnswers >= 3) return this.fail(`The host rejected the answer of seat 0 ${failedAnswers} times (HTTP ${sent.status()}): ${body.slice(0, 300)} for ${promptLine(prompt)}, answer ${JSON.stringify(decision.answer)}`);
        }
        await this.sleep(150);
        continue;
      }
      if (Date.now() - lastChange >= stallMs) {
        await this.stall(room, prompt, Date.now() - lastChange, stallMs);
        return;
      }
      await this.sleep(300);
    }
    this.fail(`The preset did not finish within ${Math.round(maxMs / 1000)} s (turn ${this.turnReached}, target turn ${targetTurn}, revision ${this.revision}). The revision was still changing.`);
  }

  /** One debug-trace call. Returns the trace, or null when the op is absent (404), failed or timed out. */
  private async trace(tag: string, save: boolean, collect = false): Promise<Record<string, unknown> | null> {
    this.hostOpen = [];
    if (this.traceState === "absent") return null;
    try {
      const response = await debugTraceCall(this.seat0?.context.request ?? null, this.slug, this.seat0Player, 6000);
      if (response.status === 404 || (response.status === 400 && /unknown duel operation/i.test(String((response.body as { error?: string })?.error ?? "")))) {
        this.traceState = "absent";
        this.note(`host op debug-trace is absent (HTTP ${response.status}: ${JSON.stringify(response.body).slice(0, 80)}); the duel-server build may be older than the source. No host trace is saved.`, "warn");
        return null;
      }
      if (response.status >= 400) {
        this.traceState = "failed";
        this.note(`debug-trace answered HTTP ${response.status}: ${JSON.stringify(response.body).slice(0, 200)}`, "warn");
        return null;
      }
      this.traceState = "used";
      const body = response.body as { seats?: Array<{ seat: number; view: AnyView; prompt?: Prompt }>; spectator?: AnyView };
      if (save) this.write(`steps/${tag}-debug-trace.json`, body);
      this.hostOpen = (body.seats ?? []).filter((entry) => entry.prompt && entry.seat !== 0).map((entry) => ({ seat: entry.seat, kind: entry.prompt!.kind, title: entry.prompt!.title, options: entry.prompt!.options.map((option) => option.label) }));
      if (collect && body.spectator && (body.seats ?? []).length > 0 && (body.seats ?? []).every((entry) => entry.view)) {
        const view = body.spectator;
        if (typeof view.revision === "number" && !this.traceRevisions.has(view.revision)) {
          this.traceRevisions.add(view.revision);
          // Polls at the same revision are observations, not accepted engine steps. The fuzz
          // progress invariant expects one view set per distinct revision.
          this.traceViews.push({ seats: body.seats!.map((entry) => entry.view), spectator: view });
          this.records.push({
            step: this.records.length + 1, revision: view.revision, turn: view.turn ?? null,
            turnSeat: view.turnSeat ?? null, phase: view.phase ?? null, status: "active", result: view.result,
            board: boardOf(view), chain: (view.chain ?? []).map((link) => ({ seat: link.seat, name: link.name })),
            events: view.events ?? [],
            prompt: null, hostPrompts: this.hostOpen, traceSeen: true, screenshot: null,
          });
        }
      }
      return body as Record<string, unknown>;
    } catch (error) {
      if (this.traceState === "unknown") this.traceState = "failed";
      this.note(`debug-trace failed: ${String(error).slice(0, 160)}`, "warn");
      return null;
    }
  }

  private async traceOnce(name: string): Promise<void> {
    if (!this.slug || this.traceState === "absent") return;
    try {
      const response = await debugTraceCall(this.seat0?.context.request ?? null, this.slug, this.seat0Player, 6000);
      this.write(name, response);
    } catch (error) {
      this.write(name, { error: String(error).slice(0, 300) });
    }
  }

  /** Leak scan of what the two browsers were sent (seat 0 and the spectator), with the Tag partner rule. */
  private leakScan(room: Room, specRoom: Room | null, trace: Record<string, unknown> | null): void {
    const format = String(this.listed?.format ?? this.expectedFormat);
    if (specRoom?.engine) publicCodesOf(specRoom.engine as never, this.publicCodes);
    if (trace?.spectator) publicCodesOf(trace.spectator as never, this.publicCodes);
    const found = [
      ...scanLeaks((room.engine ?? {}) as never, 0, format, this.publicCodes, "seat 0 page"),
      ...(specRoom?.engine ? scanLeaks(specRoom.engine as never, null, format, this.publicCodes, "spectator page") : []),
    ];
    this.leakScans += specRoom?.engine ? 2 : 1;
    for (const leak of found) {
      if (!this.leaks.some((old) => old.message === leak.message)) {
        this.leaks.push(leak);
        this.note(`LEAK at revision ${leak.revision}: ${leak.message}`, "error");
      }
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((done) => setTimeout(done, ms));
  }

  /** One snapshot for a revision change: screenshots of both pages and the room JSON of both. */
  private async snapshot(room: Room, prompt: Prompt | null): Promise<void> {
    const n = this.steps.length + 1;
    const pid = (room.session as { seats?: Array<{ seat: number; playerId?: number }> } | undefined)?.seats?.find((entry) => entry.seat === 0)?.playerId;
    if (typeof pid === "number") this.seat0Player = pid;
    const max = Number(process.env.E2E_MULTI_MAX_SHOTS ?? 120);
    const engine = room.engine;
    const tag = pad(n);
    const files: string[] = [];
    const specRoom = this.spectator ? (roomBody(await this.spectator.rec.room(this.slug)) as Room | null) : null;
    if (n <= max) {
      this.write(`steps/${tag}-seat0-room.json`, room);
      files.push(`steps/${tag}-seat0-room.json`);
      if (specRoom) {
        this.write(`steps/${tag}-spectator-room.json`, specRoom);
        files.push(`steps/${tag}-spectator-room.json`);
      }
      // Let the page draw the new state first.
      await this.sleep(350);
      const pages: Array<[string, Page | undefined]> = [["seat0", this.seat0.page], ["spectator", this.spectator?.page]];
      for (const [name, page] of pages) {
        if (!page || page.isClosed()) continue;
        try {
          await page.screenshot({ path: join(this.dir, `steps/${tag}-${name}.png`), timeout: 5000, animations: "disabled" });
          files.push(`steps/${tag}-${name}.png`);
          this.shots += 1;
        } catch {
          // A hung page is skipped.
        }
      }
    }
    // debug-trace (all seat views, bot rule trace, worker state): feature-detected, saved beside the views.
    const trace = await this.trace(tag, n <= max);
    if (trace) files.push(`steps/${tag}-debug-trace.json`);
    this.leakScan(room, specRoom, trace);
    const hostPrompts = this.hostOpen;
    this.records.push({
      step: n,
      revision: engine?.revision ?? null,
      turn: engine?.turn ?? null,
      turnSeat: engine?.turnSeat ?? null,
      phase: engine?.phase ?? null,
      status: room.session?.status ?? null,
      result: engine?.result ?? null,
      board: boardOf(engine as AnyView),
      chain: ((engine as AnyView | null)?.chain ?? []).map((link) => ({ seat: link.seat, name: link.name })),
      events: (engine as AnyView | null)?.events ?? [],
      prompt: prompt && { seat: prompt.seat, kind: prompt.kind, title: prompt.title, options: prompt.options.map((option) => option.label) },
      hostPrompts,
      traceSeen: trace !== null,
      screenshot: files.find((file) => file.endsWith("-seat0.png")) ? join(this.dir, files.find((file) => file.endsWith("-seat0.png"))!) : null,
    });
    const step = {
      step: n,
      clockMs: (room as { clock?: { remainingMs?: number[] } }).clock?.remainingMs ?? null,
      at: new Date().toISOString(),
      revision: engine?.revision ?? null,
      turn: engine?.turn ?? null,
      turnSeat: engine?.turnSeat ?? null,
      phase: engine?.phase ?? null,
      prompt: prompt && { id: prompt.id, seat: prompt.seat, kind: prompt.kind, title: prompt.title, options: prompt.options.slice(0, 15).map((option) => option.label) },
      spectatorPrompt: promptLine(promptOf(specRoom)),
      seats: seatLines(room),
      spectatorSeats: seatLines(specRoom),
      log: (engine?.log ?? []).slice(-3).map((entry) => entry.text),
      files,
    };
    this.steps.push(step);
    this.write("steps.json", this.steps);
    this.note(
      `${this.slug} revision ${engine?.revision}, turn ${engine?.turn ?? "?"} ${engine?.phase ?? ""} (turn seat ${engine?.turnSeat ?? "?"}), LP ${seatLines(room).map((seat) => `s${seat.seat}=${seat.lp}${seat.eliminated ? "X" : ""}`).join(" ")}${prompt ? `, open prompt seat ${prompt.seat} "${prompt.title}"` : ", no open prompt for seat 0"}`,
      "info",
      { progress: true, slug: this.slug, revision: engine?.revision },
    );
  }

  private async stall(room: Room, prompt: Prompt | null, idleMs: number, stallMs: number): Promise<void> {
    this.status = "stall";
    this.stalledSeat = prompt?.seat ?? room.engine?.turnSeat ?? null;
    const seatInfo = room.session?.seats?.find((entry) => entry.seat === this.stalledSeat);
    const message =
      `Duel ${this.slug} stalled: revision ${this.revision} did not change for ${Math.round(idleMs / 1000)} s (limit ${Math.round(stallMs / 1000)} s, E2E_STALL_MS), turn ${room.engine?.turn}, ` +
      `waiting seat ${this.stalledSeat ?? "?"}${seatInfo ? (seatInfo.isBot ? " (a scripted bot)" : " (a human)") : ""}` +
      `${prompt ? `, open prompt ${promptLine(prompt)}` : ", seat 0 sees no open prompt (the core or a bot should act)"}.`;
    this.note(message, "error");
    this.fail(message);
    await this.traceOnce("stall-debug-trace.json");
    // Save what a screenshot of this instant shows. finish() writes stall.json with the timeline tail and the report path.
    await this.snapshot(room, prompt).catch(() => undefined);
  }

  /** Report op, evidence, stall.json, result files. Always call it, also after a failure. */
  async finish(): Promise<PresetResult> {
    const seconds = Math.round((Date.now() - this.startedAt) / 100) / 10;
    if (this.slug) {
      await this.callReport();
    }
    if (this.seat0) {
      const recorders = [this.seat0.rec, ...(this.spectator ? [this.spectator.rec] : [])];
      await attachFailureEvidence(this.testInfo, recorders, { notes: this.notes, errors: this.errors, outDir: this.dir, presetId: this.presetId }).catch((error) => {
        this.note(`evidence collection failed: ${String(error).slice(0, 200)}`, "error");
      });
    }
    this.write("driver-log.json", this.driverLog);
    this.unmet = this.wantsLeft.map((want) => `${want.verb} ${want.card}`);
    const listedChecklist = ((this.listed?.checklist as string[] | undefined) ?? []);
    // Engine observations and slower screenshot snapshots can arrive at different times.
    // Checklist steps describe engine order; screenshot filenames keep their own sequence.
    this.records = this.records.sort((a, b) => (a.revision ?? -1) - (b.revision ?? -1))
      .map((record, index) => ({ ...record, step: index + 1 }));
    this.checklistVerdicts = checklistVerdicts(this.presetId, listedChecklist, {
      steps: this.records,
      driver: this.driverLog.filter((entry) => entry.http === 200).map((entry) => ({ revision: Number(entry.revision), note: String(entry.note) })),
      format: String(this.listed?.format ?? this.expectedFormat),
    });
    this.write("checklist.json", this.checklistVerdicts);
    this.write("leaks.json", { scanned: this.leakScans, found: this.leaks });
    await this.runInvariants();
    if (this.leaks.length > 0) this.fail(`Leak scan: ${this.leaks.length} leak(s), first: ${this.leaks[0]!.message} (revision ${this.leaks[0]!.revision}). See leaks.json.`);
    if (this.invariantInfo.violations > 0) this.fail(`FZ invariants: ${this.invariantInfo.violations} violation(s). See invariants.json.`);
    const badItems = this.checklistVerdicts.filter((item) => item.verdict === "fail");
    if (badItems.length > 0) this.fail(`Checklist item(s) failed: ${badItems.map((item) => `#${item.item} (revision ${item.revision})`).join(", ")}. See checklist.json.`);
    if (this.status === "pass" && this.errors.length > 0) this.status = "fail";
    const timeline = this.readTimeline();
    if (this.status === "stall") this.writeStall(timeline);
    await Promise.all([this.seat0?.context.close().catch(() => undefined), this.spectator?.context.close().catch(() => undefined)]);

    const browserError = timeline.find((entry) => entry.level === "error" && entry.kind !== "test" && entry.kind !== "room");
    const firstError = this.errors[0]?.split("\n")[0] ?? (browserError ? `${browserError.at.slice(11, 23)} [${browserError.source}] ${browserError.text}` : null);
    const result: PresetResult = {
      preset: this.presetId,
      status: this.status,
      coreTag: coreTag(),
      turnReached: this.turnReached,
      lastPrompt: this.lastPromptText,
      evidenceDir: this.dir,
      firstError,
      runId: runId(),
      format: String(this.listed?.format ?? this.expectedFormat),
      seats: Number(this.listed?.seats ?? 0),
      revision: this.revision,
      stalledSeat: this.stalledSeat,
      seconds,
      checklistUnmet: this.unmet,
      seed: this.seed,
      checklist: this.checklistVerdicts,
      invariants: this.invariantInfo,
      leaks: { scanned: this.leakScans, found: this.leaks.length },
      debugTrace: this.traceState === "used" ? "used" : this.traceState === "absent" ? "absent" : "failed",
    };
    this.write("result.json", { ...result, stallFile: this.stallFile, reportPath: this.reportPath, errors: this.errors, screenshots: this.shots });
    this.writeReadme(result);
    aggregate();
    return result;
  }

  /** FZ invariants (`packages/duel-server/tests/fuzz-n/invariants.ts`) over the views that debug-trace gave us. */
  private async runInvariants(): Promise<void> {
    if (this.traceViews.length === 0) {
      this.invariantInfo = { status: "skipped", note: this.traceState === "absent" ? "debug-trace is absent on this host, so only two views per revision exist; the invariants need every seat" : "no complete view set was captured", violations: 0 };
      this.write("invariants.json", this.invariantInfo);
      return;
    }
    try {
      const file = join(repoRoot, "packages/duel-server/tests/fuzz-n/invariants.ts");
      if (!existsSync(file)) {
        this.invariantInfo = { status: "skipped", note: "TODO: packages/duel-server/tests/fuzz-n/invariants.ts does not exist yet", violations: 0 };
        this.write("invariants.json", this.invariantInfo);
        return;
      }
      const mod = (await import(file)) as { checkViewSequence: (format: string, steps: Array<{ views: unknown }>) => Array<{ invariant: string; step: number; seat?: number; message: string }> };
      const format = String(this.listed?.format ?? this.expectedFormat);
      const violations = mod.checkViewSequence(format, this.traceViews.map((views) => ({ views })));
      this.invariantInfo = { status: "ran", note: `${this.traceViews.length} view sets`, violations: violations.length };
      this.write("invariants.json", { ...this.invariantInfo, violations });
      for (const violation of violations.slice(0, 20)) this.note(`invariant ${violation.invariant} at step ${violation.step}: ${violation.message}`, "error");
    } catch (error) {
      this.invariantInfo = { status: "skipped", note: `the invariants could not load or run: ${String(error).slice(0, 200)}`, violations: 0 };
      this.write("invariants.json", this.invariantInfo);
    }
  }

  get failure(): string | null {
    if (this.status === "pass" && this.errors.length === 0) return null;
    const head = this.status === "stall" && this.stallFile ? `STALL, see ${this.stallFile}\n` : `FAIL (${this.status}), evidence in ${this.dir}\n`;
    return head + this.errors.join("\n");
  }

  private async callReport(): Promise<void> {
    try {
      const note = `e2e-multi ${runId()} ${this.presetId}: status ${this.status}, turn ${this.turnReached}, revision ${this.revision}. ${this.errors.join(" | ")}`.slice(0, 3900);
      const response = await this.seat0.context.request.post(`/api/duels/${encodeURIComponent(this.slug)}/report`, { data: { note }, headers: { "Content-Type": "application/json" }, timeout: 30_000 });
      const body = (await response.json().catch(() => null)) as { path?: string; error?: string } | null;
      this.write("report-response.json", { status: response.status(), body });
      if (response.ok() && body?.path && existsSync(body.path)) {
        this.reportPath = body.path;
        cpSync(body.path, join(this.dir, "host-report"), { recursive: true });
      } else {
        this.note(`report op did not give a folder: HTTP ${response.status()} ${JSON.stringify(body).slice(0, 200)}`, "warn");
      }
    } catch (error) {
      this.note(`report op failed: ${String(error).slice(0, 200)}`, "warn");
    }
  }

  private readTimeline(): TimelineEntry[] {
    try {
      return (JSON.parse(readFileSync(join(this.dir, "timeline.json"), "utf8")) as { entries: TimelineEntry[] }).entries;
    } catch {
      return [];
    }
  }

  private writeStall(timeline: TimelineEntry[]): void {
    const last = this.steps.at(-1);
    const file = join(this.dir, "stall.json");
    this.stallFile = file;
    const origin = timeline[0]?.t ?? 0;
    this.write("stall.json", {
      kind: "multi-seat-stall",
      preset: this.presetId,
      slug: this.slug,
      waitingSeat: this.stalledSeat,
      lastPrompt: this.lastPromptText,
      revision: this.revision,
      turn: this.turnReached,
      coreTag: coreTag(),
      reportPath: this.reportPath,
      hostReportCopy: existsSync(join(this.dir, "host-report")) ? join(this.dir, "host-report") : null,
      message: this.errors.find((error) => error.includes("stalled")) ?? this.errors[0] ?? null,
      lastStep: last,
      last50TimelineLines: timeline.slice(-50).map((entry) => `${entry.at.slice(11, 23)} +${String(Math.max(0, entry.t - origin)).padStart(6)}ms ${entry.level === "error" ? "ERR " : "    "}[${entry.source}] ${entry.text}`),
      files: { timeline: join(this.dir, "timeline.md"), journal: `duel-journal-${this.slug}.json`, stackLog: join(this.dir, "stack-log.txt") },
      replay: `npx tsx packages/duel-server/scripts/replay-journal.ts ${relative(repoRoot, join(this.dir, `duel-journal-${this.slug}.json`))} --views`,
    });
  }

  private writeReadme(result: PresetResult): void {
    this.write(
      "README.md",
      [
        `# ${this.presetId}: ${result.status}`,
        "",
        `- Core: ${result.coreTag}. Format ${result.format}, ${result.seats} seats. Turn reached ${result.turnReached}, revision ${result.revision}, ${result.seconds} s.`,
        `- Last prompt: ${result.lastPrompt ?? "none"}`,
        `- First error: ${result.firstError ?? "none"}`,
        `- Checklist moves not done: ${result.checklistUnmet.join(", ") || "none"}`,
        `- Seed: ${result.seed?.join(",") ?? "random"}. debug-trace: ${result.debugTrace}. Leak scan: ${result.leaks.found} found in ${result.leaks.scanned} views. FZ invariants: ${result.invariants.status} (${result.invariants.violations} violations; ${result.invariants.note}).`,
        "",
        "| # | verdict | revision | screenshot | checklist item | detail |",
        "| --- | --- | --- | --- | --- | --- |",
        ...result.checklist.map((item) => `| ${item.item} | ${item.verdict} | ${item.revision ?? ""} | ${item.screenshot ? relative(this.dir, item.screenshot) : ""} | ${item.text.replace(/\|/g, "/")} | ${item.detail.replace(/\|/g, "/")} |`),
        "",
        "Files: `steps/` (screenshots and room JSON of seat 0 and the spectator for each revision), `steps.json` (prompt, LP, eliminated for each revision),",
        "`driver-log.json` (every answer of seat 0), `timeline.md` and `timeline.json` (merged), `evidence-p1.json` and `evidence-p2.json` (console, page errors, failed requests, every WS frame),",
        "`duel-state-*.json`, `duel-journal-<slug>.json`, `stack-log.txt`, `host-report/` (the host `report` op folder: journal.jsonl, views/seat-N.json), `stall.json` (only on a stall), `failure-*.png`.",
        "",
      ].join("\n"),
    );
  }
}

// ---- aggregate: latest.json and index.md ----------------------------------------------------------------

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

/** Rebuilds `<runDir>/results.json`, `<runDir>/index.md` and `.status/e2e-multi/latest.json` (old entries of other presets stay). */
export function aggregate(): void {
  const dir = runDir();
  const results: PresetResult[] = [];
  if (existsSync(dir)) {
    for (const name of readdirSync(dir)) {
      const result = readJson<PresetResult>(join(dir, name, "result.json"));
      if (result?.preset) results.push(result);
    }
  }
  results.sort((a, b) => a.preset.localeCompare(b.preset));
  writeFileSync(join(dir, "results.json"), JSON.stringify(results, null, 1));
  const latestFile = join(multiStatusDir, "latest.json");
  const previous = (readJson<PresetResult[]>(latestFile) ?? []).filter((old) => !results.some((entry) => entry.preset === old.preset));
  const merged = [...results, ...previous].map((entry) => ({ preset: entry.preset, status: entry.status, coreTag: entry.coreTag, turnReached: entry.turnReached, lastPrompt: entry.lastPrompt, evidenceDir: entry.evidenceDir, firstError: entry.firstError, runId: entry.runId, format: entry.format, seats: entry.seats, stalledSeat: entry.stalledSeat, seed: entry.seed ?? null, checklist: entry.checklist ?? [], invariants: entry.invariants ?? null, leaks: entry.leaks ?? null, debugTrace: entry.debugTrace ?? null }));
  mkdirSync(multiStatusDir, { recursive: true });
  writeFileSync(latestFile, JSON.stringify(merged, null, 1));
  const row = (entry: PresetResult) => `| ${entry.preset} | ${entry.format} | ${entry.status} | ${entry.turnReached} | ${entry.lastPrompt ?? ""} | ${["pass", "fail", "not-reached", "unchecked"].map((v) => (entry.checklist ?? []).filter((item) => item.verdict === v).length).join("/")} | ${(entry.firstError ?? "").replace(/\|/g, "/").slice(0, 160)} | ${relative(dir, entry.evidenceDir)}/ |`;
  writeFileSync(
    join(dir, "index.md"),
    [
      `# Multi-seat preset run ${runId()}`,
      "",
      `Core: ${coreTag()}. Each row folder has README.md, timeline.md, steps/ and stall.json (on a stall).`,
      "",
      "| preset | format | status | turn | last prompt | checklist (pass/fail/not-reached/unchecked) | first error | folder |",
      "| --- | --- | --- | --- | --- | --- | --- | --- |",
      ...results.map(row),
      "",
      existsSync(join(dir, "visual")) ? "Visual set: `visual/<format>/seat<N>-<player>.png` (one full-page screenshot per seat at the first prompt).\n" : "",
    ].join("\n"),
  );
}
