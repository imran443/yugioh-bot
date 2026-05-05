# Tournament Management Design

**Goal:** Add full CRUD operations to tournament detail page — creator can start, cancel, and modify pending tournaments from the web.

**Approach:** Keep existing `/tournament/[id]` route and `GET /api/tournaments/[id]` (numeric ID). Add DELETE, PUT, POST endpoints alongside. Add action UI to existing detail page.

## Changes

### 1. TournamentCard — Fix linking for pending tournaments
- Make pending tournaments clickable (link to `/tournament/${id}`)
- Currently only active/completed might be linkable

### 2. API Routes — Add to `/api/tournaments/[id]/route.ts`
- **DELETE** — Cancel tournament. Creator only. Blocks completed/cancelled.
- **PUT** — Update name (pending only, creator only)
- **POST** — Start tournament. Creator only. Validates 2+ participants.

### 3. Detail Page — Add action buttons
- **Pending**: "Start Tournament" button + "Cancel" button (creator only). Non-creator sees "Waiting for creator"
- **Active**: "Cancel Tournament" button (creator only)
- **Completed/Cancelled**: No changes, stays read-only

## Edge Cases
- Only creator can start/cancel/modify
- Active tournaments can be cancelled by creator
- Completed/cancelled tournaments cannot be cancelled again
- Starting requires 2+ participants
- Only pending tournaments can have name updated