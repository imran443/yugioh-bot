# Draft cancellation implementation plan

**Goal:** Apply the owner's 2026-10-09 rule: a host stop cancels the whole draft. It cannot keep picks or create decks or a tournament.

**Architecture:** Delete the web end route and the shared `endNow` method. Keep the shared cancellation transaction and DELETE behavior. Use `canCancel` in the detail response and page. The room bar has one direct Cancel draft button; the old menu option and browser action are removed.

**Stack:** TypeScript, SQLite, Next.js, Vitest, Node 22.

- [x] Check all callers and all completion paths in shared, bot, worker, WS and owner tools. Report other partial-pool completion paths; do not change them.
- [x] Change the API hint test to require `canCancel`; run it and confirm the old response fails.
- [x] Delete the end route and service method. Make the terminal handler cancel only. Change the shared hint, response and page pass-through.
- [x] Remove end-only tests. Keep cancel authorization, retries, rollback, timer and separate-connection race tests. Keep natural completion checks.
- [x] Update the API document, domain context and the superseded plan. Describe the browser UI.
- [x] Build shared. Run only touched test files. Check shared and web types. Use Node 22 and `prlimit --core=0`.
- [x] Review the diff, commit with the required trailers and push the branch. Do not open a PR or merge.
- [x] Delete worktree dependency and build directories. Keep the worktree.

**Validation:** 136 tests passed across the eight touched test files. Shared build and shared/web type checks passed with Node 22.23.3 and `prlimit --core=0`. The API hint test failed against the old response before implementation.
