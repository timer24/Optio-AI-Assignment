# syntax=docker/dockerfile:1.7
#
# Multi-stage build for the NestJS API.
#
# Build context is the REPO ROOT so we can pull in:
#   - apps/api          (this app)
#   - packages/shared   (workspace dependency — must be built first)
#   - root package.json + lockfile (workspaces install lives at the root)
#
# We keep dev dependencies in the runtime image because seed scripts need
# `ts-node` and `@faker-js/faker`, and `prisma db seed` is part of the
# documented bring-up flow (one-shot, via docker compose exec).

FROM node:24-alpine AS builder
WORKDIR /repo

# Install OS deps that some npm packages compile against on Alpine.
# Keep this list minimal — every line is install time and image size.
RUN apk add --no-cache libc6-compat

# ── Stage 1a: install dependencies ─────────────────────────────────────
# Copy only manifests first so layer caching survives source edits.
COPY package.json package-lock.json ./
COPY apps/api/package.json ./apps/api/
COPY apps/web/package.json ./apps/web/
COPY packages/shared/package.json ./packages/shared/
RUN npm ci

# ── Stage 1b: build the workspace ──────────────────────────────────────
# Shared package emits CJS to dist/ — must exist before apps/api compiles
# because nest's tsc resolves @drift/shared to the compiled output.
COPY packages/shared ./packages/shared
RUN npm run build --workspace packages/shared

# Now copy the api sources and build. We split the COPY from the build so
# a source edit doesn't bust the dependency-install layer.
COPY apps/api ./apps/api

# Prisma CLI (v6 — aligned to @prisma/client@6 across the repo) is now
# installed by npm ci above. We just call the workspace-local binary.
#
# DATABASE_URL is a build-time placeholder; Prisma validates env at
# config-load time but `generate` never actually connects. The real URL
# comes from docker-compose at runtime.
WORKDIR /repo/apps/api
RUN DATABASE_URL="postgresql://build:build@localhost:5432/build?schema=public" \
    npx prisma generate --schema prisma/schema.prisma
WORKDIR /repo
RUN npm run build --workspace apps/api


# ── Stage 2: runtime image ─────────────────────────────────────────────
# Slim down by copying only the materials needed to run.
FROM node:24-alpine AS runtime
WORKDIR /repo

# `production` would normally drop dev deps via NODE_ENV — we keep them
# because the seed command depends on ts-node. The image cost is ~80MB
# more, which is acceptable for a take-home demo.
ENV NODE_ENV=production
ENV PORT=3000

# Pull in only the bits the running process needs.
COPY --from=builder /repo/package.json /repo/package-lock.json ./
COPY --from=builder /repo/node_modules ./node_modules
COPY --from=builder /repo/packages/shared/package.json ./packages/shared/
COPY --from=builder /repo/packages/shared/dist ./packages/shared/dist
COPY --from=builder /repo/apps/api/package.json ./apps/api/
COPY --from=builder /repo/apps/api/dist ./apps/api/dist
COPY --from=builder /repo/apps/api/prisma ./apps/api/prisma
# The prisma config file (TS source) is read by the Prisma CLI directly;
# Prisma 7 reads .ts configs natively without ts-node.
COPY --from=builder /repo/apps/api/prisma.config.ts ./apps/api/

EXPOSE 3000

# Run from the api workspace so relative paths in prisma.config.ts resolve.
WORKDIR /repo/apps/api

# `migrate deploy` applies pending migrations on every container start.
# Safe to re-run when no migrations are pending. The compiled entrypoint
# is dist/src/main.js — nest builds preserve src/ structure.
CMD ["sh", "-c", "npx prisma migrate deploy --schema prisma/schema.prisma && node dist/src/main.js"]
