# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

GoonCave is a local-first, Docker-first booru-style media library. It indexes image/video files, runs reverse-image-search providers, and auto-tags media using a local AI model.

- **Backend:** Fastify + TypeScript, SQLite (better-sqlite3), BullMQ (Redis queue), worker process
- **Frontend:** React + Vite + Bootstrap SPA
- **Tagger:** Python FastAPI service running WD14 (ONNX) for AI auto-tagging
- **Desktop:** Electron wrapper
- **API spec:** `openapi.json`

## Commands

```bash
# Full stack (Docker)
docker compose up --build -d

# Local dev (web) — install first, then:
npm run dev                         # api + worker + web
npm run dev:desktop                 # api + worker + web + electron

# Individual services
npm run dev --prefix backend        # API server (port 4100, hot-reload)
npm run worker --prefix backend     # Background worker only
npm run dev --prefix frontend       # Vite dev server (port 5174)

# Build
npm run build --prefix backend      # Compile TypeScript → backend/dist/
npm run build --prefix frontend     # Bundle React → frontend/dist/

# Lint
npm run lint --prefix backend       # ESLint on backend/src/
```

After editing anything used by Docker, rebuild: `docker compose up --build -d`.

## Architecture

### Components

```
Frontend (React SPA)
    │ HTTP + WebSocket
Backend API (Fastify, port 4100)  ←→  SQLite DB
    │                              ←→  Redis (BullMQ job queue, port 6379)
Worker process (same codebase)     ←→  Tagger service (Python, port 8000)
```

**API server** (`backend/src/index.ts`) registers routes from `backend/src/routes/` and serves the built frontend as static files.

**Worker** (`backend/src/worker.ts`) handles scheduled tasks: file scanning via chokidar (LOCAL folders), polling WebDAV folders, provider refresh, WD14 backfill, and favorites sync.

**Tagger** (`tagger/app.py`) exposes `POST /tag` and downloads the WD14 model from Hugging Face on first run.

### Key backend files

- `backend/src/lib/dataStore.ts` — entire SQLite data layer (all DB queries live here)
- `backend/src/lib/scanner.ts` — file hashing, thumbnail generation, FFmpeg integration
- `backend/src/lib/sauces.ts` — provider logic (SauceNAO, Fluffle, E621, Danbooru, Gelbooru)
- `backend/src/lib/duplicates.ts` — perceptual hash duplicate detection
- `backend/src/services/tagging.ts` — tag extraction from provider results + WD14 responses
- `backend/src/queue/scanQueue.ts` — BullMQ job definitions

### Folder types

- **LOCAL:** watched with chokidar, scanned on file system events
- **WEBDAV:** polled periodically, files downloaded for local processing

### Data flow

1. **File scan** — index files (path, size, mtime, SHA256)
2. **Provider scan** — reverse-image search via SauceNAO/Fluffle; fetch source metadata
3. **Tag extraction** — parse provider results + run WD14 on images
4. **Store** — persist to SQLite

## Conventions

1. Call vibe_check after planning and before major actions.
2. Provide the full user request and your current plan.
3. Optionally, record resolved issues with vibe_learn.

- When explaining complex topics, start with an ELI5-style summary before optional deeper details.
- If a fix attempt fails, restore the previous state — leave no dead code, temp flags, stubs, or TODO-only blocks.
