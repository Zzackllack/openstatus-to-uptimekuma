# syntax=docker/dockerfile:1

# ---- build ----------------------------------------------------------------
FROM node:22-bookworm-slim AS build
WORKDIR /app

# Copied separately so dependency installation is cached independently of source.
# pnpm-workspace.yaml carries `allowBuilds`: pnpm >= 12 exits 1 when a dependency
# has an unapproved build script, and tsx/vitest need esbuild's.
COPY package.json pnpm-lock.yaml* pnpm-workspace.yaml ./
RUN corepack enable \
 && corepack prepare pnpm@12.6.0 --activate \
 && pnpm install --frozen-lockfile

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN pnpm build

# ---- production dependencies only -----------------------------------------
FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json pnpm-lock.yaml* ./
RUN corepack enable \
 && corepack prepare pnpm@12.6.0 --activate \
 && pnpm install --prod --frozen-lockfile

# ---- runtime --------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    DATABASE_PATH=/app/data/bridge.sqlite

COPY --from=deps  /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

# Non-root, and the only writable path is the volume holding the id map.
RUN mkdir -p /app/data && chown -R node:node /app
USER node

VOLUME ["/app/data"]
EXPOSE 3000

# Liveness only. /readyz reports 503 while OpenStatus is unreachable, which must
# never cause the container to be killed: the bridge still holds last-known state
# for every monitor and killing it would turn an upstream blip into a blind spot.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Give the Socket.IO server a chance to drain before SIGKILL arrives.
STOPSIGNAL SIGTERM

CMD ["node", "dist/index.js"]