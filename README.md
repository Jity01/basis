# Context Manager

Personal, local-first screen recording tool that captures your screen, tags each segment using a local vision LLM (GLM-4.6V-Flash), and stores structured summaries + frames in a filesystem that AI agents can easily search.

## Project Structure

```
context-manager/
├── apps/
│   └── desktop/          # Electron app
├── packages/
│   ├── config/           # Shared config (CONTEXT_ROOT, etc.)
│   └── core/             # Recording, tagging, storage logic
```

## Milestone 1: Monorepo Scaffold ✅

- pnpm workspace with `apps/desktop`, `packages/core`, `packages/config`
- Turborepo for `build` and `dev`
- Electron app that opens a window with "Context Manager" and placeholder UI
- `@context-manager/config` exports: `CONTEXT_ROOT`, `CHUNK_DURATION_MS`, `FRAMES_PER_CHUNK`, `FRAMES_TO_KEEP`
- `@context-manager/core` has stub modules: pipeline, recorder, frames, tagger, storage
- Desktop app successfully imports from both packages

## Milestone 2: Screen Recording ✅

- **Start/Stop** toggle records the screen to `~/.context/.tmp/` as `.webm` files
- **5-min rotation**: New file every 5 minutes (YYYY-MM-DD_HH-MM.webm)
- **Recording timer** shows duration while recording
- `recorder.ts`: `getCurrentFile()`, `getUnprocessedFiles()`, path helpers
- IPC channels: `start-recording`, `stop-recording`, `rotate-recording`, `recording-chunk`

## Requirements

- **Node.js** 18+
- **pnpm** 9.x (`npm install -g pnpm`)

## Quick Start

```bash
# Install dependencies
pnpm install

# Run the Electron app (dev mode)
pnpm dev
```

This opens an Electron window with the Context Manager placeholder UI. Imports from `@context-manager/core` and `@context-manager/config` work without errors (check the terminal for logs).

## How to Run Tests

**Milestone 1:** Run `pnpm dev` — Electron window opens with "Context Manager" placeholder.

**Milestone 2:**
1. Run `pnpm dev`
2. Click **Start Recording** — timer starts, screen is captured
3. Wait 6+ minutes (or just a few seconds for a quick test)
4. Click **Stop Recording**
5. Verify `~/.context/.tmp/` contains `.webm` files (one per 5-min chunk + partial)
6. Files should play in a video player

## Build (Production)

```bash
pnpm build
```

Then run the desktop app:

```bash
cd apps/desktop && electron .
```

## Upcoming Milestones

- **Milestone 3:** Frame extraction via ffmpeg
- **Milestone 4:** Tagging with GLM via Ollama
- **Milestone 5:** Storage to `~/.context/YYYY/MM/DD/...`
- **Milestone 6:** Pipeline orchestration
- **Milestone 7:** Idle detection + "Process Now"
- **Milestone 8:** Polish + agent readability
