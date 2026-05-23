# Internal inter-service calls go through a signed-POST primitive with broadcaster/announcer facades in `shared`

**Status:** accepted

Bot and web make HMAC-signed HTTP POSTs to two internal endpoints: the WebSocket server (real-time **Broadcasts** — `/internal/draft/*`, `/internal/tournament/*`) and the bot's announce server (**Announcements** — `/internal/announce/*`). This was copy-pasted across four helper files (`notify-ws.ts` ×2, `notify-ws-tournament.ts`, `announce-bot.ts`) and 36 call sites that each re-supplied `{ url, secret }`. We consolidated it into one internal `signedPost` primitive (HMAC + fetch + error policy) plus two typed factory facades — `createBroadcaster(cfg)` (void, fire-and-forget; covers both ws endpoint families) and `createAnnouncer(cfg)` (returns `AnnounceResult`; bot announce only) — living in `@yugidraft/shared`, with config injected at construction so tests bind an in-memory fake.

## Considered options

- **One unified notifier** — rejected. The announce path returns a result that one caller surfaces to the user (the "Announce in Discord" button awaits `.ok`); Broadcasts are void. A single interface would have to drop that result channel or force it onto void calls.
- **Two fully separate modules**, each with their own HMAC/fetch glue — rejected. Keeps the duplication this change exists to remove.
- **Per-package facades** (in `bot/` and `web/`), extracting only the primitive — rejected. The facade code is identical on both sides, `shared` already performs network I/O (`card-catalog.ts` fetches ygoprodeck), and the payload types already live in `shared/ws`.

## Consequences

- `shared` gains transport code. This is a deliberate acceptance: transport is not excluded from `shared` (precedent: `card-catalog`).
- Two adapters (real HTTP in prod, in-memory fake in tests) make the seam real and testable.
- `draft-timer` (bot) takes an injected `broadcaster` instead of a raw `wsCfg`, removing transport config from that service too.
