# ── Base: install dependencies with layer caching ─────────────────────────────
FROM node:22-bookworm-slim AS deps
WORKDIR /app

# System dependencies for native modules (better-sqlite3, sharp)
RUN apt-get update && \
    apt-get install -y --no-install-recommends python3 make g++ libvips-dev && \
    rm -rf /var/lib/apt/lists/*

# Enable corepack so the packageManager field in package.json is respected.
# This ensures npm matches the lockfile version (npm 11) automatically.
RUN corepack enable

# Copy root manifests first for layer caching.
# When workspace package.json files change, this layer is reused;
# only the npm ci layer rebuilds.
COPY package.json package-lock.json turbo.json ./

# Copy workspace manifests so npm ci can resolve the full monorepo.
# Adding a new package? Add it here.
COPY packages/bot/package.json    ./packages/bot/
COPY packages/web/package.json    ./packages/web/
COPY packages/ws/package.json     ./packages/ws/
COPY packages/shared/package.json ./packages/shared/

RUN npm ci

# ── Build: compile all packages ───────────────────────────────────────────────
FROM deps AS build
WORKDIR /app
COPY . .
RUN npm run build
RUN npm prune --omit=dev

# ── Production: Discord bot ────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS bot
WORKDIR /app
ENV NODE_ENV=production
RUN corepack enable
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./
COPY --from=build /app/packages/bot/dist    ./packages/bot/dist
COPY --from=build /app/packages/bot/src/deploy-commands.ts ./packages/bot/src/deploy-commands.ts
COPY --from=build /app/packages/bot/package.json ./packages/bot/
COPY --from=build /app/packages/shared/dist  ./packages/shared/dist
COPY --from=build /app/packages/shared/package.json ./packages/shared/
RUN mkdir -p /app/data
VOLUME ["/app/data"]

# ── Production: WebSocket server ───────────────────────────────────────────────
FROM node:22-bookworm-slim AS ws
WORKDIR /app
ENV NODE_ENV=production
RUN corepack enable
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./
COPY --from=build /app/packages/ws/dist      ./packages/ws/dist
COPY --from=build /app/packages/ws/package.json ./packages/ws/
COPY --from=build /app/packages/shared/dist   ./packages/shared/dist
COPY --from=build /app/packages/shared/package.json ./packages/shared/
RUN mkdir -p /app/data
VOLUME ["/app/data"]

# ── Production: Next.js web app ───────────────────────────────────────────────
FROM node:22-bookworm-slim AS web
WORKDIR /app
ENV NODE_ENV=production
RUN corepack enable
# Next.js standalone output includes a minimal node_modules.
# We only need to add native modules that can't be bundled.
COPY --from=build /app/packages/web/.next/standalone ./
COPY --from=build /app/packages/web/.next/static ./packages/web/.next/static
# better-sqlite3 and sharp have native binaries that Next.js can't bundle.
COPY --from=deps /app/node_modules/better-sqlite3/build ./node_modules/better-sqlite3/build
COPY --from=deps /app/node_modules/@img ./node_modules/@img
RUN mkdir -p /app/packages/web/public /app/data
CMD ["node", "packages/web/server.js"]
VOLUME ["/app/data"]

# ── Development: Next.js hot-reload server ───────────────────────────────────
# Used by docker-compose.override.yml. Source dirs are bind-mounted at runtime.
FROM deps AS web-dev
WORKDIR /app
ENV NODE_ENV=development
EXPOSE 3000
# Build shared package so its dist/ exists for Next.js resolution.
COPY packages/shared/tsconfig.json packages/shared/tsconfig.build.json ./packages/shared/
COPY packages/shared/src ./packages/shared/src
RUN npm run build --workspace=@yugidraft/shared
# Copy Next.js config and source so the dev server can start.
# Most source changes come through bind mounts at runtime.
COPY packages/web/next.config.ts packages/web/postcss.config.mjs packages/web/tsconfig.json ./packages/web/
COPY packages/web/app ./packages/web/app
COPY packages/web/src ./packages/web/src
RUN mkdir -p /app/packages/web/.next /app/packages/web/public /app/data
VOLUME ["/app/data"]
CMD ["npm", "run", "dev:web"]