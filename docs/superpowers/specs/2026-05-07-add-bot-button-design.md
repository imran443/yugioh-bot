# Add Bot Button — Design Spec

**Date:** 2026-05-07
**Status:** Approved

## Goal

Add an "Add Bot" button to the pending draft UI so local E2E testing doesn't require manual API calls. The button calls the existing dev-only `POST /api/drafts/[slug]/join-bot` endpoint and is invisible in production.

## Architecture

Two small edits to existing files. No new files beyond the already-created API route.

### `packages/web/app/(app)/draft/[slug]/page.tsx`

Add a `handleAddBot` async function that:
- POSTs to `/api/drafts/${slug}/join-bot`
- Throws `Error(body.error)` on non-OK response (same pattern as `handleStart`/`handleJoin`)
- Calls `fetchDraft()` on success to refresh the player list

Pass to `DraftManageView`:
- `onAddBot={handleAddBot}`
- `isDev={process.env.NODE_ENV !== "production"}` — Next.js bakes this in at build time, so the button tree-shakes out of production bundles

### `packages/web/src/components/draft/draft-manage-view.tsx`

Add props:
```ts
onAddBot?: () => Promise<void>;
isDev?: boolean;
```

Add `addingBot: boolean` local state (same pattern as `joining`, `starting`).

In `getActionSection()`, inside the creator branch (where Start and Cancel buttons render), add the "Add Bot" button when `isDev && onAddBot`:

```tsx
{isDev && onAddBot && (
  <Button variant="secondary" size="sm" loading={addingBot} onClick={handleAddBot}>
    Add Bot
  </Button>
)}
```

Style: `variant="secondary"` keeps Start as the visual primary action. No special badge needed — dev-only visibility is enforced by the `isDev` flag, not by visual labelling.

## Error Handling

On failure, sets the existing `error` state — the same banner already used by Start/Cancel/Join errors. No additional UI needed.

## Testing

- Manual: run dev server, open a pending draft as creator, confirm "Add Bot" button appears and adds a player to the list
- In production build (`NODE_ENV=production`), confirm button is absent
- Existing `drafts-route.test.ts` covers the API route; no new test needed for the button itself
