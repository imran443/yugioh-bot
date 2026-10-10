# Released BETB cards retained as previews

Check date: 2026-10-10. Source: [YGOPRODeck, Beyond the Brave](https://db.ygoprodeck.com/api/v7/cardinfo.php?cardset=Beyond%20the%20Brave), with the individual ID requests below. The set response has 100 card identities. Printing codes, names, types and effects identify EN081–EN096. Fifteen responses have an official-size passcode. Audhumla still has a temporary ID; this API does not supply its official passcode. Do not treat that temporary ID as official.

Ignis at BabelCDB `a71a1d9ed118` retains all sixteen rows in `prerelease-betb-en.cdb`. CardScripts `f593bb7514a2` has their scripts. The prepared bundle keeps these engine codes and marks these rows as previews, although the TCG set has been released.

| Printing | Card | Engine code retained | Official passcode known? | API ID checked |
| --- | --- | --- | --- | --- |
| BETB-EN081 | Audhumla, Progenitor of the Frozen Expanse | 101402101 | No | [101402101, temporary](https://db.ygoprodeck.com/api/v7/cardinfo.php?id=101402101) |
| BETB-EN082 | Tigress in Silent Repose | 101402082 | Yes | [99630221](https://db.ygoprodeck.com/api/v7/cardinfo.php?id=99630221) |
| BETB-EN083 | Just Flip a Coin | 101402083 | Yes | [25024929](https://db.ygoprodeck.com/api/v7/cardinfo.php?id=25024929) |
| BETB-EN084 | Kumenyo, the Nine-Hued Deer | 101402084 | Yes | [52123534](https://db.ygoprodeck.com/api/v7/cardinfo.php?id=52123534) |
| BETB-EN085 | Kerolia the Frolicsome | 101402085 | Yes | [98518633](https://db.ygoprodeck.com/api/v7/cardinfo.php?id=98518633) |
| BETB-EN086 | Archidux, the Squid Sorcerer | 101402086 | Yes | [24902348](https://db.ygoprodeck.com/api/v7/cardinfo.php?id=24902348) |
| BETB-EN087 | Skyborne Blue Cularsaw | 101402087 | Yes | [51307986](https://db.ygoprodeck.com/api/v7/cardinfo.php?id=51307986) |
| BETB-EN088 | Half Slice of Nickeline | 101402088 | Yes | [87395095](https://db.ygoprodeck.com/api/v7/cardinfo.php?id=87395095) |
| BETB-EN089 | Chaospawn Bishop | 101402089 | Yes | [24780790](https://db.ygoprodeck.com/api/v7/cardinfo.php?id=24780790) |
| BETB-EN090 | Angelechy Castellan | 101402090 | Yes | [50284408](https://db.ygoprodeck.com/api/v7/cardinfo.php?id=50284408) |
| BETB-EN091 | Angelechy Seneschal | 101402091 | Yes | [86673403](https://db.ygoprodeck.com/api/v7/cardinfo.php?id=86673403) |
| BETB-EN092 | Angelechy Strategy Score | 101402092 | Yes | [13068112](https://db.ygoprodeck.com/api/v7/cardinfo.php?id=13068112) |
| BETB-EN093 | Angelechy Brilliant Move | 101402093 | Yes | [59062857](https://db.ygoprodeck.com/api/v7/cardinfo.php?id=59062857) |
| BETB-EN094 | Angelechy Opposition | 101402094 | Yes | [86457955](https://db.ygoprodeck.com/api/v7/cardinfo.php?id=86457955) |
| BETB-EN095 | Angelechy Endgame Problem | 101402095 | Yes | [12845564](https://db.ygoprodeck.com/api/v7/cardinfo.php?id=12845564) |
| BETB-EN096 | Angelechy Verdict | 101402096 | Yes | [48340269](https://db.ygoprodeck.com/api/v7/cardinfo.php?id=48340269) |

**Option A: keep Ignis preview rows until Ignis releases the official rows.** This keeps its scripts and cross-references together. Preparation will see the later removal/addition in the retained history. Existing name/type or exact text/stat matching will map saved codes; if official names or effect text change, a reviewed override will still be required. There is no fixed upstream completion date. The preview marker persists. Deck imports that use one of the fifteen known official IDs can remain unknown to the engine until then. Search and image data can use a different ID because the daily catalog sync is separate. The eventual data update changes bundleVersion and must follow the duel-drain and replay policy.

**Option B: release rows and copy scripts ourselves now.** This could admit known official IDs sooner, but only fifteen are available from this API. Renaming `cTEMP.lua` to `cOFFICIAL.lua` changes the value from `GetID()`, count-limit keys, string lookups and Lua table names. A reviewed copy must retain the full CDB text/string fields and examine all numeric references, including references between Angelechy cards and references in shared helpers or overlays. Every reference must use a valid row/script pair. Saved temporary codes must map to the new rows. Later upstream releases must replace our copies and maps without duplicate identities, conflicting source/target codes, stale scripts or artwork loss. A local release source and cache/version recipe would need explicit design and tests. Missing Audhumla data prevents a complete sixteen-card graduation. This option was not implemented.

**Recommendation: A.** Keep all sixteen Ignis previews together and use the existing graduation path. The API check proves fifteen passcode identities, not the safety of script conversion. Continue to review unmatched graduations when upstream moves. Initialization smoke checks do not prove effect resolution. Angelechy Castellan's FFA4 geometry case remains open, as documented in the engine data guide.
