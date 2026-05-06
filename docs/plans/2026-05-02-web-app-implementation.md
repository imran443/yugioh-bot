# YugiDraft Web App Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Rebuild the Yu-Gi-Oh drafting and tournament experience as a Next.js 16 web app with real-time drafting via WebSockets, full tournament bracket tracking, YDK export, and a Discord bot that links to the web for all interactive features.

**Architecture:** Monorepo with three processes (bot, web, ws) sharing a SQLite database in WAL mode. Discord bot keeps all commands as a convenience layer but adds deep links to the web app. Web app exposes draft rooms, tournament brackets, player dashboards, and YDK export. Socket.IO handles real-time draft and tournament events.

**Tech Stack:** Next.js 16 App Router, Tailwind CSS v4, Socket.IO, NextAuth.js v5, Zustand, SWR, SQLite (better-sqlite3), Discord.js v14, TypeScript, Vitest, Docker Compose

**Design doc:** `docs/plans/2026-05-02-web-app-design.md`

---

## Phase 1: Monorepo Scaffold

### Task 1: Initialize Turborepo Workspace

**Files:**
- Create: `package.json` (root, workspace config)
- Create: `turbo.json`
- Create: `tsconfig.json` (root)
- Create: `packages/shared/package.json`
- Create: `packages/shared/tsconfig.json`
- Create: `packages/bot/package.json`
- Create: `packages/bot/tsconfig.json`
- Create: `packages/web/package.json`
- Create: `packages/web/tsconfig.json`
- Create: `packages/ws/package.json`
- Create: `packages/ws/tsconfig.json`

**Step 1: Initialize workspace root**

Run from `/home/imran/yugioh-discord-bot`:

```bash
npm install -g turbo
npx create-turbo@latest . --no-git --no-install --package-manager npm
```

**Step 2: Restructure existing bot code into packages/bot**

Move `src/` contents into `packages/bot/src/`:
- `src/index.ts` → `packages/bot/src/index.ts`
- `src/commands/` → `packages/bot/src/commands/`
- `src/interactions/` → `packages/bot/src/interactions/`
- `src/services/` → `packages/bot/src/services/` (will later become shared)
- `src/db/` → `packages/bot/src/db/` (will later become shared)
- `tests/` → `packages/bot/tests/`

**Step 3: Verify bot still builds and tests pass**

Run: `cd packages/bot && npm test && npm run typecheck && npm run build`
Expected: All existing tests pass, typecheck clean, build succeeds.

**Step 4: Commit**

```bash
git add -A
git commit -m "chore: restructure into turborepo monorepo"
```

### Task 2: Create Shared Package

**Files:**
- Create: `packages/shared/src/db/schema.ts`
- Create: `packages/shared/src/db/connection.ts`
- Create: `packages/shared/src/db/index.ts`
- Create: `packages/shared/src/types/index.ts`
- Create: `packages/shared/tests/db/schema.test.ts`

**Step 1: Copy DB code into shared**

Copy `packages/bot/src/db/schema.ts` → `packages/shared/src/db/schema.ts`
Copy `packages/bot/src/db/connection.ts` → `packages/shared/src/db/connection.ts`

Update imports in shared to be relative (no longer `src/db/...`).

**Step 2: Copy types into shared**

Extract type interfaces from `packages/bot/src/services/drafts.ts` and other service files into `packages/shared/src/types/index.ts`.

Types to extract initially:
- `Draft`, `DraftConfig`, `DraftPlayer`, `DraftCard`, `DraftPack`, `DraftPick`
- `Tournament`, `TournamentPlayer`, `TournamentMatch`
- `Card` (from card-catalog)

**Step 3: Update bot to import from shared**

In `packages/bot/package.json`:
```json
"dependencies": {
  "@yugidraft/shared": "workspace:*"
}
```

Replace bot imports:
```ts
// Before:
import { Draft } from "./services/drafts";
// After:
import { Draft } from "@yugidraft/shared/types";
```

**Step 4: Verify bot still builds and tests pass**

Run: `cd packages/bot && npm test && npm run typecheck && npm run build`
Expected: All tests pass, typecheck clean.

**Step 5: Commit**

```bash
git add -A
git commit -m "feat: create shared package with DB schema and types"
```

### Task 3: Move Draft Engine to Shared

**Files:**
- Move: `packages/bot/src/services/drafts.ts` → `packages/shared/src/services/drafts.ts`
- Move: `packages/bot/src/services/card-catalog.ts` → `packages/shared/src/services/card-catalog.ts`
- Move: `packages/bot/src/services/draft-images.ts` → `packages/shared/src/services/card-images.ts`
- Move: `packages/bot/tests/services/drafts.test.ts` → `packages/shared/tests/services/drafts.test.ts`
- Modify: `packages/shared/package.json` (add better-sqlite3, sharp deps)
- Modify: all bot files that import these services

**Step 1: Copy draft engine and card catalog into shared**

Copy `drafts.ts`, `card-catalog.ts`, `draft-images.ts` (renamed to `card-images.ts`) into `packages/shared/src/services/`.

Add barrel exports to `packages/shared/src/services/index.ts`.

**Step 2: Move draft tests to shared**

Copy test files. Update imports to use `@yugidraft/shared`.

**Step 3: Update bot imports**

Replace all bot imports from `../services/drafts` to `@yugidraft/shared/services`.
Replace all bot imports from `../services/card-catalog` to `@yugidraft/shared/services`.
Replace all bot imports from `../services/draft-images` to `@yugidraft/shared/services/card-images`.

**Step 4: Verify all tests pass**

Run: `npm run test --filter=shared && npm run test --filter=bot`
Expected: All tests pass in both packages.

**Step 5: Commit**

```bash
git add -A
git commit -m "feat: move draft engine and card catalog to shared package"
```

---

## Phase 2: Next.js 16 Web App Scaffold

### Task 4: Create Next.js 16 App

**Files:**
- Create: `packages/web/` (via create-next-app)
- Create: `packages/web/src/app/layout.tsx`
- Create: `packages/web/src/app/page.tsx`
- Create: `packages/web/tailwind.config.ts`
- Create: `packages/web/postcss.config.js`
- Modify: `packages/web/package.json`

**Step 1: Scaffold Next.js 16 app**

```bash
npx create-next-app@latest packages/web --typescript --tailwind --eslint --app --src-dir --import-alias "@/*" --use-npm
```

**Step 2: Install additional dependencies**

```bash
cd packages/web
npm install next-auth@5 @auth/core socket.io-client zustand swr lucide-react @next/font
```

**Step 3: Set up design system tokens in Tailwind**

Replace `packages/web/tailwind.config.ts` with design system from the design doc:

```ts
import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./src/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        deep: "#0A0E1A",
        surface: "#141929",
        elevated: "#1E2440",
        "text-primary": "#E8ECF4",
        "text-secondary": "#8892B0",
        "accent-primary": "#7C3AED",
        "accent-secondary": "#A78BFA",
        "accent-cta": "#F43F5E",
        "accent-gold": "#F59E0B",
        "accent-success": "#10B981",
        border: "#2A3150",
      },
      fontFamily: {
        display: ["Russo One", "sans-serif"],
        body: ["Chakra Petch", "sans-serif"],
      },
      borderRadius: {
        md: "8px",
        lg: "12px",
      },
      boxShadow: {
        card: "0 2px 8px rgba(0,0,0,0.3)",
        hover: "0 4px 16px rgba(124,58,237,0.2)",
      },
    },
  },
};
export default config;
```

**Step 4: Create root layout with fonts and dark mode**

`packages/web/src/app/layout.tsx`:

```tsx
import { Russo_One, Chakra_Petch } from "next/font/google";
import "./globals.css";

const russoOne = Russo_One({
  weight: "400",
  subsets: ["latin"],
  variable: "--font-display",
  display: "swap",
});

const chakraPetch = Chakra_Petch({
  weight: ["300", "400", "500", "600", "700"],
  subsets: ["latin"],
  variable: "--font-body",
  display: "swap",
});

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={`${russoOne.variable} ${chakraPetch.variable} dark`}>
      <body className="bg-deep text-text-primary font-body antialiased">
        {children}
      </body>
    </html>
  );
}
```

**Step 5: Verify web app builds**

Run: `cd packages/web && npm run build`
Expected: Build succeeds with no errors.

**Step 6: Commit**

```bash
git add -A
git commit -m "feat: scaffold Next.js 16 web app with design tokens"
```

### Task 5: Set Up Design System Components

**Files:**
- Create: `packages/web/src/components/ui/button.tsx`
- Create: `packages/web/src/components/ui/badge.tsx`
- Create: `packages/web/src/components/ui/sheet.tsx`
- Create: `packages/web/src/components/ui/modal.tsx`
- Create: `packages/web/src/app/globals.css`

**Step 1: Create base CSS with design tokens**

`packages/web/src/app/globals.css`:

```css
@tailwind base;
@tailwind components;
@tailwind utilities;

@layer base {
  :root {
    --bg-deep: #0A0E1A;
    --bg-surface: #141929;
    --bg-elevated: #1E2440;
    --text-primary: #E8ECF4;
    --text-secondary: #8892B0;
    --accent-primary: #7C3AED;
    --accent-secondary: #A78BFA;
    --accent-cta: #F43F5E;
    --accent-gold: #F59E0B;
    --accent-success: #10B981;
    --border-color: #2A3150;
  }

  * {
    @apply border-border;
  }

  body {
    @apply bg-deep text-text-primary;
    font-feature-settings: "tnum";
  }
}
```

**Step 2: Create UI components**

Create `Button`, `Badge`, `Sheet`, and `Modal` components following the design system tokens. Each component should:
- Use `Chakra Petch` for text, `Russo One` for headings
- Use design token colors
- Support responsive sizing
- Have proper hover/focus states
- Respect `prefers-reduced-motion`

**Step 3: Verify components render**

Create a simple test page at `packages/web/src/app/page.tsx` that renders each component.

Run: `cd packages/web && npm run dev`
Expected: Page renders with styled components.

**Step 4: Commit**

```bash
git add -A
git commit -m "feat: add design system components and global styles"
```

---

## Phase 3: Authentication

### Task 6: Discord OAuth with NextAuth.js v5

**Files:**
- Create: `packages/web/src/app/(auth)/login/page.tsx`
- Create: `packages/web/src/app/(auth)/callback/page.tsx`
- Create: `packages/web/src/app/api/auth/[...nextauth]/route.ts`
- Create: `packages/web/src/lib/auth.ts`
- Create: `packages/web/src/middleware.ts`
- Modify: `packages/web/.env.local`

**Step 1: Write the failing test for auth**

Create `packages/web/tests/auth.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { getServerSession } from "next-auth";

describe("Discord OAuth", () => {
  it("requires DISCORD_CLIENT_ID and DISCORD_CLIENT_SECRET in env", () => {
    expect(process.env.DISCORD_CLIENT_ID).toBeDefined();
    expect(process.env.DISCORD_CLIENT_SECRET).toBeDefined();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd packages/web && npm test`
Expected: FAIL (env vars not set).

**Step 3: Configure NextAuth with Discord provider**

`packages/web/src/lib/auth.ts`:

```ts
import NextAuth from "next-auth";
import Discord from "next-auth/providers/discord";

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [
    Discord({
      clientId: process.env.DISCORD_CLIENT_ID!,
      clientSecret: process.env.DISCORD_CLIENT_SECRET!,
    }),
  ],
  callbacks: {
    async session({ session, token }) {
      if (session.user && token.sub) {
        session.user.id = token.sub;
      }
      return session;
    },
    async jwt({ token, account }) {
      if (account) {
        token.accessToken = account.access_token;
      }
      return token;
    },
  },
  pages: {
    signIn: "/login",
  },
});
```

`packages/web/src/app/api/auth/[...nextauth]/route.ts`:

```ts
import { handlers } from "@/lib/auth";
export const { GET, POST } = handlers;
```

**Step 4: Create middleware for guild verification**

`packages/web/src/middleware.ts`:

```ts
import { auth } from "@/lib/auth";
import { NextResponse } from "next/server";

export default auth((req) => {
  const { pathname } = req.nextUrl;
  const session = req.auth;

  // Public routes
  if (pathname.startsWith("/login") || pathname.startsWith("/api/auth")) {
    return NextResponse.next();
  }

  // Require auth for everything else
  if (!session) {
    const loginUrl = new URL("/login", req.url);
    loginUrl.searchParams.set("callbackUrl", pathname);
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
});

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
```

**Step 5: Create login page**

```tsx
// packages/web/src/app/(auth)/login/page.tsx
import { signIn } from "@/lib/auth";

export default function LoginPage() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-deep">
      <div className="text-center">
        <h1 className="font-display text-4xl text-text-primary mb-4">
          YugiDraft
        </h1>
        <p className="font-body text-text-secondary mb-8">
          Competitive Yu-Gi-Oh drafting
        </p>
        <form
          action={async () => {
            "use server";
            await signIn("discord", { redirectTo: "/dashboard" });
          }}
        >
          <button
            type="submit"
            className="bg-accent-primary hover:bg-accent-secondary text-white font-body font-semibold px-8 py-3 rounded-lg transition-colors duration-200 cursor-pointer"
          >
            Sign in with Discord
          </button>
        </form>
      </div>
    </div>
  );
}
```

**Step 6: Test auth flow**

Set up a test Discord application (CLIENT_ID and SECRET in `.env.local`).
Run: `cd packages/web && npm run dev`
Expected: Login page renders, Discord OAuth button works.

**Step 7: Commit**

```bash
git add -A
git commit -m "feat: add Discord OAuth auth with NextAuth.js v5"
```

---

## Phase 4: WebSocket Server

### Task 7: Socket.IO Server for Draft Rooms

**Files:**
- Create: `packages/ws/src/server.ts`
- Create: `packages/ws/src/rooms.ts`
- Create: `packages/ws/src/events.ts`
- Create: `packages/ws/src/auth.ts`
- Create: `packages/ws/package.json`
- Create: `packages/ws/tsconfig.json`
- Create: `packages/ws/tests/rooms.test.ts`

**Step 1: Write the failing test for room management**

`packages/ws/tests/rooms.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { DraftRoomManager } from "../src/rooms";

describe("DraftRoomManager", () => {
  it("creates a room for a draft slug", () => {
    const manager = new DraftRoomManager();
    const room = manager.getOrCreateRoom("test-draft-slug");
    expect(room.slug).toBe("test-draft-slug");
    expect(room.sockets.size).toBe(0);
  });

  it("returns the same room for the same slug", () => {
    const manager = new DraftRoomManager();
    const room1 = manager.getOrCreateRoom("test-draft-slug");
    const room2 = manager.getOrCreateRoom("test-draft-slug");
    expect(room1).toBe(room2);
  });

  it("removes a room when empty", () => {
    const manager = new DraftRoomManager();
    manager.getOrCreateRoom("test-draft-slug");
    manager.removeRoom("test-draft-slug");
    expect(manager.getRoom("test-draft-slug")).toBeUndefined();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd packages/ws && npm test`
Expected: FAIL (module not found).

**Step 3: Implement DraftRoomManager**

`packages/ws/src/rooms.ts`:

```ts
export interface DraftRoom {
  slug: string;
  sockets: Set<string>;
  draftId: number | null;
}

export class DraftRoomManager {
  private rooms: Map<string, DraftRoom> = new Map();

  getOrCreateRoom(slug: string): DraftRoom {
    let room = this.rooms.get(slug);
    if (!room) {
      room = { slug, sockets: new Set(), draftId: null };
      this.rooms.set(slug, room);
    }
    return room;
  }

  getRoom(slug: string): DraftRoom | undefined {
    return this.rooms.get(slug);
  }

  removeRoom(slug: string): void {
    this.rooms.delete(slug);
  }

  joinRoom(slug: string, socketId: string): DraftRoom {
    const room = this.getOrCreateRoom(slug);
    room.sockets.add(socketId);
    return room;
  }

  leaveRoom(slug: string, socketId: string): void {
    const room = this.rooms.get(slug);
    if (room) {
      room.sockets.delete(socketId);
      if (room.sockets.size === 0) {
        this.removeRoom(slug);
      }
    }
  }
}
```

**Step 4: Run test to verify it passes**

Run: `cd packages/ws && npm test`
Expected: PASS.

**Step 5: Create Socket.IO server scaffolding**

`packages/ws/src/server.ts`:

```ts
import { createServer } from "http";
import { Server } from "socket.io";
import { DraftRoomManager } from "./rooms";

const manager = new DraftRoomManager();

const httpServer = createServer();
const io = new Server(httpServer, {
  cors: {
    origin: process.env.WEB_URL || "http://localhost:3000",
    methods: ["GET", "POST"],
  },
});

io.on("connection", (socket) => {
  console.log(`Connected: ${socket.id}`);

  socket.on("draft:join", (slug: string) => {
    socket.join(`draft:${slug}`);
    manager.joinRoom(slug, socket.id);
    console.log(`Socket ${socket.id} joined draft:${slug}`);
  });

  socket.on("pick:card", (data) => {
    // Will be wired to shared draft engine
    console.log(`Pick card:`, data);
  });

  socket.on("refresh:state", (slug: string) => {
    // Will emit full state back
    console.log(`Refresh state for draft:${slug}`);
  });

  socket.on("disconnect", () => {
    console.log(`Disconnected: ${socket.id}`);
    // Clean up from rooms
  });
});

const PORT = parseInt(process.env.WS_PORT || "3001", 10);
httpServer.listen(PORT, () => {
  console.log(`WebSocket server running on port ${PORT}`);
});
```

**Step 6: Commit**

```bash
git add -A
git commit -m "feat: add Socket.IO server with room management"
```

---

## Phase 5: Draft Room UI

### Task 8: Draft Room Page with Card Grid

**Files:**
- Create: `packages/web/src/app/draft/[slug]/page.tsx`
- Create: `packages/web/src/components/draft/card-grid.tsx`
- Create: `packages/web/src/components/draft/card-preview.tsx`
- Create: `packages/web/src/components/draft/seat-list.tsx`
- Create: `packages/web/src/components/draft/pool-panel.tsx`
- Create: `packages/web/src/components/draft/timer-bar.tsx`
- Create: `packages/web/src/lib/stores/draft-store.ts`
- Create: `packages/web/src/lib/hooks/use-draft-websocket.ts`

**Step 1: Create Zustand draft store**

`packages/web/src/lib/stores/draft-store.ts`:

```ts
import { create } from "zustand";

interface DraftCard {
  id: number;
  name: string;
  passcode: number;
  position: number;
}

interface DraftState {
  slug: string;
  packRound: number;
  pickStep: number;
  currentPack: DraftCard[];
  myPool: DraftCard[];
  seats: { seatIndex: number; playerName: string; picked: boolean }[];
  timerSeconds: number;
  isMyTurn: boolean;
  completed: boolean;
  pickSeconds: number;

  setFromServer: (state: Partial<DraftState>) => void;
  pickCard: (cardId: number) => void;
  tick: () => void;
}

export const useDraftStore = create<DraftState>((set) => ({
  slug: "",
  packRound: 0,
  pickStep: 0,
  currentPack: [],
  myPool: [],
  seats: [],
  timerSeconds: 0,
  isMyTurn: false,
  completed: false,
  pickSeconds: 45,

  setFromServer: (serverState) => set(serverState),
  pickCard: (cardId) => set((state) => {
    const card = state.currentPack.find((c) => c.id === cardId);
    if (!card) return state;
    return {
      currentPack: state.currentPack.filter((c) => c.id !== cardId),
      myPool: [...state.myPool, card],
    };
  }),
  tick: () => set((state) => ({
    timerSeconds: Math.max(0, state.timerSeconds - 1),
  })),
}));
```

**Step 2: Create WebSocket hook**

`packages/web/src/lib/hooks/use-draft-websocket.ts`:

```ts
"use client";

import { useEffect, useRef } from "react";
import { io, Socket } from "socket.io-client";
import { useDraftStore } from "@/lib/stores/draft-store";

export function useDraftWebSocket(slug: string) {
  const setFromServer = useDraftStore((s) => s.setFromServer);
  const socketRef = useRef<Socket | null>(null);

  useEffect(() => {
    const socket = io(process.env.NEXT_PUBLIC_WS_URL || "http://localhost:3001");
    socketRef.current = socket;

    socket.emit("draft:join", slug);

    socket.on("draft:state", (state) => {
      setFromServer(state);
    });

    socket.on("draft:pick", (data) => {
      setFromServer(data);
    });

    socket.on("draft:rotate", (data) => {
      setFromServer(data);
    });

    socket.on("draft:timer", (seconds) => {
      setFromServer({ timerSeconds: seconds });
    });

    socket.on("draft:complete", (data) => {
      setFromServer({ completed: true, ...data });
    });

    return () => {
      socket.disconnect();
    };
  }, [slug, setFromServer]);

  return socketRef;
}
```

**Step 3: Create draft room page**

`packages/web/src/app/draft/[slug]/page.tsx` — Three-panel responsive layout with seat list, card grid, and pool panel. Uses design system tokens. Mobile collapses to single column with bottom sheet.

**Step 4: Create card grid component**

`packages/web/src/components/draft/card-grid.tsx` — Responsive grid (2-col mobile, 3-col tablet, 4-col desktop). Each card is a tappable/hoverable element. Desktop hover shows card preview with full effect text. Mobile tap opens bottom sheet with card details and "Pick this card" button.

**Step 5: Create card preview component**

`packages/web/src/components/draft/card-preview.tsx` — Large card detail panel showing:
- Full card art image
- Card name (Russo One)
- Attribute, level/rank
- Full effect/lore text (scrollable if long, Chakra Petch 14px)
- ATK/DEF
- "Pick this card" button (accent-cta) and "Back to pack" ghost button

**Step 6: Create timer bar, seat list, pool panel**

- Timer: sticky on mobile, left-panel on desktop, Russo One, switches to accent-cta under 10s
- Seat list: current player highlighted with accent-primary border
- Pool panel: card count, type breakdown, Export YDK + View Full Pool buttons

**Step 7: Verify draft room renders**

Run: `cd packages/web && npm run dev`
Navigate to `/draft/test-slug` (will show placeholder since no WS connection yet).
Expected: Page renders with layout, design tokens applied, responsive breakpoints work.

**Step 8: Commit**

```bash
git add -A
git commit -m "feat: add draft room page with card grid, preview, timer, and pool panel"
```

### Task 9: YDK Export Utility

**Files:**
- Create: `packages/web/src/lib/ydk.ts`
- Create: `packages/web/tests/ydk.test.ts`

**Step 1: Write the failing test**

`packages/web/tests/ydk.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { generateYdk, YdkCard } from "../src/lib/ydk";

describe("generateYdk", () => {
  it("places main deck cards in the #main section", () => {
    const cards: YdkCard[] = [
      { passcode: 46986414, type: "monster" },
      { passcode: 53183600, type: "spell" },
    ];
    const result = generateYdk(cards);
    expect(result).toContain("#main\n46986414\n531800");
    expect(result).not.toContain("#extra");
  });

  it("places extra deck monsters in the #extra section", () => {
    const cards: YdkCard[] = [
      { passcode: 21123811, type: "xyz" },
      { passcode: 46986414, type: "monster" },
    ];
    const result = generateYdk(cards);
    expect(result).toContain("#extra\n21123811");
    expect(result).toContain("#main\n46986414");
  });

  it("generates empty #side section", () => {
    const cards: YdkCard[] = [
      { passcode: 46986414, type: "monster" },
    ];
    const result = generateYdk(cards);
    expect(result).toContain("#side\n");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd packages/web && npm test`
Expected: FAIL.

**Step 3: Implement generateYdk**

`packages/web/src/lib/ydk.ts`:

```ts
export interface YdkCard {
  passcode: number;
  type: "monster" | "spell" | "trap" | "fusion" | "synchro" | "xyz" | "link" | "ritual";
}

function isExtraDeck(type: YdkCard["type"]): boolean {
  return ["fusion", "synchro", "xyz", "link"].includes(type);
}

export function generateYdk(cards: YdkCard[]): string {
  const main = cards
    .filter((c) => !isExtraDeck(c.type))
    .map((c) => c.passcode.toString());
  const extra = cards
    .filter((c) => isExtraDeck(c.type))
    .map((c) => c.passcode.toString());

  return [`#main`, ...main, `#extra`, ...extra, `#side`, ""].join("\n");
}

export function downloadYdk(cards: YdkCard[], filename: string): void {
  const content = generateYdk(cards);
  const blob = new Blob([content], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename.endsWith(".ydk") ? filename : `${filename}.ydk`;
  a.click();
  URL.revokeObjectURL(url);
}
```

**Step 4: Run test to verify it passes**

Run: `cd packages/web && npm test`
Expected: PASS.

**Step 5: Commit**

```bash
git add -A
git commit -m "feat: add YDK export utility"
```

---

## Phase 6: Bot Deep Links

### Task 10: Update Bot Commands with Web Links

**Files:**
- Modify: `packages/bot/src/commands/handlers.ts`
- Modify: `packages/bot/src/interactions/buttons.ts`
- Modify: `packages/bot/src/index.ts`

**Step 1: Add WEB_URL env var**

In `packages/bot/src/index.ts`, add:

```ts
const WEB_URL = process.env.WEB_URL || "http://localhost:3000";
```

**Step 2: Update `/draft start` handler**

The handler should:
1. Create the draft with a `web_slug` (random URL-safe ID)
2. Post a message with the deep link: `Draft starting! Pick cards here: ${WEB_URL}/draft/${draft.web_slug}`
3. No longer generate Discord pick UI (remove numbered buttons, ephemeral picker)

**Step 3: Update `/duel`, `/stats`, `/rankings`, `/event` responses**

Add a line to each response: `View on web: ${WEB_URL}/dashboard` or `${WEB_URL}/tournament/${tournament.web_slug}`

**Step 4: Remove Discord pick UI**

Remove `draft_pick`, `draft_pick_number`, `draft_pick_refresh` button handlers.
Remove `draft_pool`, `draft_pool_page` button handlers.
Remove `buildDraftPickMessage`, `buildPostPickMessage` and related card image generation for Discord.

Keep `/draft cancel` (updates web via WS).

**Step 5: Verify bot still works with reduced pick UI**

Run: `cd packages/bot && npm test && npm run typecheck && npm run build`
Expected: Tests pass for remaining functionality, typecheck clean, build succeeds.

**Step 6: Commit**

```bash
git add -A
git commit -m "feat: add web deep links to bot commands, remove Discord pick UI"
```

---

## Phase 7: Tournament Bracket Pages

### Task 11: Tournament List and Bracket Pages

**Files:**
- Create: `packages/web/src/app/tournaments/page.tsx`
- Create: `packages/web/src/app/tournament/[id]/page.tsx`
- Create: `packages/web/src/app/tournament/[id]/report/page.tsx`
- Create: `packages/web/src/app/tournament/[id]/standings/page.tsx`
- Create: `packages/web/src/components/tournament/bracket-view.tsx`
- Create: `packages/web/src/components/tournament/match-card.tsx`
- Create: `packages/web/src/components/tournament/standings-table.tsx`
- Create: `packages/web/src/components/tournament/report-form.tsx`

**Step 1: Create tournament list page**

Fetches tournaments from shared DB via API route. Shows active, pending, and completed tournaments. Each tournament card links to detail page.

**Step 2: Create tournament detail page with bracket view**

Single elimination bracket: SVG-based bracket tree with match cards showing player names and W/L. Round robin: standings table.

**Step 3: Create match reporting page**

Select opponent, report win/loss, shows pending approvals. Integrates with shared tournament service.

**Step 4: Create standings page**

W/L records, match points, tiebreakers for round robin; bracket advancement for single elimination.

**Step 5: Verify pages render**

Run: `cd packages/web && npm run dev`
Expected: All tournament pages render with placeholder data.

**Step 6: Commit**

```bash
git add -A
git commit -m "feat: add tournament list, bracket, reporting, and standings pages"
```

---

## Phase 8: Player Dashboard

### Task 12: Dashboard Page

**Files:**
- Create: `packages/web/src/app/dashboard/page.tsx`
- Create: `packages/web/src/components/dashboard/active-drafts.tsx`
- Create: `packages/web/src/components/dashboard/active-tournaments.tsx`
- Create: `packages/web/src/components/dashboard/stats-card.tsx`
- Create: `packages/web/src/components/dashboard/match-history.tsx`

**Step 1: Create dashboard page**

Shows: active drafts (with join links), active tournaments, lifetime stats (W/L/win rate), recent matches.

**Step 2: Verify dashboard renders**

**Step 3: Commit**

```bash
git add -A
git commit -m "feat: add player dashboard page"
```

---

## Phase 9: Card Image Serving

### Task 13: Card Image API Route with Caching

**Files:**
- Create: `packages/web/src/app/api/cards/[passcode]/route.ts`
- Create: `packages/shared/src/services/card-images.ts` (moved from bot)

**Step 1: Create API route for card images**

```ts
// packages/web/src/app/api/cards/[passcode]/route.ts
import { NextResponse } from "next/server";
import { getCardImage } from "@yugidraft/shared/services/card-images";
import fs from "fs/promises";
import path from "path";

const CACHE_DIR = path.join(process.cwd(), "card-images");

export async function GET(
  request: Request,
  { params }: { params: Promise<{ passcode: string }> }
) {
  const { passcode } = await params;
  const cachePath = path.join(CACHE_DIR, `${passcode}.jpg`);

  try {
    const cached = await fs.readFile(cachePath);
    return new NextResponse(cached, {
      headers: {
        "Content-Type": "image/jpeg",
        "Cache-Control": "public, max-age=86400",
      },
    });
  } catch {
    // Fetch from YGOPRODeck API and cache
    const image = await getCardImage(passcode);
    if (!image) {
      return NextResponse.json({ error: "Card not found" }, { status: 404 });
    }
    await fs.mkdir(CACHE_DIR, { recursive: true });
    await fs.writeFile(cachePath, image);
    return new NextResponse(image, {
      headers: {
        "Content-Type": "image/jpeg",
        "Cache-Control": "public, max-age=86400",
      },
    });
  }
}
```

**Step 2: Verify card images load**

Run: `cd packages/web && npm run dev`
Navigate to `/api/cards/46986414` (Dark Magician passcode).
Expected: Image served and cached.

**Step 3: Commit**

```bash
git add -A
git commit -m "feat: add card image API route with disk caching"
```

---

## Phase 10: Deployment

### Task 14: Docker Compose and GCE Deployment

**Files:**
- Create: `Dockerfile.web`
- Create: `Dockerfile.ws`
- Modify: `docker-compose.yml`
- Modify: `.github/workflows/deploy.yml` (add web + ws builds)

**Step 1: Create Dockerfile.web**

```dockerfile
FROM node:22-bookworm-slim AS builder
WORKDIR /app
COPY package*.json ./
COPY turbo.json ./
COPY packages/web/package*.json ./packages/web/
COPY packages/shared/package*.json ./packages/shared/
RUN npm ci
COPY . .
RUN npm run build --filter=web

FROM node:22-bookworm-slim
WORKDIR /app
COPY --from=builder /app/packages/web/.next/standalone ./packages/web/
COPY --from=builder /app/packages/web/.next/static ./packages/web/.next/static
COPY --from=builder /app/packages/web/public ./packages/web/public
EXPOSE 3000
CMD ["node", "packages/web/server.js"]
```

**Step 2: Create Dockerfile.ws**

```dockerfile
FROM node:22-bookworm-slim AS builder
WORKDIR /app
COPY package*.json ./
COPY turbo.json ./
COPY packages/ws/package*.json ./packages/ws/
COPY packages/shared/package*.json ./packages/shared/
RUN npm ci
COPY . .
RUN npm run build --filter=ws

FROM node:22-bookworm-slim
WORKDIR /app
COPY --from=builder /app/packages/ws/dist ./packages/ws/dist
COPY --from=builder /app/packages/ws/node_modules ./packages/ws/node_modules
COPY --from=builder /app/packages/shared ./packages/shared
EXPOSE 3001
CMD ["node", "packages/ws/dist/server.js"]
```

**Step 3: Update docker-compose.yml**

Add `web` and `ws` services alongside existing `bot` service. Add Caddy reverse proxy service for HTTPS.

**Step 4: Update GitHub Actions workflow**

Add build steps for `web` and `ws` Docker images alongside existing `bot` build.

**Step 5: Commit**

```bash
git add -A
git commit -m "feat: add Docker and deployment config for web and ws services"
```

---

## Summary of Phases

| Phase | Tasks | Description |
|-------|-------|-------------|
| 1 | 1–3 | Monorepo scaffold, shared package, draft engine migration |
| 2 | 4–5 | Next.js 16 app, design system components |
| 3 | 6 | Discord OAuth auth |
| 4 | 7 | Socket.IO server |
| 5 | 8–9 | Draft room UI, YDK export |
| 6 | 10 | Bot deep links, remove Discord pick UI |
| 7 | 11 | Tournament bracket pages |
| 8 | 12 | Player dashboard |
| 9 | 13 | Card image serving |
| 10 | 14 | Docker Compose deployment |