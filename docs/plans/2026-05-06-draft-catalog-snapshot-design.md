# Draft Catalog Snapshot Design

**Problem:** The local seed currently creates only a tiny handcrafted `card_catalog`, so the live Legendary Draft is not backed by a complete LOB/MRD/SRL card pool. That incomplete catalog causes real draft packs to reference missing or stale metadata, which shows up as wrong card names or images in the web room.

**Approach:** Replace the handwritten demo catalog with an offline snapshot workflow. Add a one-time snapshot script that fetches the allowed YGOPRODeck sets, normalizes the card data, and saves it to a local JSON asset in the repo. Update `scripts/seed.ts` to seed `card_catalog` entirely from that JSON snapshot so normal local setup stays offline, reproducible, and fast. Keep draft creation and pack generation logic unchanged; only the source of catalog data changes.

**Why this approach:** It avoids repeated upstream API calls during reseeds, reduces the risk of rate limiting or blacklisting, preserves reproducible local environments, and gives the draft room a complete and internally consistent card pool.

**Data shape:** The snapshot should store only the fields the app already depends on: `ygoprodeckId`, `name`, `type`, `frameType`, `imageUrl`, `imageUrlSmall`, and `cardSets`. The initial snapshot scope is the three currently configured sets: `Legend of Blue Eyes White Dragon`, `Metal Raiders`, and `Spell Ruler`.

**Testing:** Add regression coverage that proves the seeded catalog is no longer the tiny demo list and includes cards that were previously missing, such as `Limiter Removal`. Verify the seed still produces valid draft data and that targeted draft route tests continue to pass against the offline snapshot-backed catalog.
