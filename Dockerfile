FROM node:22-bookworm-slim AS deps
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ libvips-dev && rm -rf /var/lib/apt/lists/*
# Use npm 11 to match lockfile version (Node 22 ships npm 10 which has workspace resolution issues)
RUN npm install -g npm@11
COPY package*.json turbo.json ./
COPY packages/bot/package.json ./packages/bot/
COPY packages/web/package.json ./packages/web/
COPY packages/ws/package.json ./packages/ws/
COPY packages/shared/package.json ./packages/shared/
RUN npm ci

FROM deps AS build
COPY . .
RUN npm run build
RUN npm prune --omit=dev

FROM node:22-bookworm-slim AS bot
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./
COPY --from=build /app/packages/bot/dist ./packages/bot/dist
COPY --from=build /app/packages/bot/package.json ./packages/bot/
COPY --from=build /app/packages/bot/src/deploy-commands.ts ./packages/bot/src/deploy-commands.ts
COPY --from=build /app/packages/shared/dist ./packages/shared/dist
COPY --from=build /app/packages/shared/package.json ./packages/shared/
RUN mkdir -p /app/data
VOLUME ["/app/data"]

FROM node:22-bookworm-slim AS ws
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./
COPY --from=build /app/packages/ws/dist ./packages/ws/dist
COPY --from=build /app/packages/ws/package.json ./packages/ws/
COPY --from=build /app/packages/shared/dist ./packages/shared/dist
COPY --from=build /app/packages/shared/package.json ./packages/shared/
RUN mkdir -p /app/data
VOLUME ["/app/data"]

FROM node:22-bookworm-slim AS web
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/packages/web/.next/standalone ./
COPY --from=build /app/packages/web/.next/static ./packages/web/.next/static
COPY --from=deps /app/node_modules/better-sqlite3/build ./node_modules/better-sqlite3/build
COPY --from=deps /app/node_modules/@img ./node_modules/@img
RUN mkdir -p /app/packages/web/public /app/data
CMD ["node", "packages/web/server.js"]
VOLUME ["/app/data"]

# ── Development server (hot-reload via bind-mounted source) ──────────────────
# Used by docker-compose.override.yml. Source dirs are mounted at runtime;
# this stage bakes in a fallback copy so the image works standalone too.
FROM deps AS web-dev
WORKDIR /app
ENV NODE_ENV=development
EXPOSE 3000
COPY tsconfig.json ./
# Build @yugidraft/shared so its dist/ exists for Next.js to resolve
COPY packages/shared/tsconfig.json packages/shared/tsconfig.build.json ./packages/shared/
COPY packages/shared/src ./packages/shared/src
RUN npm run build --workspace=@yugidraft/shared
COPY packages/web/next.config.ts packages/web/postcss.config.mjs packages/web/tsconfig.json ./packages/web/
COPY packages/web/app ./packages/web/app
COPY packages/web/src ./packages/web/src
RUN mkdir -p /app/packages/web/.next /app/packages/web/public /app/data
VOLUME ["/app/data"]
CMD ["npm", "run", "dev:web"]
