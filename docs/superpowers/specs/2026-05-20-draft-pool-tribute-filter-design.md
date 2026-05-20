# Draft Pool Tribute/Level Filter — Design

**Date:** 2026-05-20
**Status:** Approved design, ready for implementation plan
**Scope:** Spec B (standalone, UI-only). The match-report timeout and "get duels played" work are tracked separately.

## Goal

Let a drafter filter their card pool by monster summon cost (tribute tier) — No
Tribute (Lv 1–4), 1 Tribute (Lv 5–6), 2 Tributes (Lv 7+) — so they can read
their level curve while deckbuilding mid-draft.

## Where it lives

`packages/web/src/components/cards/card-pool-grid.tsx` — the `CardPoolGrid`
component. This already renders the existing type-filter row
(`All / Effect Monsters / Normal Monsters / Spells / Traps`), search, and sort.
The new tribute row sits **directly beneath the type-filter row**.

`CardPoolGrid` is shared. It renders:
- the draft "Your Pool" panel (the target surface), and
- the my-cubes editor card picker.

The tribute row is added unconditionally, exactly like the existing type-filter
row, so it also appears in the cube editor. This is intentional: it keeps one
consistent control, defaults to "Any" (no behavior change), and is equally
useful when browsing a cube. No per-caller prop/gate.

## UI

A new filter row using the same button pattern as `FILTER_BUTTONS`
(`Button`, `size="sm"`, rounded-full, `aria-pressed`, secondary when active /
ghost when not). The pool panel is narrow, so labels are compact and the row
wraps if needed:

```
[Search cards...                         ]
[All][Effect Monsters][Normal Monsters][Spells][Traps]   (existing)
[Any][No Trib][1 Trib][2 Trib]                           (NEW)
[sort: Newest Oldest Name Type]                          (existing)
```

Buttons are mutually exclusive (single-select), default `Any`.

## Behavior

The tribute tier is an **independent filter dimension** that ANDs with the
existing type filter and the search term inside the current `visible` `useMemo`
(card-pool-grid.tsx:113–132).

Tier mapping from `CardSummary.level`:

| Tier value | Label     | Matches            |
|------------|-----------|--------------------|
| `any`      | Any       | every card         |
| `none`     | No Trib   | monster, level 1–4 |
| `one`      | 1 Trib    | monster, level 5–6 |
| `two`      | 2 Trib    | monster, level 7+  |

Non-monsters have no `level` and match **only** `any`. Therefore selecting any
tribute tier inherently hides spells/traps. Contradictory combinations
(e.g. type `Spells` + tier `1 Trib`) yield an empty list — this is expected and
handled by the existing "No cards match." empty state (card-pool-grid.tsx:251–252).

Sort is unaffected; no new sort option (see Out of scope).

## Implementation shape

1. **Pure helper** (new, exported, unit-testable):

   ```ts
   export type TributeTier = "none" | "one" | "two";

   // null = not a leveled monster (no tribute tier applies)
   export function tributeTierForLevel(level?: number): TributeTier | null {
     if (level === undefined || level === null) return null;
     if (level <= 4) return "none";
     if (level <= 6) return "one";
     return "two";
   }
   ```

   Lives in `packages/web/src/lib/card-types.ts` next to the other card
   predicates (`isMonster`, `isEffectMonster`, etc.).

2. **State** in `CardPoolGridBase`: `const [activeTribute, setActiveTribute] =
   useState<"any" | TributeTier>("any");`

3. **Button config** mirroring `FILTER_BUTTONS`:

   ```ts
   const TRIBUTE_BUTTONS: Array<{ label: string; value: "any" | TributeTier }> = [
     { label: "Any", value: "any" },
     { label: "No Trib", value: "none" },
     { label: "1 Trib", value: "one" },
     { label: "2 Trib", value: "two" },
   ];
   ```

4. **Filter predicate** added to the `visible` `useMemo`, ANDed with the existing
   `matchSearch && matchFilter`:

   ```ts
   const matchTribute =
     activeTribute === "any" ||
     tributeTierForLevel(card.level) === activeTribute;
   return matchSearch && matchFilter && matchTribute;
   ```

   Add `activeTribute` to the `useMemo` dependency array.

5. **Markup**: a new `<div className="flex flex-wrap gap-1.5">` mapping
   `TRIBUTE_BUTTONS`, inserted right after the existing filter-button row
   (card-pool-grid.tsx:225).

## Testing

- **Unit** (`tributeTierForLevel`): `undefined → null`, `1 → none`, `4 → none`,
  `5 → one`, `6 → one`, `7 → two`, `12 → two`.
- **Component** (`CardPoolGrid`): render a pool mixing a Lv4 monster, a Lv6
  monster, a Lv8 monster, and a spell. Click each tribute button and assert the
  visible card set (`data-testid="card-pool-grid"`). Assert selecting a tier
  hides the spell, and that `Spells` + `1 Trib` shows the "No cards match."
  message.

## Out of scope (YAGNI)

- Filtering the center pack (`card-grid.tsx`).
- A "sort by level" option.
- Tribute / level breakdown in the Drafted summary counters.
- Exact-level (Lv 1–12) filtering.
- Any change to the bot, API, DB, or card payload — `level` already flows to the
  UI end-to-end.
