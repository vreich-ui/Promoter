# Multi-stage build for the promoter service.
#
# NODE_IMAGE is an ARG so the base image can be overridden in networks where
# Docker Hub is unreachable, e.g.:
#   docker build --build-arg NODE_IMAGE=mirror.gcr.io/library/node:22-slim .
ARG NODE_IMAGE=node:22-slim

# ---- builder: install everything, compile TypeScript, drop dev deps ----
FROM ${NODE_IMAGE} AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# ---- runner: minimal production image ----
FROM ${NODE_IMAGE} AS runner
ENV NODE_ENV=production
ENV PORT=8080
WORKDIR /app

# Baked at build time so /health can report the deployed revision.
ARG GIT_SHA=""
ENV GIT_SHA=${GIT_SHA}

COPY package.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist

EXPOSE 8080
USER node
CMD ["node", "dist/index.js"]
