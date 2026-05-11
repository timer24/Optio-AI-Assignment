# syntax=docker/dockerfile:1.7
#
# Multi-stage build for the Angular app.
#
# Stage 1: build the app with Node.
# Stage 2: ship the static bundle behind nginx with an SPA fallback.
#
# Build context is the REPO ROOT (set in docker-compose) so the build
# can resolve the @drift/shared workspace package via npm workspaces.

FROM node:24-alpine AS builder
WORKDIR /repo

# Install workspace dependencies. Manifests-only copy first so source
# edits don't bust the npm-ci layer.
COPY package.json package-lock.json ./
COPY apps/api/package.json ./apps/api/
COPY apps/web/package.json ./apps/web/
COPY packages/shared/package.json ./packages/shared/
RUN npm ci

# Shared package emits CJS to dist/ — bundler resolves @drift/shared to
# the compiled output, so it must exist before the Angular build runs.
COPY packages/shared ./packages/shared
RUN npm run build --workspace packages/shared

# Build the Angular app for production. `@angular/build` outputs to
# apps/web/dist/web/browser by default.
COPY apps/web ./apps/web
RUN npm run build --workspace apps/web


# ── Runtime: nginx serving the static bundle ───────────────────────────
FROM nginx:1.27-alpine AS runtime

# SPA fallback config — `try_files` ensures deep-linked routes
# (/segments/:id) resolve to index.html so the Angular router can
# handle them client-side.
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /repo/apps/web/dist/web/browser /usr/share/nginx/html

EXPOSE 80
# Default nginx CMD is fine — it foregrounds the worker and survives
# docker stop signals correctly.
