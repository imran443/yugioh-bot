# Engine data updates

The admin `GET /api/admin/card-data-status` endpoint reports the installed bundle and
each pinned source's GitHub committer date as **data as of** (`engine.sources.*.pinnedCommitDate`).
Preparation time is unknown (`preparedAt: null`, `preparedAtSource: "unknown"`); manifest
mtime only reflects a file copy. The running host uses its startup manifest, including
validated `sources.databaseFiles` provenance, with `cards.cdb` as the old-manifest fallback.
The installed `cards.cdb` is the prepared merged database. The upstream file list follows
that same rule: root `cards.cdb`, non-Rush `prerelease-*.cdb` and `release-*.cdb`.

The primary gap compares the engine against **TCG sets released in the last 12 calendar
months through today (UTC)** from the daily `card_sets` sync. Per-set YGOPRODeck cardinfo
requests use the shared card/image fetch queue. Compact identities and printing codes
persist in `card_data_set_cache`; sets at most 60 days old refresh daily and older released
sets remain cached indefinitely. Reports count playable alias/artwork families, exclude
skills/tokens, and separate same-name/type ID mismatches from missing cards. A set that
has never fetched successfully has unknown/null totals, never a false zero; the primary
count is also null before the set index has synced. Cached set
data is served while refreshing, with `checkedAt` showing its last successful fetch.
`cachedCatalogMissing*` remains a diagnostic for the incomplete on-demand catalog;
there is no reverse engine-versus-cache metric.

Status reads keep local snapshots for at least 60 seconds even when catalog writes bump
the revision. GitHub reads serve cached metadata and refresh in the background, including
an immediate unknown snapshot on first use. Only used response fields are cached; successes
last one hour and failures five minutes, honoring `x-ratelimit-reset` on 403/429.
HEAD/compare-base dates avoid separate repository and pinned-commit lookups: normally
nine public API calls per hourly refresh. `defaultBranch` stays null; omitting `sha` still resolves HEAD
on the default branch. Workflow and PR links must begin with `https://github.com/`.
The web-to-duel status call has a five-second deadline covering the response body.

`GITHUB_TOKEN` is **optional and unset in production** for this public-read status
feature. Healthy unauthenticated reads at <=15 calls/hour fit its intended budget. Never use
`BUG_REPORT_GITHUB_TOKEN` for card-data status. This runtime setting is separate from
the GitHub Actions workflow token described below.

The **Engine data update** workflow runs **Monday and Thursday at 06:00 UTC** (`0 6 * * 1,4`), with checks three or four days apart. `workflow_dispatch` remains available for manual checks and exact-SHA inputs. It advances only Project Ignis CardScripts, BabelCDB and Distribution, with an exact pin-file allowlist of `packages/duel-server/scripts/prepare-data.ts`, `packages/duel-server/domain-core/pins.json` and `packages/duel-server/legacy-1v1/domain-core/pins.json`. If an old data SHA appears in another tracked file, the updater fails before writing anything. Both core-build `pins.json` files retain their `cardScripts` record and advance it together with the scripts pin in `prepare-data.ts`. Those records are part of `bundleVersion`. A real CardScripts bump invalidates both core build caches; the resulting multicore rebuild during deployment is accepted. The updater never advances ygopro-core, ocgcore-wasm, Lua or Emscripten.

## Relevance gate and review counts

A moved upstream pin does not by itself justify a data bump. Before rewriting any
pin, `scripts/update-engine-data.ts` compares the current and candidate inputs with
`scripts/engine-data-relevance.ts`:

- **Card rows:** rebuild both snapshots with the same non-Rush database discovery,
  load order, preview deduplication and graduation history used by preparation.
  Compare every retained column in `datas` and `texts` in the merged database.
  Include base rows with no counterpart in the other table, as the runtime reads
  these tables separately.
  Keep SQLite integers exact, including 64-bit setcodes and races. Database layout,
  ignored Rush/Legend rows and discarded duplicate previews do not count.
- **Scripts:** compare Git blob IDs for shipped Lua scripts and shared helpers.
  Include additions, edits, removals and changes to which scripts are retained.
  Exclude Rush directories and known Rush card IDs that are absent from the
  merged database, non-Lua files, absent preview scripts and preview copies
  discarded in favor of an official script. Known Rush IDs come from the source
  rows already read and Rush script paths. Retain other numbered Lua files even
  without a database row, as loaded scripts can use them as dependencies. Explicit
  paths such as `pre-errata/` remain relevant.
- **Strings and remaps:** compare the exact `config/strings.conf` bytes from
  Distribution and the effective old-to-current passcode remaps. Other Distribution
  files, upstream docs and unused databases do not count.

If these inputs are unchanged, the updater keeps all current pins, reports
`changed=false`, and writes the reason under **Relevance gate** in the report and
job summary. Candidate validation and publication are skipped, so an existing bump
PR is not updated and a new PR is not opened. Skipped upstream changes accumulate
against the installed pins and are checked again on the next run. If the previous
snapshot fails remap validation (ambiguity, invalid overrides or cycles), the updater cannot prove irrelevance; it continues with a
review finding and unknown card counts. Failed downloads or incomplete trees stop
the run before publication.

For a relevant update, the PR body reports **new cards, changed cards, removed
cards, changed scripts and new set codes** (for example `BETB`). Card counts compare
passcodes in the merged rows before the candidate script smoke check; an edit to
card text, stats, OT, alias or a card string counts as a changed card. Changed script
counts include added and removed retained Lua paths and shared helpers. New set
codes come from the new-card source files, with YGOPRODeck printing metadata for
base/generic additions when available. Existing validation, overlay review,
golden-hash review and publication protections still apply. Irrelevant changes do
not change `bundleVersion`; every published data bump still has the deployment and
replay effects described below.

The PR and job summary also include **Released TCG sets still in pre-release CDBs**,
including when the relevance gate skips or no pin moved. The note joins
candidate preview source filenames (including `-en` variants) to the YGOPRODeck
[`cardsets.php` set index](https://ygoprodeck.com/api-guide/#all-card-sets) and lists
sets whose valid `tcg_date` is on or before today in UTC. Generic previews can use
catalog printing codes and explicit beta IDs. Each entry gives the set name/code,
TCG date, distinct preview passcode count and source files. Rows already present in
released data by passcode or main-card name/type are excluded. This includes
unchanged previews during a script-only update and describes upstream membership
before candidate script smoke exclusions. It tells the reviewer which released
cards still wait for Ignis; the date alone does not trigger a bump. Unknown/future
dates are omitted, and failed metadata requests are labeled unavailable instead of
claiming there are no pending sets. Metadata is best effort and uses the same two
bounded catalog requests as the new-card report. Counts and the released-set note
are retained when the PR body is truncated.

The `prepare` job has contents-read and pull-requests-read permissions, checks out without persisted credentials, and installs without a token in its environment. It builds shared before running the updater. Pin resolution and candidate bundle preparation receive the read-only GitHub token. It resolves candidate pins, prepares a temporary bundle, checks overlays, probes the installed production core, and uploads a pin-only patch, metadata and full report. The separate `publish` job installs no dependencies, checks out without persisted credentials, validates the artifact's exact paths and pin-only content, then uses its write token to commit, push and manage the PR. Automated bot commits have no Claude co-author or session trailers.

Before publishing, the job inspects `origin/<base>..origin/chore/engine-data-update`. While an open PR exists, any commit not authored by the exact GitHub Actions bot name and email causes a skip and a comment on that PR, preserving human overlay edits. Without an open PR, the stale branch is replaced from the current base, including after a squash merge or closure. Identical candidate pins on an open PR (or already on the base) cause no push or CI dispatch. Every publication skip emits a workflow warning. If the base advanced after preparation, publication waits for a fresh run. Updates use an explicit force-with-lease against the fetched tip, so a concurrent edit makes the push fail. There is no automatic merge.

Preparation also compares the candidate's loaded data with the open PR's pins; identical data skips the push and CI dispatch only if the fetched PR head still matches the compared head, after the human-commit check.

Enable **Settings → Actions → General → Workflow permissions → Allow GitHub Actions to create and approve pull requests**. No personal token is required. With `GITHUB_TOKEN`, publication explicitly dispatches `test.yml` with `nightly=false`, running normal CI without the four nightly fuzz legs; the native job still checks the committed golden rows. **CI on the bot PR fails at “nduel golden hashes (--check)” until a reviewer re-records and commits `golden.tsv` for the candidate inputs.** Manual test dispatch defaults `nightly` to true; scheduled nightly runs remain enabled. An optional `ENGINE_DATA_PR_TOKEN` personal/app token needs repository contents and pull-request writes; with it, normal pull-request CI runs and explicit dispatch is skipped. Write permissions exist only in `publish`.

The PR receives the `engine-data` label if it exists. Its body is capped at 60,000 UTF-8 bytes, retaining the first-line counts, deployment warning and golden-hash review instructions, with links to the run summary and artifact. The complete report is saved in the `engine-data-update-report` artifact for 14 days and included in the run summary when it fits. Summaries exceeding 1,000,000 bytes are truncated with an artifact link, below GitHub's 1 MiB limit.

## Released and prerelease card data

Preparation and the updater discover root `cards.cdb`, every root non-Rush `prerelease-*.cdb`, and every root `release-*.cdb` from the GitHub tree at the exact BabelCDB commit. Truncated trees, missing base files and failed downloads stop preparation. Prerelease filenames containing `rush` and all rows with Rush/Legend OT bits (`0x600`) are excluded; unofficial, skills and GOAT databases remain excluded. Each preparation starts from those pinned inputs. Graduated or withdrawn previews disappear from the bundle when Ignis removes their prerelease row or file; nothing is carried forward from an earlier output database.

The output is one `cards.cdb`, read by artwork identity and catalog writers, duel deck validation, legacy 1v1, pinned 1v1 and multiplayer engines. Load order is base, sorted prereleases, then sorted releases, using case-insensitive filename order within each group. Complete `datas`/`texts` pairs use `INSERT OR REPLACE`, with rows sorted by ID; released rows always win. SQLite copies integer values directly, preserving 64-bit setcodes/races. The sorted discovery and replacement behavior follows EDOPro's [file discovery](https://github.com/edo9300/edopro/blob/c250b6ab9bebb6eca9fdd07ee0c5bd2278426e81/gframe/utils.cpp#L555), [repository database loading](https://github.com/edo9300/edopro/blob/c250b6ab9bebb6eca9fdd07ee0c5bd2278426e81/gframe/game.cpp#L2648) and [replacement of card entries](https://github.com/edo9300/edopro/blob/c250b6ab9bebb6eca9fdd07ee0c5bd2278426e81/gframe/data_manager.cpp#L97). The preview identity deduplication below adds the owner's casual-format policy.

Only main-art rows (`alias=0`) without the token bit (`type & 0x4000`) participate in identity deduplication or historical remaps. Alternate artworks and tokens keep their distinct passcodes; exact-code released rows still take precedence. Identity is trimmed, case-folded name plus exact numeric type. A released identity wins over every preview, including a preview with a different passcode. Renamed/type-corrected historical previews additionally use the v3 policy below. Duplicate previews prefer an official-size passcode (below 100,000,000), then an `-en.cdb` source, then the lowest code. Every dropped preview is printed during preparation and listed in the scheduled report, with its retained passcode when available. References in `datas.alias` to graduated main-card IDs follow their remap. Conflicting remaps or remap sources still retained under another identity stop preparation instead of redirecting a saved card silently. Released and preview artwork families remain intact. Read/import paths and startup skip remaps whose source is a retained alternate artwork or token. Startup checks application artwork families inside the same immediate transaction as its writes. The unsafe v1 recipe omitted alias metadata for dropped artwork rows; nonempty v1 remaps are refused before any saved data or cache records change, requiring bundle preparation with v2. Historical graduations also update the alias of each surviving artwork to its current main code.

The manifest records `sources.databaseFormat = "official-releases-prerelease-v4"`, the ordered `sources.databaseFiles`, and `sources.prereleaseHistoryStart`. `integrity.cards` is SHA-256 over ordered `<filename>:<input SHA-256>` records, joined by newlines with no trailing newline. `integrity.cardsMerged` hashes the merged output bytes and verifies the cached `cards.cdb` on disk. `card-remaps.json` contains schema version 1, old-to-current `remaps`, retained `prerelease` identities and `drops`; `integrity.cardRemaps` hashes its exact bytes. That hash participates in `bundleVersion`. Startup, bundle cache checks and installation verify it; the new recipe requires the artifact even if its remap map is empty. Every bundle version writer excludes only `cardsMerged` and `multiScripts`: SQLite layout/library changes alone cannot invalidate duels or replays. The format marker forces older recipes at unchanged upstream pins to rebuild. Bump it when selection, merge or script filtering changes.

`integrity.scripts` continues to hash the pinned input archive. Preparation keeps `pre-release/cNNN.lua` only when its code is present in the final merged database, and prefers an `official/` copy when both exist. Basename lookup prefers `official/`, then `pre-release/`, then root/shared helpers and other directories; explicit paths remain available. Native fixed-path checks also search `pre-release/` after root and `official/`. Artwork aliases resolve through the merged database.

At database pin `fdf92aea…`, 14,759 base passcodes plus 86 release passcodes yield 14,845 released rows. Six non-Rush preview files contain 139 rows: `prerelease-betb-en.cdb` (16), `prerelease-dbgv.cdb` (33), `prerelease-imph.cdb` (50), `prerelease-others.cdb` (10), `prerelease-rv02.cdb` (5), and `prerelease-yac1.cdb` (25). All 139 are retained, yielding 14,984 total rows with zero deduplication drops. `prerelease-betb-en.cdb` holds upcoming TCG identities distinct from the already released OCG BETB identities; filename similarity alone would remove usable cards incorrectly.

Five rows in `prerelease-imph.cdb` are real alternate artworks, not identity duplicates: Cynet Mining `57160137` (alias `57160136`), Bonfire `85106526` (alias `85106525`), The Winged Dragon of Ra `101403130` (alias `101403030`), Diabellze `101403134` (alias `101403034`), and King of Beasts `101403148` (alias `41463181`). All five remain selectable and none produces a remap. At scripts pin `37f270dc…`, 84 release passcodes resolve to 80 distinct official scripts; the two other release rows are Tokens (`3129528` and `41458362`). Released alt-art codes `17242023`, `24203750`, `50208445` and `79791696` retain the core's near-code alias behavior.

Ignis can replace a temporary code with a final official one and delete the prerelease database. The [BETB release commit on 2026-09-23](https://github.com/ProjectIgnis/BabelCDB/commit/85e7fd3e7c30002a8a2d4047eaf496206b442b85) deletes `prerelease-betb.cdb` and adds `release-betb.cdb`. Adamancipator Conductor moves `101402024 → 24925387`, and Adamancipator Crystal - Tiamite moves `101402025 → 51420096`, preserving name/type. Some other preview names change on release, so name matching cannot safely infer every graduation.

For deterministic cleanup on a fresh deployment, preparation reads all distinct prerelease Git blobs from the feature's fixed initial pin (`prereleaseHistoryStart`, abbreviated to avoid the updater rewriting it) through the candidate pin. Git is required after that initial pin. The reader walks full merge history, collects distinct database blob IDs, and fetches all of them in one batch before reading their local bytes. Network round trips do not increase with the number of scheduled snapshots. It matches historical name/type identities to the current released or retained preview identity, preserving old-to-current mappings even after a file disappears and across skipped scheduled updates. No previous bundle or generated tracked registry is required. The initial pin does not retroactively map unsupported previews from earlier history. Withdrawals without a current identity match produce no remap: saved decks keep their code and validation reports it as unknown. Renamed/type-changed identities use the conservative same-commit stats/text policy described below; ambiguous candidates remain unknown for human review. The report explicitly lists disappeared codes without a remap and, for renamed cards, suggests newly released main-art rows with equal type/ATK/DEF/level/attribute for human review. An ambiguous old snapshot is an advisory finding: the report marks its comparison unavailable and the candidate update continues.

Duel-server startup verifies the bundle and applies remaps to the shared application database before serving. An immediate SQLite transaction and a per-`bundleVersion` marker make the rewrite atomic and idempotent across concurrent startups. It updates saved decks, tournament registered decks, lobby duel decks, open series' base/current decks, and the `customCardIds`, `customExtraCardIds`, `cubeCardIds` and `poolCardIds` arrays in cube/draft configs. Lobby sandbox setup scripts rewrite literal first arguments of `Debug.AddCard` only. Draft card/deal/undealt catalog references move to the official row while pick row IDs stay stable. Cube collisions sum copies up to `MAX_CUBE_COPIES` (99) and retain existing official metadata. Decks retain all copies after a collision, so normal legality checks may flag the merged deck for exceeding its copy limit. Invalid or non-object JSON rows are skipped unchanged and logged with their table, column and row ID; one unusable saved row does not stop the duel server. The valid rewrites and the schema-owned `engine_card_remap_runs` completion marker remain in one transaction. Missing official catalog metadata is copied from the preview with official image URLs; artwork references move before the old cache row is deleted. Foreign keys stay valid. Completed series and finished/started duel decks, setup, snapshots, seeds and command journals are not rewritten; existing bundle-version replay/recovery rules apply. Web and worker processes use the same database. Rolling back a bundle does not reverse completed remaps: saved data may reference official codes absent from the older bundle. Keep a bundle containing those targets, or restore a matched application DB backup while reconciling intervening writes; see the VM runbook. Never blindly reverse remaps.

Deck import, code normalization, legality/pool counting and numeric scenario-card resolution also apply validated remaps at read time. Retained preview rows have OT `0x100` set without changing their TCG/OCG bits, so `both`/`tcg`/`ocg` pools keep their existing semantics. Unlisted cards remain unlimited. The shared card types expose optional `prerelease: true`, available in deck-builder search (`POST /api/decks/cards`) and card info (`GET`/`POST /api/duels/cards`); UI labels can read it later.

The web image route tries YGOPRODeck first and, after a 404 for full/small images, retries `https://pics.projectignis.org:2096/pics/{passcode}.jpg`. The duel UI and 3D art use those full/small routes, so temporary passcodes receive the existing Ignis fallback. Cropped images have no Ignis fallback and may return 404. No image/UI changes are needed for this feature.

The scheduled workflow uses this same merge for names and candidate validation. It reports added, removed and graduated previews (including old-to-official codes), every deduplication drop, and added/removed release filenames. Loaded release and prerelease scripts participate in the advisory initialization probe and multiplayer scan even when those scripts did not change. Tree discovery receives `GITHUB_TOKEN` in CI, deployment, staging and candidate preparation. Tree/database downloads retry HTTP 403, 429 and 5xx three times, using `Retry-After` (seconds or HTTP date); `x-ratelimit-reset` also applies only when `x-ratelimit-remaining` is `0`. Exponential delays apply when no future server deadline is available. Each delay is capped at 60 seconds; exhausted retries fail the command so an operator can rerun it. Publication still accepts only the three existing pin files; no preview registry or release list is generated or committed. Bundle cache keys in CI, deployment and staging include both merge and prerelease-history helpers. Core-only checksums remain unchanged; `expected-sha256.txt` files contain WASM/Domain Lua hashes, not card-data hashes.

The C6 geometry audit scans every Lua directory in the prepared `card-scripts/` corpus and requires an exact match with `packages/duel-server/tests/fixtures/c6-geometry-audit.json`, including a reviewed reason for every expression. Prerelease support restores four expressions in `pre-release/c100458010.lua`, `c101402090.lua` and `c101403030.lua`, bringing the stock audit from 169 to 173 expressions. The fixture documents their masks/mirroring and limits; passing it does not prove effect gameplay. Castellan `101402090` has an unresolved FFA4 side-opponent geometry case, and opponent-field zone masks in Tag need a gameplay proof. Retained-script initial-effect smoke checks cover legacy/pinned 1v1, FFA3/FFA4 and Tag in normal/Domain modes, but do not exercise those callbacks. These require separate multiplayer rules/tests before claiming complete effect compatibility. Retained scripts excluded only because their passcode lacks a database row keep their `requiresAbsentCode` guard; the scan never skips `pre-release/`.

The merged database also makes Bingo Card, Red-Eyes Black Dragon Exceed, Swiftwind Panther Warrior and Seventh Barian's loadable in the multiplayer table. Their database-absence exceptions are removed. The existing R1/R2 overlays for the first three stay in place; Exceed's summon triggers cannot run on the generic board, so the table records that limit explicitly. Seventh Barian's moves from `R1_NO_CHANGE` to a real R1 suffix: its End Phase damage counts Xyz Monsters on all fields and affects every living duelist (ADR-0002 Q3), while its Extra Deck summon flags use one key per FFA seat or Tag team (Q6). The R1 total remains 93.

Re-record `scripts/native/golden.tsv` with `packages/duel-server/scripts/run-nduel.sh --record`, then verify it with `--check`, after changing the merged database or release filtering even when the three source pins stay the same. The native driver samples the effective card pool, so the merge changes seeded duels and their recorded hashes. Overlay edits also require an explicitly recorded fingerprint. This prerelease update rebuilds the native test driver and records all 80 duels (`n2`, `n3`, `n4`, `tag`, 20 seeds each, 60 turns, 3,000 LP); the subsequent check verifies 80 rows with zero skips or mismatches. All 80 rows change while the three fingerprint headers stay unchanged because pins, overlays and patches did not change. WASM engine checks reuse existing cores without rebuilding them. The review correction restores all five alternate artworks and re-records/checks the same 80-duel matrix from fresh card dumps using the existing native driver: 42 row hashes change, all fingerprint headers remain unchanged, and the check has zero skips or mismatches.

## Shared card-script bug fixes: Steamed Sabersaurus (3743515)

`domain-core/multi-scripts` appends/replaces scripts only for tables with more than two seats;
`domain-core/lua/domain.lua` and its legacy counterpart apply Domain rules only. Neither
alone covers every engine. `card-script-patches/MANIFEST.json` now describes shared suffix
overlays installed directly into `card-scripts/` by `scripts/card-script-patches.ts` during
both fresh and cached `prepare-data.ts` runs. All Standard/Domain, legacy/pinned 1v1 and
multiplayer readers (including native) therefore load the same corrected card script.

The first patch overrides only `atkcon` and `atktg` in upstream
[`official/c3743515.lua` at CardScripts `37f270dc813a`](https://github.com/ProjectIgnis/CardScripts/blob/37f270dc813a/official/c3743515.lua).
The stock condition swaps attacker/target and dereferences nil on an opponent's direct
attack. Both callbacks now use `Duel.GetBattleMonster(tp)`; no own battling monster means
false/no target. The face-up Dinosaur/other-monster checks, destruction, 2000 ATK boost,
count limit and Battle Phase reset remain intact. The reviewed stock SHA-256 is
`0efda8bf0727ede4a05fc10dd06479b227664670d45d50b36de382d465af80d3`;
preparation fails if upstream changes it. Cached preparation replaces the marked suffix,
so it is idempotent and needs no download at unchanged data pins. The prepared
`card-scripts/.host-card-script-patches.json` tracks installed entries so retiring a
patch also restores cached stock bytes. Fresh and cached installs use the same bundle
hash ordering, including bundles with optional built-core metadata.

`integrity.cardScriptPatches` hashes bytewise-sorted `<stockPath>\0<patched-file SHA-256>\n`
records and participates in `bundleVersion`. `scripts` still identifies the upstream
archive; `domainLua`, `domainLegacyLua`, `multiScripts`, core pins and WASM bytes do not
change. Deployment must re-prepare the bundle and ship its patched script **and manifest**.
Existing cores can be reused; no WASM rebuild is necessary. CI/production/staging bundle
cache keys include the patch recipe and suffix files. Drain active duels first; the new
bundle version has the same recovery/replay consequences described below. Native golden
metadata now also records `card-script-patches-sha256` using the folder-hash algorithm;
re-record and check all 80 rows when this overlay changes, rather than editing its header.

Host error policy is unchanged. Legacy Standard/Domain 1v1 queues `OcgLogType.ERROR` (0) and
`UNDEFINED` (3) at `src/legacy/engine.ts:227-230` and throws after processing messages at
`:565-568`. Pinned Standard/Domain 1v1 and all multiplayer paths use the same policy at
`src/engine.ts:377-380` and `:920-923`. FROM_SCRIPT (1) and FOR_DEBUG (2) are ignored except internal notes.
`src/domain-core.ts:38` forwards the same handler. `src/worker.ts:79-81` returns errors to
the client; `src/worker-client.ts:99-101` rejects the request. For a player response,
`src/host.ts:2483-2486` converts it to HTTP 400 before journaling; this does not itself
record a duel loss. `engine-throw` is the fuzz harness invariant, not a core WIN reason.

In contrast, [EDOPro's `Game::MessageHandler`](https://github.com/edo9300/edopro/blob/c250b6ab9bebb6eca9fdd07ee0c5bd2278426e81/gframe/game.cpp#L3932)
adds debug messages and returns. The pinned [core interpreter](https://github.com/edo9300/ygopro-core/blob/efc21aa433b88cd35b7c37db4072a35c58d9d435/interpreter.cpp#L389)
already catches Lua failures: `call_function` returns false, `check_condition` returns
false, and a failed operation coroutine is cleaned up and returns `COROUTINE_ERROR`.
A host-only tolerant mode is therefore feasible without rebuilding the core. Recommend
an owner-approved opt-in policy that logs/deduplicates callback errors while retaining
fatal resource/setup failures and native traps. The log API has no dedicated script-error
type: ERROR also covers initialization, missing/null callbacks and Lua API checks, so
blanket suppression cannot safely distinguish them. Operations can retain actions done
before the error; tolerance provides no rollback. No tolerant mode is added here.

## Run by hand

Use **Actions → Engine data update → Run workflow**, or:

```sh
gh workflow run engine-data-update.yml -f dry_run=true
```

Optional `scripts`, `database`, and `strings` inputs accept full 40-character commit SHAs. Omitted inputs use the latest upstream default-branch commit. A candidate must equal or descend from the current pin: behind or diverged SHAs are refused. A workflow dry run applies candidates only in the disposable preparation checkout, validates them, and uploads the report without publishing. The workflow must be on the default branch before scheduled/manual runs are available; the base falls back to `main` when event repository metadata is absent.

Locally, use Node 22 from the repo root:

```sh
npm ci
prlimit --core=1:1 -- node --import tsx packages/duel-server/scripts/update-engine-data.ts --dry-run
```

The default report is `.status/engine-data-update.md` (ignored by git); `--report <path>` changes it. Use `--scripts <sha> --database <sha> --strings <sha>` to reproduce a candidate, or omit `--dry-run` to apply pins. A local dry run probes the downloaded candidate database/scripts and checks overlays without modifying pins, then removes all downloaded temporary data. `GH_TOKEN` or `GITHUB_TOKEN` can raise the public API rate limit. API/download failures fail the command; compatibility findings remain advisory. `--defer-validation` is for the workflow's first stage; its mandatory validation stage runs the probe after `npm run duel:prepare` and verifies the prepared manifest matches the candidate pins.

## Review the report

The first line is `Needs review: N conflicts, M risks, K shared-script changes, probe errors P, overlay check exit X`. A successful overlay check does not clear stock-hash conflicts or other findings.

- **New cards in this update:** near the top, the merged old/candidate CDB passcodes determine additions independently of script changes. Each product has a collapsible list with CDB names, passcodes, pre-release marks and 80-pixel images. BabelCDB `release-SET.cdb`/`prerelease-SET[-en].cdb` codes take priority; base/generic rows use the earliest known YGOPRODeck printing, or an unknown-set group. Product release dates come from the set catalog; each card's original TCG/OCG dates are labeled separately. Two best-effort catalog requests have 15-second deadlines: failures keep CDB names/source codes and omit unknown dates. Temporary pre-release passcodes use PR #226's Ignis image URL; official codes use YGOPRODeck. Removed cards and old-to-new pre-release graduations are listed separately. Final smoke validation removes excluded previews from additions. The report artifact retains every row; GitHub copies truncate whole rows, close set blocks, and show “N more, see the report artifact.” The PR body remains bounded to 60,000 UTF-8 bytes, below GitHub's 65,536-character limit.
- **Commits, release/prerelease databases and scripts:** compare links show upstream changes; release filename additions/removals, loaded passcodes, added/removed/graduated previews and deduplication drops are listed. New/changed official `cNNN.lua` scripts include names from the merged candidate database. Database-only changes can add cards without a script diff; loaded release and prerelease scripts are still probed.
- **Overlay conflicts:** every manifest stock hash is compared with its explicitly reviewed `stockPath`, or `official/cNNN.lua` by default. A nonofficial copy does not silently become the baseline: without a reviewed path, the report says `removed`. Reconcile affected overlays with upstream and review baseline hashes; do not replace hashes merely to silence a conflict.
- **Card script patches:** every shared patch baseline is compared with candidate stock. A changed or removed file is reported as **patch needs review** and blocks the candidate before any pin rewrite or bundle preparation. The workflow failure summary and report artifact retain the affected paths and hashes, including when the summary is truncated. Current pins and the deployed bundle remain in service until the patch is reconciled or explicitly retired; the updater never drops the fix or accepts a new stock hash automatically. Historical baseline citations use abbreviated commits so the pin-rewrite guard does not mistake them for active pins.
- **Changed shared scripts:** every added, changed or removed `.lua` outside `official/cNNN.lua` is listed, including utility, constants, procedures, card-specific helpers and nonofficial scripts. Utility/procedure/constant changes flag `mp-utility.lua` for review. Check shared multiplayer assumptions even when no official card changed.
- **New multiplayer risks:** new/changed official scripts and loaded release scripts (including retained pre-release scripts) flagged F or ambiguous O and absent from both multiplayer lists need a rule, tested overlay or format-specific ban decision. Releases are scanned even when their scripts did not change.
- **Changed listed cards:** changed scripts already in `MULTIPLAYER_CARD_RULES` or `MULTIPLAYER_FORBIDDEN` without an overlay need renewed review. This section also includes `formatGap` cards, including unchanged cards whose scan finds Tag coverage missing.
- **Core probe status:** uses the installed **npm `ocgcore-wasm@0.1.2`**, the oldest live/default Standard 1v1 core, without an optional build cache. It loads candidate `constant.lua`, `utility.lua`, changed scripts and loaded release scripts, asserts availability of referenced `Duel.`, `Card.`, `Effect.`, `Group.` names and uppercase globals, and inserts each selected official or retained pre-release card into a deck to exercise `initial_effect`. Findings come through the core error handler and host setup checks. A separate process limits hangs to 60 seconds. Errors and timeouts appear in the report without failing the job. The lexical scan is best effort; it does not prove dynamic symbol usage or play out effect callbacks. Investigate incompatibilities separately; the updater never changes core pins.
- **Golden hashes — required in the data-update PR:** after reconciling the candidate, run `run-nduel.sh --record` against its prepared bundle, review and commit the golden diff, then run `run-nduel.sh --check`. `golden.tsv` records a SHA-256 fingerprint of the three data pins (canonical compact JSON in scripts/database/strings order). It is historical metadata, never synchronized automatically. Changed or missing metadata makes `--check` fail before a build with `data pins changed: re-record with run-nduel.sh --record`. The header also records `multi-scripts-sha256`, `patches-sha256` and `card-script-patches-sha256`: SHA-256 over bytewise-sorted `<relative path>\0<file SHA-256>\n` records for every regular multiplayer/shared overlay file, matching `multiScriptsFolderHash`, and only `*.patch` files in the patch folder, matching the core cache keys’ input selection (README edits do not invalidate golden). Changed or missing folder metadata fails before a build with `overlay/patches changed: re-record with run-nduel.sh --record`. The native CI job checks all committed golden rows only when core patches/pins, overlays, native tooling or data pins change, and on manual dispatch. It compiles the nduel driver against the ASan/UBSan library already built by `test:native`, then uses `NDUEL_SKIP_BUILD=1` to avoid a second core build. Both `--record` and `--check` require `NDUEL_PATCHES` and `NDUEL_PATCH_LIMIT` to be unset, since their headers describe the complete repository patch series. Disabling nightly for the automated dispatch does not waive this review step.
- **Validation:** bundle preparation must succeed. Review probe findings, resolve stock conflicts, rerun the overlay check, re-record golden hashes in the PR, and review CI before merging.

**Live-duel warning:** a merged data bump changes `bundleVersion`. Active duels with a different bundle version are interrupted on recovery. Drain active duels and **merge at a quiet time**; deploy preflight can refuse while duels remain active. **Replay-loss warning:** each bump also makes replays of all earlier duels with a different bundle version unavailable, because the host refuses replay on a `bundleVersion` mismatch. The owner must account for both effects when deciding cadence. Host behavior is unchanged; see the [VM runbook](vm-runbook.md).

## Re-record golden hashes

After reconciling the candidate scripts, overlay (including `MANIFEST.json`) and patch series, use Node 22 to install dependencies and prepare a fresh bundle for the branch's pins:

```sh
prlimit --core=1:1 -- npm ci
DUEL_DATA_DIR="$PWD/data/duel-engine-next" prlimit --core=1:1 -- npm run prepare:data --workspace=packages/duel-server
```

Use a fresh native work directory so cached card dumps and binaries cannot come from old pins. Re-record all four cases, then check the resulting file with the same build:

```sh
unset NDUEL_PATCHES NDUEL_PATCH_LIMIT DUEL_MULTI_SCRIPTS_DIR
export DUEL_DATA_DIR="$PWD/data/duel-engine-next"
export NDUEL_DIR="$(mktemp -d)"
NDUEL_CASES="n2 n3 n4 tag" NDUEL_SEEDS=20 NDUEL_TURNS=60 NDUEL_LP=3000 NDUEL_FUTURE=0 NDUEL_SKIP_BUILD=0 prlimit --core=1:1 -- bash packages/duel-server/scripts/run-nduel.sh --record
NDUEL_SKIP_BUILD=1 NDUEL_FUTURE=0 prlimit --core=1:1 -- bash packages/duel-server/scripts/run-nduel.sh --check
rm -rf "$NDUEL_DIR"
unset NDUEL_DIR
```

Review the row changes and all four fingerprint headers, verify 80 rows were recorded/checked with no skips or mismatches, and commit `packages/duel-server/scripts/native/golden.tsv` in the data-update PR. Merge only after its CI passes. Never refresh the headers alone to bypass a failed check.

Report summaries use HTML entity escaping, so product names do not show literal
Markdown backslashes. Ignis images remain inline: on 2026-10-07, the read-only
GitHub Markdown API rendered the `:2096` image URL for passcode `101402001` through
Camo, and fetching that generated proxy URL returned HTTP 200 `image/jpeg`.
This checks an actual GitHub proxy response, rather than assuming support for the
port; individual missing images can still fail. See GitHub's
[Camo troubleshooting guide](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/about-anonymized-urls).

### Renamed and type-corrected graduations (v3)

The v3 recipe also records individual BabelCDB commit transitions from the immutable
support boundary. A candidate must be a removed main prerelease row and a newly added
main released row in the **same commit**. ATK, DEF, packed level/scales, attribute and
race must all match exactly; race is read as a SQLite decimal string to preserve 64-bit
precision. Effect text must match exactly after replacing only each card's own name
with a sentinel and collapsing whitespace, with at least 40 characters of evidence.
Type flags may change within the same card kind (`type & 7`), but Monster, Spell
and Trap cannot match each other. Both directions must be unique across all historical
snapshots. Same stats alone, approximate names, unrelated quoted-name substitutions,
short/blank text and one-to-many pairs do not establish identity. Missing signals
remain unknown and appear as **unmatched graduation, needs review**, including after
skipped scheduled bumps. Existing name/type matching remains available.

Three measured examples from [BabelCDB BETB release 85e7fd3](https://github.com/ProjectIgnis/BabelCDB/commit/85e7fd3e7c30002a8a2d4047eaf496206b442b85)
are Swift Panther Warrior `101402001 → 77482666` (Swiftwind Panther Warrior),
Alligator's Sword Dragon Knight `101402002 → 4881365` (Alligator's Dragon Knight), and
Destiny HERO - Death Dogma `101402021 → 25158975` (Destiny HERO - Destro-Dogma).
All three retain exact type/stats/race and normalized effect text. Their aliases are
zero and the CDB has no independent artwork identifier: aliases provide no additional
identity signal. [CardScripts 89b88935](https://github.com/ProjectIgnis/CardScripts/commit/89b88935577b0b25d5b1484a0dff52077d54f1fb)
renames all three `pre-release/cOLD.lua` scripts to `official/cNEW.lua` with **100%**
Git similarity and identical SHA-256 bytes; a following commit updates English-name
comments. The committed `tests/fixtures/prerelease-graduations.json` records the real
rows, commits and script hashes. These examples support the conservative text rule;
script similarity is measured evidence, not a fuzzy automatic remap rule.

For reviewed exceptions, edit `packages/duel-server/card-remap-overrides.json`:
`{"OLD_CODE": NEW_CODE}` (numeric target, decimal-string source), or
`{"OLD_CODE": null}` to veto any automatic remap for that source. The default is `{}`.
The source must be a supported historical/dropped main preview and absent from the
retained database; the destination must be a retained main card. Invalid codes,
artwork/token sources or targets stop preparation. Reviewed overrides win over all
automatic mappings; a veto also prevents chains from following that source.
Overrides do not extend the history boundary backwards. Their parsed map and exact
source bytes are embedded in `card-remaps.json`, covered by `integrity.cardRemaps` and
`bundleVersion`; changing even those source bytes invalidates the preparation cache.
No extra publication path is added: scheduled automation still changes only the three
pin files. A human commits override edits as part of reviewed application code.

History cost grows with preview-changing commits since the immutable support
boundary. Each fresh scan needs Git history/network access, reads those commit
trees and distinct non-Rush preview blobs, then reads base/release blobs on both
sides of preview-removal edges. Passcode Sets make removal comparisons linear
per edge. Blob downloads are batched and cached by immutable blob hash for that
scan, as are extracted rows and released snapshots. Workflow bundle caches and
the unchanged-pin prepare fast path reuse the completed extraction/check. A cold
rebuild at new pins still scans the full interval; retaining that interval preserves
graduations across skipped scheduled updates. A durable extracted-transition cache
would need a `(support start, commit, extraction recipe)` key and is deferred.

The same bundle map feeds read/import/validation and the atomic startup migration.
The migration refreshes target catalog metadata from the installed engine only for
rows copied from previews in that transaction. It preserves all existing target
metadata, including YGOPRODeck OCG-only rows with no TCG sets and a different name,
on later scheduled bundle changes. Newly copied cube and draft references display the
official name/type even offline. Historical duel records
retain the existing replay rules. Update all three workflow bundle cache inputs when
adding a matching helper or override input. The database format is now
`official-releases-prerelease-v4`; older recipes rebuild at unchanged source pins.


### Required prerelease script smoke check (v4)

Every fresh preparation registers **every retained prerelease passcode**, including
unchanged scripts and alternate artworks, on installed npm `ocgcore-wasm@0.1.2`.
This minimum-core gate supports native legacy runs and Standard rollback through
`DUEL_STANDARD_1V1_ENGINE=legacy`. The legacy Standard path (`src/legacy/engine.ts`)
loads the npm core without an external WASM binary. Compose defaults Standard to
`pinned`. All engines share the preview pool. Checking only the newer pinned
Standard/Domain/multiplayer cores would admit scripts that break legacy tables.
The newer cores reuse the npm wrapper but supply different WASM bytes. The
`prerelease-engine.test.ts` initialization matrix separately covers retained
previews on legacy/pinned 1v1, Tag, FFA3 and FFA4 in Standard and Domain modes.
Native registration loads the effective script and invokes `initial_effect` without
playing a duel. Each card gets a fresh duel so earlier errors cannot poison later
checks. Optional scriptless Normal Monsters keep the engine's existing behavior.
Card-attributed script-load, missing-script and `initial_effect` errors exclude that
preview from both `datas` and `texts`; released rows are never excluded, even when
their script still resides in `pre-release/`. Artwork previews depending on an
excluded main preview also disappear. Filtered scripts and final database bytes are
hashed only after exclusions. Remaps targeting an excluded preview are suppressed,
so saved source codes remain unknown rather than migrating to a missing target.

The worker isolates synchronous Lua. A thirty-second card timer starts only after
the active-card message, after tsx/DB/WASM startup and fresh-duel initialization.
A separate two-minute setup watchdog aborts preparation on infrastructure stalls.
Timeouts/crashes retry that card once in a fresh worker before excluding it and
resuming untested cards. Missing core/helpers, errors naming any non-card Lua script,
invalid progress and other unattributed infrastructure failures stop preparation
without excluding cards. Diagnostic Lua/stderr/timing text goes to the console only.
Artifact errors contain fixed reason codes: `card-script-error`, `missing-card-script`,
`card-timeout`, `worker-crash`, or propagated `main-card-excluded`. Output lists each
**excluded: script error** with its code, name, source and reason, plus counts.
`card-remaps.json.scriptSmoke` retains checked counts, exclusions and suppressed
remaps under the existing integrity hash and bundle version. Weekly inline validation
uses the same checker after installing the reviewed shared card-script patches,
just as fresh preparation does. Deferred reports mark smoke pending; final CI
validation reads the patched prepared artifact, verifies its hash and includes
its exact exclusions in the scheduled report. Cache hits reuse the
recorded check for the same pins/recipe/override inputs. Workflow bundle cache inputs
include both smoke helpers. The format is `official-releases-prerelease-v4`.

This is an initialization check. A callback that fails later during an effect still
needs gameplay investigation. Runtime EDOPro-style logging and the manually reviewed
card block list are maintained on the separate `fix/script-error-tolerant` branch.

## Runtime card script errors

Owner decision, 2026-10-07: use EDOPro behavior on runtime card script errors—report
and continue the duel. This applies to legacy Standard/Domain 1v1, pinned 1v1,
Tag, FFA3 and FFA4. `DUEL_SCRIPT_ERRORS=tolerant` is the default; use
`DUEL_SCRIPT_ERRORS=strict` to restore throwing on these errors for new duels.
Strict mode also ignores card-script errors in view queries so live play, recovery
and replays remain deterministic.
Unknown values fail configuration. Production Compose passes `DUEL_SCRIPT_ERRORS`;
staging passes `STAGING_DUEL_SCRIPT_ERRORS` to the same container setting. Recreate
the duel container after changing it. The resolved policy is saved in the duel's
private setup/journal; recovery and replay keep that policy even after the server
setting changes. Older journals without this field recover in tolerant mode.

The exact pinned core (`efc21aa433b88cd35b7c37db4072a35c58d9d435`) recovers:
[interpreter.cpp](https://github.com/edo9300/ygopro-core/blob/efc21aa433b88cd35b7c37db4072a35c58d9d435/interpreter.cpp#L389)
consumes a failed protected call and returns false; `check_condition` returns false.
Its coroutine path logs errors, releases the thread, restores call state and returns
`COROUTINE_ERROR` ([lines 571–635](https://github.com/edo9300/ygopro-core/blob/efc21aa433b88cd35b7c37db4072a35c58d9d435/interpreter.cpp#L571)).
[ExecuteCost/Operation/Target](https://github.com/edo9300/ygopro-core/blob/efc21aa433b88cd35b7c37db4072a35c58d9d435/processor.cpp#L19)
finish and clean up for every non-YIELD return, including that error. The failed
function may have already changed game state; tolerance does not roll those changes
back. EDOPro's [MessageHandler](https://github.com/edo9300/edopro/blob/c250b6ab9bebb6eca9fdd07ee0c5bd2278426e81/gframe/game.cpp#L3932)
adds the diagnostic to its debug log and continues.

The server tolerates only `OCG_LOG_TYPE_ERROR` (0) during `duelProcess`, outside
script loading, with a Lua file/line diagnostic identifying a `c<passcode>.lua`
card script. A shared helper's error needs a card frame in the immediately
preceding core traceback for attribution. Script loading is tracked around the
existing `_ocgapiLoadScript` export, including loads triggered by cards during
processing, so both syntax errors and top-level runtime errors in a loaded chunk
remain fatal. Initial deck/setup failures, missing scripts, `UNDEFINED` (3),
unattributed errors, stack/memory/panic diagnostics and protocol failures remain
fatal. View queries and the runtime FFA attack-target/elimination scripts use a
separate scope: card callbacks there are tolerated even in strict mode, with one
private telemetry sample per card and no event or duel-log line. Nested automatic
card loads remain fatal. Query frequency differs between live play, recovery and
replay, so query errors never change event IDs or processing error ordinals. Fatal
Lua diagnostics also use generic player-facing text. The WASM binaries are unchanged. A callback can fail without a traceback,
so traceback presence alone is not used to distinguish loading from runtime.

Each answer (including its automatic core responses) produces at most one
deterministic `script-error` event and matching quiet duel-log line: “Card script error: an effect may not have resolved correctly.
The duel will continue.” Card identities and raw Lua diagnostics are omitted from
all player and spectator messages, including with public-hand settings. This
conservative text never names a hidden card. `DuelEngineView.events/log` flow through
the existing worker views and room snapshots; `duel:changed` makes the client fetch
its view, and `MatchSheetLog` displays the text in live duels and replays. Script errors have no
centre banner. Event/log IDs depend only on the core sequence; timestamps and
counters never enter views or the command journal. Strict-mode client errors also
use generic text; their raw diagnostic remains in private telemetry. Errors never
end a duel merely because their count is high. A batch exceeding 100,000 core
process calls without a player prompt raises an engine loop invariant failure.
The host interrupts the duel with an “Engine loop” reason and discards the worker,
including during bot turns, eliminations and recovery. The failed command is not
journaled; the response returns the interrupted duel rather than rejecting the
player's answer. Later room requests do not replay the loop, including polls from
previously eliminated seats.

Private worker replies send card code, reported script file/line, raw message,
mode, table format, engine, policy, journal position and per-request error ordinal
to the host. Query ordinals are separate from process ordinals.
Process telemetry is sampled at most 20 times per card per engine instance; the
host also caps persistent samples at 20 per duel/card across recoveries. Query
samples use a separate stable per-card key. Samples beyond these limits do not
write SQLite rows or JSON error logs and do not affect gameplay events.
The host emits a JSON `card_script_error` log with the numeric `duelId` and saves
`card_script_errors` counters in the shared SQLite database. The idempotent schema
migration also creates `card_script_error_occurrences` with the key
`(duel_id, command_hash, error_index)`, card code and creation time. The command hash
covers the saved seed, accepted journal position and attempted command (with
default elimination flags normalized), so
recovery/retries count an occurrence once while different rejected branches remain
distinct. Query telemetry uses a fixed per-card key independent of journal/view
frequency. Occurrence rows for completed, interrupted, cancelled or deleted duels
expire after 30 days; active/lobby duel keys remain to prevent recovery recounts.
Cleanup runs on recorder startup and daily during telemetry. Cumulative
`card_script_errors` counters are retained. Fatal answer and elimination failures discard the advanced worker before
recovery. Replay workers and standalone journal replay have no recorder. A database write failure emits
`card_script_error_persistence_failed` with the same diagnostic and does not reject
the duel answer; that occurrence cannot be counted until a later recovery succeeds.

List the top cards from the repository root with Node 22 (no engine resources
or environment-file loading required):

```sh
prlimit --core=0 npx tsx packages/duel-server/scripts/top-script-errors.ts /path/to/bot.sqlite 20
```

The read-only command outputs JSON ordered by count, then passcode, with the last
message, file, line, mode, duel ID and time. Use its `code` field to add an admission
block below while a script is investigated. Error counters and the admission file
are operational data; neither changes engine bundle integrity or `bundleVersion`.

### Temporarily block a card from new duels

`packages/duel-server/card-block-list.json` ships as `[]`. To block a card while its script is investigated, add an entry with its engine passcode and a short reason players can understand:

```json
[
  { "code": 12345678, "reason": "Its effect script is being investigated" }
]
```

The illustrative passcode does not add a block to the repository. Sabersaurus
(3743515) is fixed by the shared card-script patch above and should not be blocked
for its former bug. Runtime-error tests register a synthetic card callback from
`tests/fixtures/card-scripts/runtime-error.lua`, independent of the installed script. Commit the intended policy, deploy the duel server, and restart it after each edit. The file is read once per process. It is required beside the package's `dist` directory; the Docker `duel` stage copies it there, and `duel-bundled` inherits it. A deployment that copies compiled JavaScript separately must also copy this file. Missing or malformed policies fail the admission/search check instead of allowing cards silently. Entries require a unique positive passcode of at most `4294967295` and a nonblank reason.

A listed card is unavailable in Normal and Domain decks at 1v1, Tag, FFA3 and FFA4 tables, including casual tables with `validateDeck=false`, no banlist, and draft pools. Main, Extra, Side and Deck Master cards are checked. Alias links are followed in both directions through the engine catalog, so blocking any artwork also blocks its original, other artworks and named alias variants. Codes in the list are first resolved through the bundle’s validated `loadCardPasscodeRemaps`, so a blocked prerelease code follows graduation to its official passcode in admission, search, card details and preset boards. Usually list the original passcode once. If multiple entries refer to the same alias family, the first entry supplies its reason.

Deck-builder search retains blocked matches with an Unavailable label and the configured reason. Adding and selecting them as Deck Master is disabled. Importing or keeping an existing deck does not grant permission to start a duel: deck validation and duel admission reject it with `<card name> is unavailable: <reason>`, and validation reports reference every blocked copy.

This is an admission policy, separate from the engine bundle. Editing it does not change `bundleVersion`, Lua scripts or WASM, and it does not change how an already running duel or its replay executes. Remove an entry and redeploy/restart to make the card available again; no engine rebuild is needed.

### Automatic blocks after repeated script errors

In tolerant mode, a card becomes unavailable for new duels and deck checks after
runtime errors in **3 distinct duels within 7 days**, involving at least **2 distinct
human accounts**. Practice-bot duels count, but one account alone cannot trigger a block. Repeated events, retries,
queries and recoveries in one duel contribute only one duel to the threshold.
`DUEL_SCRIPT_ERROR_BLOCK_DUELS` defaults to `3` (integer `2`–`1000000`);
`DUEL_SCRIPT_ERROR_BLOCK_WINDOW_DAYS` defaults to `7` (integer `1`–`30`, within the
telemetry retention period). Compose passes both settings to the duel service.
Invalid threshold/window settings log a warning and use their defaults; they do not
prevent host startup. Recreate that service after changing settings. `DUEL_SCRIPT_ERRORS=strict` ignores
auto blocks and strict errors never trigger them; the manual list remains enforced.

The shared SQLite migration adds `card_script_auto_blocks` with passcode, neutral
reason, block time, distinct-duel and sampled-error counts, threshold/window,
bundle version, script SHA-256, the helper filenames named by the recorded diagnostic
and traceback, and optional clear time. New occurrence rows include
resolved code, script hash and saved error policy. Historical rows without revision
metadata cannot trigger a block. Counts use the current script revision, validated
passcode remaps and the configured rolling window. The existing 20-sample cap still
applies. A block persists beyond that window until the script changes or an operator
clears it; window expiry alone does not grant repeated chances to a broken script.

On startup and after accepted telemetry, a different resolved script identity clears an auto block.
The comparison follows core near-code aliases, official/prerelease basename priority,
artwork fallback and installed shared card-script patches. An unrelated data update
with identical script bytes keeps the block. A changed script starts a fresh counting
revision. The identity hashes the card script plus only the shared Lua helpers named
by those errors, multiplayer suffixes and mp-utility.lua, and the emitted legacy Normal
chain.lua transform. Helper names are stored when the block is created and reused for
startup checks and production/candidate comparison. Changes to unrelated helpers keep
the block, so a scheduled helper update no longer lifts every card's block. A hash failure
logs one line and lifts that row without preventing server startup. Blocks are scoped independently
to legacy/pinned 1v1 and multiplayer, and to Normal/Domain; a multiplayer error
never blocks a 1v1 deck. Automatic blocks cover the exact failing passcode,
near aliases (absolute passcode difference below 10) that load its script, and their
validated graduation remaps. Far aliases remain admitted. Manual
blocks keep the complete alias-family behavior above. The small operational block table is created with a composite
(passcode, engine kind) key. The manual list is applied first and its reason wins
across the whole alias family. Admission arrays and catalog indexes are cached by manual-list identity and active
block signature; deck/search/details reads never hash scripts or write block rows.
Operator clears remain visible on the next request. Players see only the usual `<card name> is unavailable`
message with `Its effect script is being investigated`, never Lua diagnostics.

To clear an auto block without clearing telemetry or changing the manual list, run
this small command with Node 22 from the repository root (no environment-file loading):

```sh
prlimit --core=0 -- node --import tsx packages/duel-server/src/clear-script-auto-block.ts 12345678 /path/to/bot.sqlite /path/to/duel-engine
```

In the deployed duel container, use
`node /app/packages/duel-server/dist/clear-script-auto-block.js 12345678` via
`docker exec <duel-container-id>`. It uses the container's existing `DATABASE_PATH`
and `DUEL_DATA_DIR`. Either the old or graduated passcode is accepted. Clearing
establishes a fresh counting baseline; new errors in the configured number of distinct
duels can block it again. There is no restart requirement for a clear.

Auto blocks are host admission state only. They never enter worker options, saved
setup, commands, journal identity, recovery or replay. A currently running duel is
never changed or interrupted by a threshold being reached.

### Production script errors in the scheduled PR

The scheduled workflow adds **Script errors in prod (last 7 days)**. It includes the
top 20 cards by sampled error count plus active auto-blocked cards, including blocks
with zero recent samples. Columns are passcode, card name, distinct duels, sampled
errors, auto-block status and whether the candidate changes the script. No player
names, Discord IDs, duel IDs/slugs, reasons or Lua diagnostics enter this public
section. Auto blocks appear first; the section is capped at 12,000 UTF-8 bytes and
100 cards, escapes Markdown/HTML/mentions and survives PR-body truncation.

Deployment already reaches `/opt/yugioh-bot` using the `VM_HOST`, `VM_USER`,
`VM_SSH_PRIVATE_KEY` and optional `VM_PORT` secrets (default `22`). A separate
`prod-errors` job reuses that SSH path with **no checkout, dependency installation
or GitHub write permissions**. It invokes only the fixed deployed command:

```sh
sh /opt/yugioh-bot/scripts/prod-script-errors.sh
```

The wrapper identifies the running production duel container by service and Compose
working-directory labels, without loading Compose or environment files. It executes
the deployed `dist/prod-script-errors.js` entrypoint. That command opens the existing
SQLite database with `readonly: true`, `fileMustExist: true` and `query_only = ON`;
it aggregates a fixed seven-day window in SQLite, returning the top 20 rows plus
up to 100 active block scopes inside a read transaction. It never runs migrations,
writes or caller-supplied SQL. Card names and aliases are fetched on demand; it
never loads the full card catalog. SQLite page caches are capped at 1 MiB per DB.
Node runs with `--max-old-space-size=32 --max-semi-space-size=2`. Validated remaps,
core script lookup and script hashes follow the installed bundle.
A local Node 22 measurement on 2026-10-07 (`/usr/bin/time -v`) used a read-only
export from a 3.4-MiB database backup populated with 100 active block scopes:
87,804 KiB peak RSS, 2.17 seconds, exit 0, valid 100-card output. The heap limit
caps V8 allocations; RSS also includes Node, SQLite and native libraries. This is
local evidence, not a production memory measurement. Only aggregate card fields and hashes used
for candidate comparison are exported; hashes never appear in the PR section.

Set **`VM_SSH_KNOWN_HOSTS`** to the independently verified VM host-key entry in
OpenSSH known_hosts format (`[host]:port` for a nondefault port). This workflow
requires strict host verification and does not bootstrap trust with `ssh-keyscan`.
Set **`ENGINE_DATA_PROD_SSH_PRIVATE_KEY`** to a dedicated export key on the same
VM/user. The job never receives the unrestricted deploy key. Install this full
line in that user's `authorized_keys`, replacing the public-key placeholder:

```text
restrict,command="sh /opt/yugioh-bot/scripts/prod-script-errors.sh" ssh-ed25519 <dedicated-export-public-key> engine-data-prod-export
```

Install the key and host pin through the existing operator process. Without the
dedicated secret, the section says **prod error data unavailable**. No VM configuration is changed
by the scheduled workflow. Temporary runner key files are removed after the SSH step.

SSH has a 40-second deadline, five-second database lock timeout and 64-KiB output
cap. Before uploading any public artifact, the credential job validates the byte
limit, card/count/hash/scope types and field limits, then re-emits only known
aggregate fields; unknown fields and raw remote bytes are discarded. Invalid data
leaves the initialized unavailable snapshot. Missing secrets/host pin, connectivity or permission failures, a stopped duel
container, a deployment predating this command/schema, invalid JSON and artifact
download failures produce **prod error data unavailable**. They never fail the
scheduled preparation/publication path. The separate snapshot artifact expires after
one day; the aggregate snapshot also accompanies the existing 14-day report artifact.

After candidate preparation, final validation compares installed-prod hashes with
the **exact prepared candidate bundle**, including shared card-script patches and
passcode graduation. A changed or removed card script says **auto block will lift**;
unchanged dependency bytes keep the block. Fixes to a recorded helper, overlay-only and legacy
transform fixes also say **auto block will lift** for their engine scope. Manual blocks still win. The snapshot is
advisory and can become stale before deployment. Existing live-duel drain and replay
loss warnings for bundle updates still apply; admission auto blocks do not alter them.
