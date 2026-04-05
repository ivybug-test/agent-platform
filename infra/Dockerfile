FROM node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@9.15.4 --activate
WORKDIR /app

# Install dependencies (shared across all services)
FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/web/package.json ./apps/web/
COPY packages/db/package.json ./packages/db/
COPY packages/types/package.json ./packages/types/
COPY services/agent-runtime/package.json ./services/agent-runtime/
COPY services/memory-worker/package.json ./services/memory-worker/
RUN pnpm install --frozen-lockfile

# Build everything once
FROM deps AS builder
COPY . .
RUN pnpm -r build

# --- Web ---
FROM node:22-alpine AS web
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/apps/web/.next/standalone ./
COPY --from=builder /app/apps/web/.next/static ./apps/web/.next/static
EXPOSE 3000
ENV PORT=3000 HOSTNAME="0.0.0.0"
CMD ["node", "apps/web/server.js"]

# --- Agent Runtime ---
FROM node:22-alpine AS agent-runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/services/agent-runtime/dist ./dist
COPY --from=builder /app/services/agent-runtime/node_modules ./node_modules
EXPOSE 3001
CMD ["node", "dist/index.js"]

# --- Memory Worker ---
FROM node:22-alpine AS memory-worker
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/services/memory-worker/dist ./dist
COPY --from=builder /app/services/memory-worker/node_modules ./node_modules
COPY --from=builder /app/packages/db/dist ./node_modules/@agent-platform/db/dist
COPY --from=builder /app/packages/db/package.json ./node_modules/@agent-platform/db/
COPY --from=builder /app/packages/types/dist ./node_modules/@agent-platform/types/dist
COPY --from=builder /app/packages/types/package.json ./node_modules/@agent-platform/types/
CMD ["node", "dist/index.js"]
