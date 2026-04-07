# Context Manager

Personal, local-first screen recording tool that captures your screen, tags each segment with either **Fireworks** or a local **Ollama** model, and stores structured summaries + frames in a filesystem that AI agents can easily search.

## Project Structure

```
context-manager/
├── apps/
│   └── desktop/          # Electron app
├── packages/
│   ├── config/           # Shared config (CONTEXT_ROOT, etc.)
│   └── core/             # Recording, tagging, storage logic
```

## Requirements

- **Node.js** 18+
- **pnpm** 9.x (`npm install -g pnpm`)
- **ffmpeg** — used for frame extraction. **Development:** install `ffmpeg` and `ffprobe` on your `PATH` (e.g. macOS: `brew install ffmpeg`). **Packaged desktop app:** `pnpm --filter @context-manager/desktop dist` / `dist:dir` runs scripts that stage `ffmpeg`, `ffprobe` (via [ffmpeg-static](https://www.npmjs.com/package/ffmpeg-static) / [ffprobe-static](https://www.npmjs.com/package/ffprobe-static)) into the app bundle; the Electron main process sets `CONTEXT_MANAGER_*` env vars so processing does not rely on system installs. Redistributing those binaries may be subject to their respective licenses.
- **Fireworks** or **Ollama**
- Fireworks mode uses `FIREWORKS_API_KEY` and the existing optional `FIREWORKS_BASE_URL` / `FIREWORKS_MODEL` env vars.
- Local mode uses Ollama running on `http://127.0.0.1:11434` and the app stores a normalized OpenAI-compatible base URL such as `http://127.0.0.1:11434/v1`.
- In the desktop app, open `Settings` and choose either `Fireworks` or `Local (Ollama)`.

## Quick Start

```bash
# Install dependencies
pnpm install

# Run the Electron app (dev mode)
pnpm dev
```

This opens an Electron window with the Context Manager UI. Imports from `@context-manager/core` and `@context-manager/config` work without errors (check the terminal for logs).

## Desktop packaging

From the repo root, after `pnpm install`:

```bash
# Unpacked app (fast to iterate; output under apps/desktop/release/)
pnpm --filter @context-manager/desktop dist:dir

# Platform installers (DMG / ZIP on macOS, per apps/desktop/electron-builder.yml)
pnpm --filter @context-manager/desktop dist
```

`pnpm install` runs a small **postinstall** that installs a pinned Ajv 6 under `apps/desktop/vendor/ajv-for-electron-builder` (via `npm ci`) and symlinks it for `electron-builder`. **npm** must be on your PATH for that step.

**Bundled binaries (packaged app only):** `build:desktop` runs `build:binaries`, which stages `ffmpeg` and `ffprobe` under `apps/desktop/resources/` (gitignored) before `electron-builder` packs them into `extraResources`. Dev mode (`pnpm dev`) does not set these; use a system `ffmpeg` on `PATH` as usual.

## How to Test

1. Run `pnpm dev` — Electron window opens with the Context Manager UI.
2. Click **Start Recording** — timer starts, screen is captured.
3. Wait 6+ minutes (or just a few seconds for a quick test).
4. Click **Stop Recording**.
5. Verify `~/.context/.tmp/` contains `.webm` files (one per chunk + partial).
6. Files should play in a video player.

**Tagging test:**

1. For Fireworks mode, set **`FIREWORKS_API_KEY`** in **`.env`**. For local mode, make sure Ollama is running and pick a vision-capable local tagging model in the desktop app settings.
2. Build core: `pnpm --filter @context-manager/core build`
3. Run `pnpm --filter @context-manager/core tag-test -- /path/to/recording.webm`
4. Verify: non-empty summary text that references real on-screen content.

## Build (Production)

```bash
pnpm build
```

Then run the desktop app:

```bash
cd apps/desktop && electron .
```
