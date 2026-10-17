# syntax=docker/dockerfile:1.7
FROM oven/bun:1.4.2 AS bun
FROM node:24.18.0-bookworm-slim AS build
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git && rm -rf /var/lib/apt/lists/*
WORKDIR /source
COPY . .
ENV WRANGLER_SEND_METRICS=false CI=true
RUN bun install --frozen-lockfile
RUN npm ci --prefix scripts/selfhost --ignore-scripts
RUN bun x --no-install tsc --project scripts/selfhost/tsconfig.json
RUN bun run --cwd frontend/app build:production
RUN node scripts/selfhost/build.mjs && node scripts/selfhost/notices.mjs

FROM node:24.18.0-bookworm-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates libatomic1 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production SELFHOST_DATA=/data
COPY scripts/selfhost/package.json scripts/selfhost/package-lock.json ./scripts/selfhost/
RUN npm ci --prefix scripts/selfhost --omit=dev && npm audit --prefix scripts/selfhost --omit=dev --audit-level=high && npm cache clean --force
COPY --from=build /source/dist/selfhost ./dist/selfhost
COPY scripts/selfhost/server.mjs scripts/selfhost/control.mjs scripts/selfhost/admin.mjs scripts/selfhost/jobs.mjs scripts/selfhost/configure.mjs ./scripts/selfhost/
COPY LICENSE* THIRD_PARTY_NOTICES.md ./
RUN mkdir /data && chown node:node /data
USER node
EXPOSE 8080
CMD ["node", "scripts/selfhost/server.mjs"]

FROM postgres:18.6-alpine AS database
COPY packages/database/migrations /migrations
COPY scripts/cloudflare-local/postgres/migrate.sh /local/migrate.sh
COPY scripts/selfhost/database.sh /local/selfhost.sh
ENTRYPOINT ["sh", "/local/selfhost.sh"]
