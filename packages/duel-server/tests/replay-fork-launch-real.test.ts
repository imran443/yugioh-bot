import Database from "better-sqlite3";
import { createHmac } from "node:crypto";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { migrate } from "@yugidraft/shared/db";
import { createDuelService, createReplayForkService } from "@yugidraft/shared/services";
import { seatCountFor, type DuelEngineChoice, type DuelEngineView, type DuelFormat, type DuelMode,
  type DuelRoom, type ReplayForkResult, type ReplaySource } from "@yugidraft/shared/duels";
import { createDuelHost, type DuelHost } from "../src/host.js";
import { getCurrentEngineResources } from "../src/engine-resource-resolver.js";
import { createReplayCursorCodec, replayFrameId, replayPrefixHash, replaySourceVersion } from "../src/replay-cursor.js";
import { buildPracticeBotDeck, chooseSurrenderedAnswer } from "../src/practice-bot.js";
import { GameWorker } from "../src/worker-client.js";
import { engineDataDirectory as DATA } from "./engine-data-dir.js";
import { describeWithCores, needs } from "./support/cores.js";
import { seedIdentity } from "./helpers/identity.js";

const cases: Array<{ mode: DuelMode; format: DuelFormat; engine?: DuelEngineChoice }> =
  (["normal", "domain"] as const).flatMap(mode => [
    { mode, format: "1v1", engine: "legacy" }, { mode, format: "1v1", engine: "pinned" },
    { mode, format: "tag" }, { mode, format: "ffa3" }, { mode, format: "ffa4" },
  ]);
const secret = "real-fork-launch-fixture";
afterEach(() => vi.unstubAllEnvs());

describeWithCores("real fork launch and copied-prefix restart", [needs.cards(DATA), needs.scripts(DATA), needs.standard(DATA), needs.domain(DATA),
  needs.installedMulti(DATA), needs.file("Domain multi core", join(DATA, "ocgcore.multi-domain.wasm")),
  needs.file("legacy Domain core", join(DATA, "ocgcore.domain.legacy.wasm")),
  needs.file("legacy Domain script", join(DATA, "card-scripts/domain.legacy.lua"))], () => {
  it.each(cases)("launches, answers, recovers and restarts $mode $format $engine", async ({ mode, format, engine }) => {
    vi.stubEnv("OWNER_USER_IDS", "101"); vi.stubEnv("MULTIPLAYER_TABLES", "1");
    const db = new Database(":memory:"); migrate(db);
    const owner = { guildId: "real-fork-test", playerId: 61, userId: 101 };
    seedIdentity(db, owner);
    const count = seatCountFor(format);
    for (let seat = 0; seat < count; seat++) seedIdentity(db, { guildId: owner.guildId, playerId: 64 + seat, userId: 201 + seat });
    const resources = getCurrentEngineResources(DATA, { mode, format, engine });
    const duels = createDuelService(db);
    const session = duels.create({ guildId: owner.guildId, organizerPlayerId: 64, name: "Real source", mode, format,
      settings: { visibility: "private", validateDeck: false } });
    const decks = Array.from({ length: count }, () => structuredClone(buildPracticeBotDeck(mode, DATA)));
    const seed = ["123", "456", "789", "1011"] as [string, string, string, string];
    const setup = { engine, engineIdentity: resources.identity, firstTurnDraw: mode === "domain" && count > 2, scriptErrorMode: "strict" as const };
    const sourceWorker = new GameWorker(); let host: DuelHost | undefined;
    const changes: string[] = [];
    const startHost = () => host = createDuelHost({ db, dataDirectory: DATA, secret, searchCards: () => [],
      pollIntervalMs: 60_000, onChange: slug => { changes.push(slug); } });
    async function post<T>(input: Record<string, unknown>): Promise<T> {
      const raw = JSON.stringify({ ...owner, ...input });
      const response = await host!.handle(new Request("http://localhost/internal/duel", { method: "POST", body: raw,
        headers: { "x-announce-signature": "sha256=" + createHmac("sha256", secret).update(raw).digest("hex") } }));
      const data = await response.json(); expect(response.status, JSON.stringify(data)).toBe(200); return data as T;
    }
    try {
      await sourceWorker.create({ mode, format, decks, seed, dataDirectory: DATA, masterRule: session.masterRule,
        settings: session.settings, ...setup, multiScriptsDirectory: resources.multiScriptsDirectory });
      db.prepare("delete from duel_seats where duel_id = ?").run(session.id);
      for (let seat = 0; seat < count; seat++) db.prepare("insert into duel_seats(duel_id,seat,player_id,ready,deck_json) values(?,?,?,1,?)")
        .run(session.id, seat, 64 + seat, JSON.stringify(decks[seat]));
      db.prepare("update duels set status = 'interrupted', seed_json = ?, bundle_version = ?, setup_json = ? where id = ?")
        .run(JSON.stringify(seed), resources.bundleVersion, JSON.stringify(setup), session.id);
      // Real saved commands use gapped database IDs and include a private no-op mode change.
      for (let step = 0; step < 3; step++) {
        const views = await Promise.all(Array.from({ length: count }, (_, seat) => sourceWorker.view(seat)));
        const view = views.find(v => v.prompt)!;
        const prompt = view.prompt!;
        const command = { promptId: prompt.id, revision: view.revision, answer: chooseSurrenderedAnswer(prompt) };
        db.prepare("insert into duel_commands(duel_id,seq,seat,command_json) values(?,?,?,?)")
          .run(session.id, 2 + step * 5, prompt.seat, JSON.stringify(command));
        await sourceWorker.answer(prompt.seat, prompt.id, command.answer);
      }
      const beforeMode = await sourceWorker.view(1);
      db.prepare("insert into duel_commands(duel_id,seq,seat,command_json) values(?,19,1,?)")
        .run(session.id, JSON.stringify({ promptId: "chain-mode:off", revision: beforeMode.revision, answer: {} }));
      await sourceWorker.setChainMode(1, "off");
      const state = duels.privateState(session.slug, owner.guildId);
      const source: ReplaySource = { session: state.session, setup: { engine, firstTurnDraw: setup.firstTurnDraw, scriptErrorMode: "strict" },
        engineIdentity: resources.identity, decks, seed, bundleVersion: state.bundleVersion!, commands: state.commands };
      const sourceVersion = replaySourceVersion(source), revision = (await sourceWorker.view(null)).revision;
      const cursor = createReplayCursorCodec(secret).seal({ sourceId: session.id, sourceSlug: session.slug, guildId: owner.guildId,
        sourceVersion, frameId: replayFrameId(sourceVersion, 3), step: 3, prefixCount: 4, prefixHash: replayPrefixHash(source, 4), revision });
      const before = [db.prepare("select * from duels where id = ?").get(session.id),
        db.prepare("select * from duel_commands where duel_id = ? order by seq").all(session.id), db.prepare("select * from players").all()];
      startHost();
      const launch = await post<ReplayForkResult>({ op: "replay-fork", slug: session.slug, cursor, sourceVersion, requestId: "real-request-1" });
      const forkSlug = launch.slug;
      expect(launch.room.mySeat).toBe(0); expect(launch.room.fork!.manualSeats).toHaveLength(count);
      expect(launch.room.fork!.chainModes).toEqual(Object.fromEntries(Array.from({ length: count }, (_, seat) => [seat, "always"])));
      for (let seat = 0; seat < count; seat++) {
        const original = (await sourceWorker.view(seat)).seats[seat]!;
        expect(launch.room.engine!.seats[seat]!.hand).toEqual(original.hand);
      }
      const control = createReplayForkService(db);
      expect(control.privateState(forkSlug, owner).commands.slice(0, 4)).toEqual(source.commands);
      const prompt = launch.room.engine!.prompt!; expect(prompt).not.toBeNull();
      const advanced = await post<DuelRoom>({ op: "respond", slug: forkSlug, as: prompt.seat,
        command: { promptId: prompt.id, revision: launch.room.engine!.revision, answer: chooseSurrenderedAnswer(prompt) } });
      await host!.close(); startHost();
      const recovered = await post<DuelRoom>({ op: "view", slug: forkSlug, as: prompt.seat });
      expect(recovered.engine).toEqual(advanced.engine);
      const restarted = await post<DuelRoom>({ op: "fork-restart", slug: forkSlug });
      expect(restarted.engine).toEqual(launch.room.engine);
      expect(control.privateState(forkSlug, owner).commands).toHaveLength(4 + count);
      expect([db.prepare("select * from duels where id = ?").get(session.id),
        db.prepare("select * from duel_commands where duel_id = ? order by seq").all(session.id), db.prepare("select * from players").all()]).toEqual(before);
      expect(db.prepare("select * from duel_series").all()).toEqual([]);
      expect(db.prepare("select * from matches").all()).toEqual([]);
      expect(db.prepare("select * from duel_invite_grants").all()).toEqual([]);
      expect(changes.every(slug => slug === forkSlug)).toBe(true);
    } finally { await host?.close(); await sourceWorker.close(); db.close(); }
  }, 60_000);
});
