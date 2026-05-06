# Draft Room Timer, Preview, and Image Fix Design

**Problem:** The active draft room has three usability issues: the visible pick timer does not count down locally, the desktop hover preview can overlap content above the hovered card, and `Mirror Force` renders without an image because the seeded catalog metadata uses the wrong YGOPRODeck id.

**Approach:** Keep the websocket payload as the source of truth for server draft state, but add a lightweight client countdown hook that decrements the local timer between server syncs. Keep the desktop hover preview, but anchor it to the hovered card's actual DOM bounds using fixed positioning so it no longer depends on hard-coded grid math. Correct the seeded `Mirror Force` metadata to use the real YGOPRODeck id and update the current local SQLite database so already-open draft packs resolve the right image immediately.

**Testing:** Add a client hook test that proves the countdown ticks once per second and stops at zero or when completed. Extend the seed script test to assert that `Mirror Force` is seeded with the correct id and image URLs.
