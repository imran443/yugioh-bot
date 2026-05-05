# ── deps ────────────────────────────────────────────────────────────────────
# Install all npm dependencies once. Copy only manifests so this layer is
# cached as long as package-lock.json doesn't change.
FROM node:22-bookworm-slim AS deps
WORKDIR /app
RUN apt-get update && \
    apt-get install -y --no-install-recommends python3 make g++ libvips-dev && \
    rm -rf /var/lib/apt/lists/*
# Root workspace manifest + all workspace manifests (needed by npm workspaces ci)
COPY package*.json ./
COPY packages/bot/package*.json packages/bot/
COPY packages/ws/package*.json packages/ws/
COPY packages/web/package*.json packages/web/
COPY packages/shared/package*.json packages/shared/
RUN npm ci

# ── build ────────────────────────────────────────────────────────────────────
# Build all packages via turbo (respects dependency order: shared → bot/ws/web).
# Prune devDependencies afterward so production stages get a lean node_modules.
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npx turbo run build --concurrency=1
RUN npm prune --omit=dev

# ── bot ──────────────────────────────────────────────────────────────────────
# Production stage for the Discord bot.
FROM node:22-bookworm-slim AS bot
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package*.json ./
COPY --from=build /app/node_modules ./node_modules
# Shared package (symlink target for @yugidraft/shared)
COPY --from=build /app/packages/shared/package*.json packages/shared/
COPY --from=build /app/packages/shared/dist packages/shared/dist
# Bot compiled output
COPY --from=build /app/packages/bot/package*.json packages/bot/
COPY --from=build /app/packages/bot/dist packages/bot/dist
RUN mkdir -p /app/data
VOLUME ["/app/data"]
CMD ["sh", "-c", "node packages/bot/dist/deploy-commands.js && node packages/bot/dist/index.js"]

# ── ws ───────────────────────────────────────────────────────────────────────
# Production stage for the Socket.IO WebSocket server.
FROM node:22-bookworm-slim AS ws
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package*.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/ws/package*.json packages/ws/
COPY --from=build /app/packages/ws/dist packages/ws/dist
RUN mkdir -p /app/data
VOLUME ["/app/data"]
CMD ["node", "packages/ws/dist/server.js"]

# ── web ──────────────────────────────────────────────────────────────────────
# Production stage for the Next.js web dashboard.
# Runs `next start` from packages/web so it finds the local .next directory.
FROM node:22-bookworm-slim AS web
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package*.json ./
COPY --from=build /app/node_modules ./node_modules
# Shared package (symlink target for @yugidraft/shared — used by web API routes)
COPY --from=build /app/packages/shared/package*.json packages/shared/
COPY --from=build /app/packages/shared/dist packages/shared/dist
# Next.js built output and public assets
COPY --from=build /app/packages/web/package*.json packages/web/
COPY --from=build /app/packages/web/.next packages/web/.next
RUN mkdir -p /app/packages/web/public
RUN mkdir -p /app/data
VOLUME ["/app/data"]
EXPOSE 3000
# Run next start from packages/web so it locates the .next directory
WORKDIR /app/packages/web
CMD ["/app/node_modules/.bin/next", "start"]

# ── web-dev ──────────────────────────────────────────────────────────────────
# Development stage: runs `next dev` with HMR.
# Source directories are bind-mounted by docker-compose.dev.yml at runtime.
FROM node:22-bookworm-slim AS web-dev
WORKDIR /app
ENV NODE_ENV=development
# Install build tools for any native addons rebuilt in dev
RUN apt-get update && \
    apt-get install -y --no-install-recommends python3 make g++ libvips-dev && \
    rm -rf /var/lib/apt/lists/*
COPY --from=deps /app/node_modules ./node_modules
COPY package*.json ./
COPY packages/bot/package*.json packages/bot/
COPY packages/ws/package*.json packages/ws/
COPY packages/web/package*.json packages/web/
COPY packages/shared/package*.json packages/shared/
# Copy full source — bind mounts in docker-compose.dev.yml overlay these at runtime
COPY . .
EXPOSE 3000
WORKDIR /app/packages/web
CMD ["/app/node_modules/.bin/next", "dev"]
