# Navbar + Navigation Design

## Approach: Sticky Sidebar + Compact Top Bar

### Layout

```
┌─────────────────────────────────────────────┐
│ TopBar (h-14)                               │
│ [☰]  Yu-Gi-Oh! TM                [Avatar ▾]│
├────────┬────────────────────────────────────┤
│Sidebar │  Content Area                      │
│ w-56   │                                    │
│        │                                    │
│ 🏠 Dash│                                    │
│ 🏆 Tour│                                    │
│ 🃏 Draf│                                    │
│        │                                    │
│        │                                    │
└────────┴────────────────────────────────────┘
```

- Mobile (<768px): Sidebar hidden. Hamburger opens sheet/drawer from left.
- Desktop (>=768px): Sidebar always visible, fixed left. Content has ml-56 offset.

### Components

| Component | File | Description |
|-----------|------|-------------|
| Sidebar | src/components/layout/sidebar.tsx | Fixed left nav with icon+label links. bg-bg-surface with border-r border-border. Active state: bg-accent-primary/10 text-accent-primary. |
| TopBar | src/components/layout/topbar.tsx | Thin bar bg-bg-surface border-b border-border. Left: hamburger (mobile) + title. Right: Discord avatar + username + sign out dropdown. |
| AppShell | src/components/layout/app-shell.tsx | Wraps Sidebar + TopBar + main content. Manages mobile drawer state. |
| MobileDrawer | src/components/layout/mobile-drawer.tsx | Uses existing Sheet component. Slides from left with same nav links. Closes on link click or outside tap. |

### Navigation Items

| Label | Icon | Route | Active match |
|-------|------|-------|-------------|
| Dashboard | LayoutDashboard | /dashboard | exact |
| Tournaments | Trophy | /tournaments | starts with /tournament |
| Drafts | Layers | /dashboard#drafts | starts with /draft |

### Auth Data

TopBar fetches session from /api/auth/session. Discord avatar + name shown in top-right corner. Sign-out clears NextAuth session.

### CSS

Uses existing design tokens: bg-bg-deep, bg-bg-surface, text-text-primary, text-text-secondary, accent-primary, border-border. No new theme values.

### Files to Create/Modify

1. NEW: src/components/layout/sidebar.tsx
2. NEW: src/components/layout/topbar.tsx
3. NEW: src/components/layout/app-shell.tsx
4. NEW: src/components/layout/mobile-drawer.tsx
5. MODIFY: app/layout.tsx - wrap children with AppShell
6. MODIFY: app/page.tsx - redirect authenticated users to /dashboard
7. MODIFY: app/dashboard/page.tsx - remove redundant page-level layout
8. FIX: app/api/dashboard/route.ts - debug dashboard data issue (Discord user ID mismatch)

### Bug Fix: Dashboard Empty Data

The dashboard returns empty data because the Discord user ID from NextAuth session doesn't match the seeded player's discord_user_id. Root cause investigation needed: compare session.user.id value with players.discord_user_id in database. Added _debug field to API response to trace.