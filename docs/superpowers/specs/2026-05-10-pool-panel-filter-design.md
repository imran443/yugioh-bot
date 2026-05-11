# Pool Panel Filter Design

## Goal

Improve the active draft right-side pool panel by making it wider, using authentic Yu-Gi-Oh spell/trap icons, and adding separate filters for Normal Monsters and Effect Monsters.

## Current Context

The desktop draft layout sets the right pool column in `packages/web/app/(app)/draft/[slug]/page.tsx`. The pool UI is implemented in `packages/web/src/components/draft/pool-panel.tsx`, with tests in `packages/web/tests/components/pool-panel.test.tsx`. The panel currently supports filters for All, Monsters, Spells, and Traps. Spell and trap summary icons currently use Lucide icons instead of the provided game-style SVG assets.

## Approved Design

Widen the desktop right pool column by at least 25%, from `17.5rem` to `22rem`. This applies to the `xl` desktop layout only. Mobile and intermediate tablet sheet/sidebar behavior stay unchanged.

Copy `SPELL.svg` and `TRAP.svg` into the web app public assets and render them as image icons in the summary stat cards. Rendering the SVG as an image preserves the original white label text inside the asset.

Replace the broad Monsters filter with two specific monster filters: Effect Monsters and Normal Monsters. Keep All, Spells, and Traps. Filtering should prefer `frameType` values (`effect`, `normal`, `spell`, `trap`) and use the existing type-string checks as fallback.

## Testing

Update pool panel tests to verify the desktop width class, SVG icon image rendering, and new Normal Monster / Effect Monster filters. Existing spell/trap filtering and spellcaster-monster behavior must continue to pass.

## Out Of Scope

This change does not alter the left card preview, the card-choice grid, draft websocket behavior, deck export format, or the mobile pool sheet layout.
