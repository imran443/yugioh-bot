# Draft Card Preview Design

## Goal

Improve active draft card inspection by replacing the floating hover popup with a stable desktop preview panel. The draft grid should stay dense and readable while the preview shows the full-resolution Yu-Gi-Oh card image clearly enough to read without covering available picks.

## Current Context

The active draft grid is implemented in `packages/web/src/components/draft/card-grid.tsx`. Grid thumbnails use `imageUrlSmall || imageUrl`, while the existing hover popup uses `imageUrl`. YGOProDeck full images are large enough for the intended preview size; a sampled card image was `813x1185`, while the small image was `268x391`.

## Approved Approach

Use a fixed/sticky left preview panel on desktop. The panel displays the hovered or keyboard-highlighted card with a large full-card image using `card.imageUrl`. The current floating preview is removed so it no longer overlaps the card grid.

## Desktop Behavior

On `lg` and wider layouts, `CardGrid` becomes a two-region layout: a left preview column and a right dense card grid. The preview column is sticky below the existing draft HUD so it remains visible while browsing the current pack. Hovering, focusing, or keyboard-number highlighting a card updates the preview. If no card is active, the preview shows a short prompt to hover or press a number key.

## Mobile Behavior

Mobile keeps the dense grid as the primary interface and does not add a large fixed preview that would reduce usable space. The existing card click behavior remains unchanged: clicking a card immediately attempts the pick when it is the user's turn.

## Details And Fallbacks

The primary desktop preview is image-first. It uses full card artwork with `object-contain` in the real card aspect ratio. A compact details block remains under the large image for practical fallback and quick scan support: name, type/frame, attribute/level when present, stats when present, and effect text. If the image fails, the preview shows a no-image state and the details remain visible.

## Accessibility And Input

The existing listbox/option semantics stay intact. Focus updates the preview just like hover. Existing keyboard shortcuts remain: number keys highlight cards, Enter confirms the highlighted pick, and Escape clears the highlight/preview.

## Testing

Update `packages/web/tests/components/card-grid.test.tsx` to cover the stable desktop preview panel, full-image usage in the preview, keyboard/focus preview updates, no floating fixed overlay, and image-failure fallback details. Keep existing pick behavior tests intact.

## Out Of Scope

This change does not alter draft websocket behavior, pick ordering, draft state shape, card catalog sync, image proxying, or the right-side drafted pool panel.
