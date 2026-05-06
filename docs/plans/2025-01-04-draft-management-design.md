# Draft Management Page Design

## Overview

Single page at `/draft/[slug]` that renders different views based on draft status:
- **Pending** → Management view (edit, start, cancel)
- **Active** → Draft room (existing components)
- **Completed/Cancelled** → Read-only summary view

## Architecture

### Page Router (`/draft/[slug]/page.tsx`)
- Fetches draft data via `GET /api/drafts/[slug]`
- Checks `session.user.id` against `draft.createdByUserId` for action permissions
- Renders appropriate view based on status

### Components

**DraftManageView** — New component for pending drafts
- Header: name, status badge, creator, created date
- Player list: joined players, pick counts (0 for pending)
- Config display: pack size, packs per player, pick seconds, set names
- Action bar (creator only):
  - "Start Draft" → `POST /api/drafts/[slug]` (with action=start)
  - "Edit" → opens inline edit or modal for name/config
  - "Cancel Draft" → `DELETE /api/drafts/[slug]` with confirmation
- Non-creator sees read-only view with "Waiting for creator to start"

**DraftSummaryView** — New component for completed/cancelled drafts
- Header: name, status badge, dates
- Player list with final pick counts
- Config display
- "Export YDK" link for completed drafts (if current user is a participant)

### Data Flow
```
GET /draft/[slug] → fetch /api/drafts/[slug] → populate store → render view
Actions → POST/PUT/DELETE /api/drafts/[slug] → refetch → re-render
```

## API Routes

### GET `/api/drafts/[slug]`
- Returns full draft data including players
- Auth required

### DELETE `/api/drafts/[slug]`
- Cancels draft (sets status to 'cancelled')
- Only creator can cancel
- Cannot cancel completed drafts

### PUT `/api/drafts/[slug]`
- Updates name and/or config
- Only creator can modify
- Only pending drafts can be modified

### POST `/api/drafts/[slug]`
- Starts draft (pending → active)
- Only creator can start
- Requires at least 2 players

## Error Handling
- 404 → "Draft not found" page
- 401 → redirect to sign-in
- 403 on actions → "Only the creator can do this" toast
- Network errors → retry button

## Edge Cases
- Active draft: only creator can cancel, non-creators see draft room
- Completed draft: no actions, read-only
- Cancelled draft: no actions, read-only
- User is not a participant: can still view (public within guild)
