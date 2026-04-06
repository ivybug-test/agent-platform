# Agent Platform

A multi-user agent chat platform where users can chat with AI agents in shared rooms.

## Features

- **Multi-user chat rooms** — Create rooms, invite friends, chat together with an AI agent
- **Friend system** — Add friends by email, auto-share rooms
- **Invite-only registration** — Admin generates invite codes
- **Streaming responses** — Real-time SSE streaming from LLM
- **Agent memory** — Room summaries + user memory extraction via BullMQ
- **Multi-layer prompts** — Agent identity, room rules, user context, memory, summaries
- **Agent behavior control** — Auto-reply toggle, @mention to trigger response
- **Room management** — Auto-naming, archive, delete
- **Mobile-friendly** — DaisyUI responsive drawer sidebar, swipe gesture

## Tech Stack

- **Frontend**: Next.js (App Router), React, Tailwind CSS, DaisyUI
- **Backend**: Fastify (agent-runtime), Next.js API routes
- **Database**: PostgreSQL (Drizzle ORM)
- **Queue**: BullMQ + Redis
- **Auth**: Auth.js (next-auth)
- **LLM**: OpenAI SDK (compatible with DeepSeek, etc.)
- **Process Manager**: pm2

## Project Structure

```
apps/web/                  — Next.js frontend + API routes
packages/db/               — Drizzle schema + migrations
packages/types/            — Shared TypeScript types
services/agent-runtime/    — Fastify LLM proxy (SSE streaming)
services/memory-worker/    — BullMQ worker (summaries + memory extraction)
infra/                     — Docker Compose, deploy scripts, Caddyfile
```

## Local Development

### Prerequisites

- Node.js 22+
- pnpm 9+
- Docker (for PostgreSQL + Redis)

### Setup

```bash
# Install dependencies
pnpm install

# Start PostgreSQL + Redis
cd infra && docker compose up -d && cd ..

# Copy and edit env
cp .env.example .env
# Edit .env with your LLM API key, database URL, etc.

# Push database schema
cd packages/db && pnpm db:push && cd ../..

# Seed database (optional)
cd packages/db && pnpm db:seed && cd ../..

# Start all services
pnpm dev
```

### Services

| Service | Port | Description |
|---------|------|-------------|
| web | 3000 | Next.js frontend + API |
| agent-runtime | 3001 | Fastify LLM streaming proxy |
| memory-worker | — | BullMQ background worker |

## Production Deployment

### Server requirements

- Ubuntu server with Docker installed
- Node.js 22+, pnpm, pm2

### First-time setup

```bash
git clone https://github.com/ivybug-test/agent-platform.git ~/agent-platform
cd ~/agent-platform/infra
cp .env.prod.example .env.prod
# Edit .env.prod with real values
chmod +x setup-server.sh
bash setup-server.sh
```

### Daily updates

```bash
cd ~/agent-platform
bash infra/update.sh
```

### Key deployment notes

- Only PostgreSQL + Redis run in Docker; Node.js services run directly via pm2
- `AUTH_URL` in `.env.prod` must match the actual access URL
- After build, static + server dirs must be copied to standalone (handled by scripts)
- Test production build locally with `bash infra/test-prod.sh` before deploying

## Environment Variables

See `.env.example` and `infra/.env.prod.example` for all required variables.

## License

Private
