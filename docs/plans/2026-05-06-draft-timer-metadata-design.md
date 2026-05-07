# Draft Timer and Modal Metadata Design

**Problem:** The active draft room can stall at `0:00` without auto-picking, and the pick modal lacks effect text and combat stats even when the user opens a card for closer inspection.

**Root Cause:** The client countdown reaches zero immediately, but the bot only expires overdue picks on a `10s` interval. The web client then refetches the draft state exactly once at zero; if that request lands before the bot has advanced the draft, the UI keeps the stale state and never retries. The missing modal details are a separate data-model gap: the local draft catalog only stores names, frame/type, and images, so the API has no effect text, `ATK`, `DEF`, `attribute`, or `level` values to return.

**Approach:** Fix the timer race at both layers. The bot draft timer should check overdue picks every second so auto-picks happen near the visible deadline. The web expiry-resync hook should retry while the timer is at zero until the authoritative server state actually advances the pick, removes the user's turn, or completes the draft. Keep the server as the source of truth rather than inventing client-side expiry behavior.

**Modal UX:** Using the existing competitive dark-room visual language and the `ui-ux-pro-max` / `frontend-design` guidance, keep the modal dense, legible, and focused. The richer metadata should appear in the modal only: large card art, a readable effect text block, and compact stat chips/rows for monsters. The hover preview stays lightweight for fast pack scanning.

**Data Flow:** Extend the catalog schema, shared card type, snapshot generator, committed snapshot, and seed script to carry effect text and core stats. Update the draft API response builder to pass those values through to the web draft store so the modal can render them without additional fetches.

**Testing:** Add regressions for repeated zero-state retries, for the bot timer cadence behavior, for persisted snapshot metadata, and for modal rendering of effect text and stats.
