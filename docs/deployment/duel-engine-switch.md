# Duel engine switch and the multiplayer flag

The multiplayer merge ships with two limits. Both are set by environment variables on the VM.

1. Saved 1v1 games keep their engine. Compose defaults new Standard games to pinned and Domain to legacy.
2. 3-player, 4-player and Tag tables are on in production by default (Standard and Domain; each needs its multi core).

## MULTIPLAYER_TABLES (default on in production compose)

| Value | Result |
| --- | --- |
| `0`, or anything else | Only 1v1 tables exist. The creator shows no 3-player, 4-player or Tag option. The web API and the duel host refuse them with the message "Only 1v1 tables are open on this server." |
| `1`, `true` or `on` | Tag, 3-player and 4-player tables are open. Production compose uses this when `.env` does not set it. |

- Set it in `docker-compose.yml` for the `duel` and `web` services (`MULTIPLAYER_TABLES=${MULTIPLAYER_TABLES:-1}`). Put `MULTIPLAYER_TABLES=0` in `/opt/yugioh-bot/.env` to close the tables.
  Both services read it at run time. A restart of both switches it. No build is needed.
- Staging sets it on in `docker-compose.staging.yml` (`STAGING_MULTIPLAYER_TABLES`, default `1`).
- The E2E stack sets it on. `E2E_MULTIPLAYER_TABLES=0` turns it off. `packages/e2e/tests/multiplayer-flag-off.spec.ts` checks the off state.
- Turning the flag off does not end a multi-seat duel that is already active. The host still runs it. The gate runs when a table starts, not when a duel recovers. It only refuses new tables.

## DUEL_1V1_ENGINE (`legacy` or `pinned`, default `legacy`)

| Value | 1v1 Standard and Domain duels run on (without a Standard override) |
| --- | --- |
| `legacy` (default) | main's engine from before the n-seat work: the `ocgcore-wasm` npm package core for Standard, and `ocgcore.domain.legacy.wasm` with `card-scripts/domain.legacy.lua` for Domain. The engine code is `packages/duel-server/src/legacy/`. |
| `pinned` | the merged engine: `ocgcore.standard.wasm` and `ocgcore.domain.wasm` of the bundle. |

- For the global switch, any other value, an empty value or a missing value means `legacy`. Only `pinned` (any case,
  spaces trimmed) selects the merged engine. The Standard override below takes priority for Standard games.
- Tables with 3 or more seats always use the multi core. The switch does not change them.
- `docker-compose.yml` sets `DUEL_1V1_ENGINE=${DUEL_1V1_ENGINE:-legacy}`. Staging sets `${STAGING_DUEL_1V1_ENGINE:-legacy}`
  for the same Domain default. Set `STAGING_DUEL_1V1_ENGINE=pinned` to test the merged Domain engine.
- The deploy ships both engines. The engine bundle holds the merged and the legacy files.
- The switch is read when a new game starts. Each game of a series reads the switch at its start. Change it, then
  recreate the `duel` container to apply the environment value. Active games keep their engine (see below).

### DUEL_STANDARD_1V1_ENGINE (Standard override, Compose default `pinned`)

Production and staging Compose start new Standard 1v1 games on the existing pinned Standard core by default.
No production `.env` edit is needed. `DUEL_1V1_ENGINE=legacy` keeps Domain 1v1 on its current legacy core.
The switch adds no engine files and does not change bundleVersion (see the cache note below).

The legacy Standard and Domain cores are different. The npm `ocgcore-wasm@0.1.2` release uses upstream
`ygopro-core` `8e5f4e4f0ab6b8ca750e8e1c91c1a58f407e3272` (April 2026). Legacy Domain and pinned Standard
use `efc21aa433b88cd35b7c37db4072a35c58d9d435` (September 2026). Pinned Standard applies shared core
fixes without Domain changes. It supports the triggering Scale and Link queries in the current `chain.lua`.

- Valid values are `legacy` and `pinned`; case and surrounding spaces do not matter. A valid value takes priority
  over the global switch for Standard only. In native runs, missing, empty or invalid values use `DUEL_1V1_ENGINE`.
  Startup logs show the active Standard and Domain choices and warn about invalid non-empty values.
- Domain keeps the global choice. Tag and 3+ seats keep the multi cores. Scenarios and presets keep pinned.
- Production Compose passes `${DUEL_STANDARD_1V1_ENGINE:-pinned}` to `duel`. Staging uses
  `${STAGING_DUEL_STANDARD_1V1_ENGINE:-pinned}`. A missing or empty Compose value means `pinned`, not the global choice.
- Deploy this code to apply the Compose default. After changing a value in `.env`, recreate the container with
  `docker compose -f docker-compose.yml up -d --force-recreate duel`. A Compose `restart` does not apply a changed
  environment value. Each game of a series reads the switch at its start; card admission uses the same choice.
- Recovery and replay use the saved `setup.engine`, even after the override changes. Records with no choice
  still use legacy. Old Standard duels retain the old core limits. Keep both cores in the bundle.
- To roll back new Standard games only, set `DUEL_STANDARD_1V1_ENGINE=legacy` in `/opt/yugioh-bot/.env` and recreate
  `duel` with the command above. Rollback needs the word `legacy`; an empty or removed value selects `pinned` in Compose.
  Staging rollback uses `STAGING_DUEL_STANDARD_1V1_ENGINE=legacy`. Active games keep their saved choice.

### The engine of a duel is recorded

When a duel starts, the host saves `engine` in `setup_json` (`setup.engine`, `legacy` or `pinned`). Recover after a restart
and replay use the saved engine, not the current switch. So you can change the switch at any time without risk to
active duels.

- A duel with no record (made by main before this merge) is treated as `legacy`.
- A scenario or preset duel (with startup scripts) is `pinned`. The legacy engine has no startup scripts.
- A dev or staging duel made on the merged branch before the record existed is also read as `legacy`. Do not carry such duels over.

### Bundle changes and the switch

- The first deploy of the merge changes the engine bundle (new wrapper patch, new multi cores, the legacy files). The deploy
  preflight refuses while a duel is active. Follow "Before a deploy that changes the engine bundle" in `vm-runbook.md`.
- The environment switch alone does not change the bundle version. Changing it needs no preflight, no empty server and no rebuild.
- The deploy bundle cache key hashes `packages/shared/src/duels/**`, so a switch code change causes a cache miss and
  rebuilds the cores. The key is not bundleVersion. `prepare-data.ts` and the core builders compute bundleVersion as
  SHA-256 of `JSON.stringify({ sources, integrity })`, with `multiScripts` and `cardsMerged` removed from integrity.
  Compared with main, the Standard switch changes no data pins, preparation code, core source, build scripts,
  toolchain pin, wrapper patch or lockfile. The same pinned inputs therefore produce the same bundleVersion.
- Local check on 2026-10-09 against main `499314ceb`: fresh `duel:prepare` data and verified cached cores gave
  `3d5b0dc7b691ef0499298749a20ece6a27102f30388b142f205b999e1a16e8a2` on both versions. The core pins, source hashes and
  cached binary hashes matched. The manifest writers ran in deploy order (Domain, Standard, legacy Domain) from
  each version. The server bundle check and legacy pin check passed. No Docker core build was needed.
- Both engines use the same wrapper (`patches/ocgcore-wasm+0.1.2.patch`). The legacy mode (`legacyMessages: true` in `createCore`) keeps main's message layout for the parts that differ.

### Build the legacy Domain core

`npm run duel:prepare` keeps the legacy files in the bundle. To build them:

```bash
npx tsx packages/duel-server/scripts/build-domain-core.ts legacy-domain
```

This runs `packages/duel-server/legacy-1v1/scripts/build-domain-core.sh` in `docker.io/emscripten/emsdk:4.0.9`.
Provenance and shas are in `packages/duel-server/legacy-1v1/README.md`. The deploy and test workflows run this step.
The server refuses to start with `DUEL_1V1_ENGINE=legacy` when the manifest has no `integrity.domainLegacyWasm` or
`domainLegacyLua`, or when a legacy file does not match its hash.

### Pin of the legacy files

`packages/duel-server/legacy-1v1/expected-sha256.txt` holds the sha256 of the legacy Domain wasm and of `domain.legacy.lua`
(the sha of main's own build). `packages/duel-server/scripts/check-legacy-pin.sh <data dir>` compares them with the files in a
data dir. The build script runs it. The test, deploy and staging workflows run it on the bundle. A rebuild that gives another
wasm (for example a new emsdk image) fails there, so the legacy engine cannot drift from main without a visible change.
The pin is rebuilt from main's scripts and checked again by the proof in the merge PR.

### Known differences from main in legacy mode

- Ordered card and chain picks use the shared raw-index response encoder. The wrapper's length prefix made the legacy core reject valid orders; this fixes wire encoding without changing sort rules.
- The pendulum summon log line is "Special Summon" in legacy mode and "Pendulum Summon" in the merged engine. The legacy engine is main's, so it prints main's text. The e2e spec `card-pendulum-summon.spec.ts` accepts this in legacy mode (`E2E_1V1_ENGINE=legacy`).
- Counters: the legacy engine reads a counter from the core as main does (count first). `tests/ocgcore-wrapper-abi.test.ts` checks both layouts for `duelQuery` and `duelQueryLocation`.
- The host answers a blocked `view` or `report` with a stale view only when `DUEL_SCENARIOS=1` (the scenario runner). In production, the host waits for the real answer as main does.
- The multi cores (3, 4 players, Tag) are built from a newer patch series than main's Domain core (the 0053 core-seats patch series). They are used by multi-seat tables only, and those are on by default in Compose (`MULTIPLAYER_TABLES`).

### E2E

The e2e stack picks the 1v1 engine with `E2E_1V1_ENGINE` (`legacy` or `pinned`). The default of the stack is `pinned`.
Run the 1v1 specs with `E2E_1V1_ENGINE=legacy` to check both legacy engines. Production Compose uses pinned for Standard
and legacy for Domain.

## How to roll back

- To use the old engine for all new 1v1 games: set `DUEL_1V1_ENGINE=legacy` and `DUEL_STANDARD_1V1_ENGINE=legacy` in `.env`.
  Recreate `duel` with `docker compose -f docker-compose.yml up -d --force-recreate duel`. An empty Standard value is
  not a rollback: Compose substitutes `pinned`.
- To use pinned for all new 1v1 games: set `DUEL_1V1_ENGINE=pinned` and `DUEL_STANDARD_1V1_ENGINE=pinned`, then recreate `duel`.
- To close the multi-seat tables: set `MULTIPLAYER_TABLES=0` in `/opt/yugioh-bot/.env` and recreate `duel` and `web` (`docker compose -f docker-compose.yml up -d duel web`).
- To remove the whole merge: follow "Rollback" in `vm-runbook.md`.

## What is checked

- The legacy regression pin is main `b1e20054`: Draw/Standby prompt, view and engine pacing cases from `cec00380`, public-priority privacy tests, material-count cases, and chain-target response/tracking cases run against `src/legacy/` in `packages/duel-server/tests/legacy-main/` (20 test files). The remaining baseline cases are still from `78b8caa`; this is a selective port, not a claim that all newer main engine changes were copied. Import paths and temporary legacy-wasm links select the legacy engine.
- The merged duel-server suites pass in both modes (`DUEL_1V1_ENGINE=legacy` and `pinned`). CI runs both: the `engine` and the `engine-legacy` job.
- `tests/legacy-engine-identity.test.ts`: the legacy Standard core is the npm file byte for byte. The legacy Domain wasm has the manifest sha.
- `tests/host-engine-switch.test.ts`: dispatch, the saved engine, recover and replay across a switch change.
- `tests/server-shutdown.test.ts`: startup engine choices and invalid-value warnings, without a production port or database.
- `tests/host-series.test.ts`: game 2 reads the Standard switch again; each game keeps its own saved engine.
