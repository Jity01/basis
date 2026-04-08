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

## Milestone 1: Monorepo Scaffold ✅

- pnpm workspace with `apps/desktop`, `packages/core`, `packages/config`
- Turborepo for `build` and `dev`
- Electron app that opens a window with "Context Manager" and placeholder UI
- `@context-manager/config` exports: `CONTEXT_ROOT`, `CHUNK_DURATION_MS`, `FRAMES_PER_CHUNK`, `FRAMES_TO_KEEP`
- `@context-manager/core` has stub modules: pipeline, recorder, frames, tagger, storage
- Desktop app successfully imports from both packages

## Milestone 2: Screen Recording ✅

- **Start/Stop** toggle records the screen to `~/context/.tmp/` as `.webm` files
- **5-min rotation**: New file every 5 minutes (YYYY-MM-DD_HH-MM.webm)
- **Recording timer** shows duration while recording
- `recorder.ts`: `getCurrentFile()`, `getUnprocessedFiles()`, path helpers
- IPC channels: `start-recording`, `stop-recording`, `rotate-recording`, `recording-chunk`

## Requirements

- **Node.js** 18+
- **pnpm** 9.x (`npm install -g pnpm`)
- **ffmpeg** — used for frame extraction. **Development:** install `ffmpeg` and `ffprobe` on your `PATH` (e.g. macOS: `brew install ffmpeg`). **Packaged desktop app:** `pnpm --filter @context-manager/desktop dist` / `dist:dir` runs scripts that stage `ffmpeg`, `ffprobe` (via [ffmpeg-static](https://www.npmjs.com/package/ffmpeg-static) / [ffprobe-static](https://www.npmjs.com/package/ffprobe-static)), and `cloudflared` (pinned release from [Cloudflare’s GitHub](https://github.com/cloudflare/cloudflared/releases)) into the app bundle; the Electron main process sets `CONTEXT_MANAGER_*` env vars so processing and remote access do not rely on system installs. Redistributing those binaries may be subject to their respective licenses (ffmpeg build license, cloudflared license, etc.).
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

This opens an Electron window with the Context Manager placeholder UI. Imports from `@context-manager/core` and `@context-manager/config` work without errors (check the terminal for logs).

## Desktop packaging

From the repo root, after `pnpm install`:

```bash
# Unpacked app (fast to iterate; output under apps/desktop/release/)
pnpm --filter @context-manager/desktop dist:dir

# Platform installers (DMG / ZIP on macOS, per apps/desktop/electron-builder.yml)
pnpm --filter @context-manager/desktop dist
```

`pnpm install` runs a small **postinstall** that installs a pinned Ajv 6 under `apps/desktop/vendor/ajv-for-electron-builder` (via `npm ci`) and symlinks it for `electron-builder`. **npm** must be on your PATH for that step.

**Bundled binaries (packaged app only):** `build:desktop` runs `build:binaries`, which stages `ffmpeg`, `ffprobe`, and `cloudflared` under `apps/desktop/resources/` (gitignored) before `electron-builder` packs them into `extraResources`. Dev mode (`pnpm dev`) does not set these; use a system `ffmpeg` / `cloudflared` on `PATH` as usual.

**MCP server:** In production (including packaged apps), the Electron main process starts the bundled MCP HTTP server. In `pnpm dev`, the MCP server is still started by the dev script’s `concurrently` process.

## Claude Remote Connector

You can expose the local MCP server to Claude through the desktop app's Cloudflare tunnel.

1. Run `pnpm dev`.
2. In the desktop app, open `Settings` and enable `Remote Access`.
3. Copy the `Remote MCP Endpoint` value. Use the full `https://.../mcp` endpoint, not just the tunnel root URL.
4. In Claude, add a custom remote MCP connector using that endpoint and complete the OAuth flow.

Notes:

- The server now exposes standard MCP OAuth endpoints through the SDK: `/.well-known/oauth-authorization-server`, `/.well-known/oauth-protected-resource/mcp`, `/authorize`, `/token`, and `/register`.
- Dynamic Client Registration (DCR) is the default path for remote clients. If you manually configure a fixed client in Claude, you can still use `MCP_OAUTH_CLIENT_ID` and `MCP_OAUTH_CLIENT_SECRET` as an optional fallback.
- The desktop app still shows a local-only debug token for localhost `curl` checks, but Claude should connect through OAuth.
- Remote tool calls still use the app's approval queue. Keep the app open to approve requests, or enable auto-approve while testing.
- Optional redirect allowlist: set `MCP_OAUTH_ALLOWED_REDIRECT_URIS` to a comma-separated list of exact callback URLs. By default, the server accepts Claude callback URLs and loopback redirect URLs for local testing tools.

## Claude Skill (Optional but recommended)

The MCP connector gives Claude access to Basis tools. For better integration, you can also install the Basis skill, which teaches Claude:

- When to automatically fetch your context (e.g., "what was I working on?")
- The "ct" shortcut for quick context retrieval
- How to navigate days → chunks → details efficiently

### Install the skill

1. Download the `skills/basis-context` folder from this repo
2. Zip the folder (the folder itself should be the zip root, not its contents)
3. In Claude.ai: **Settings → Capabilities → Skills → Upload**
4. Toggle the skill on

The skill works alongside the MCP connector — you need both for full functionality.

### Remote MCP Validation

If a connector still fails, validate the server in this order:

1. `curl https://<your-tunnel-host>/health`
2. `curl https://<your-tunnel-host>/.well-known/oauth-authorization-server`
3. `curl https://<your-tunnel-host>/.well-known/oauth-protected-resource/mcp`
4. Confirm the desktop app or server logs show the auth route Claude hit (`/register`, `/authorize`, `/token`) and the MCP method it reached (`initialize`, `tools/list`, or `tools/call`)

The MCP server now logs those auth and MCP steps directly, which makes it much easier to tell whether a failure is tunnel reachability, OAuth discovery, token exchange, or the authenticated MCP session itself.

### MCP Browsing Tools

The remote MCP server now exposes deterministic filesystem-backed browsing tools instead of the old model-backed `search_context` flow:

- `list_days` — returns available days plus lightweight metadata such as chunk count and first/last chunk time
- `get_day_index` — returns a concatenated day index string (assembled from each chunk’s `summary.txt`) and chunk keys for one day
- `get_chunk_context` — returns one chunk's reconstructed summary, parsed `meta.json`, and frame images for a chunk key like `2026-04-01/16-35`

This lets Claude drive the retrieval loop directly: inspect recent days, open a day's index, then zoom in on specific chunks as needed.

## How to Run Tests

**Milestone 1:** Run `pnpm dev` — Electron window opens with "Context Manager" placeholder.

**Milestone 2:**
1. Run `pnpm dev`
2. Click **Start Recording** — timer starts, screen is captured
3. Wait 6+ minutes (or just a few seconds for a quick test)
4. Click **Stop Recording**
5. Verify `~/context/.tmp/` contains `.webm` files (one per 5-min chunk + partial)
6. Files should play in a video player

## Build (Production)

```bash
pnpm build
```

Then run the desktop app:

```bash
cd apps/desktop && electron .
```

## Milestone 3: Frame Extraction ✅

- **`packages/core/src/frames.ts`**
  - `extractFrames(videoPath, numFrames, maxDim?)` — uses ffmpeg to sample `numFrames` JPEGs at evenly spaced times (centered in equal duration slices), downscaled so the longest edge ≤ `maxDim` (default **1568**). Writes to **`~/context/.tmp/extracted-frames/`** (overwrites each run; see `EXTRACTED_FRAMES_DIR`) and returns absolute paths in time order.
  - `selectRepresentativeFrames(framePaths, keep)` — picks `keep` paths using consecutive **file-size** deltas as a simple change signal; always includes the first and last frame when `keep >= 2`.
- Requires **ffmpeg** / **ffprobe** (see Requirements): on `PATH` in dev, or `CONTEXT_MANAGER_FFMPEG_BIN` / `CONTEXT_MANAGER_FFPROBE_BIN` when set by the packaged Electron app.

**Manual test (Milestone 3):**

1. Use any screen-recording chunk from `~/context/.tmp/` (e.g. `.webm`) or another short video (`.mov` / `.mp4`).
2. From the repo root, build core: `pnpm --filter @context-manager/core build`
3. Run Node in the repo and call `extractFrames(path, 15, 1568)` from `@context-manager/core` (or a small script that imports `dist/frames.js`).
4. Confirm 15 JPEGs exist, order matches time order, and `ffprobe` reports `max(width,height) <= 1568` for each.
5. Call `selectRepresentativeFrames(paths, 5)` and confirm 5 paths, including the first and last of the 15.

## Milestone 4: Tagging With Fireworks Or Ollama ✅

- **`packages/core/src/tagger.ts`**
  - `tagChunk(framePaths, startTime, endTime, settings?)` — reads each frame file as base64, sends the analysis prompt plus **all** frames as separate image blocks to either Fireworks or a local Ollama model using a chat-completions style API.
  - Returns a **single paragraph** summary string.

**Manual test (Milestone 4):**

1. For Fireworks mode, set **`FIREWORKS_API_KEY`** in **`.env`**. For local mode, make sure Ollama is running and pick a vision-capable local tagging model in the desktop app settings.
2. Build core: `pnpm --filter @context-manager/core build`
3. Run `pnpm --filter @context-manager/core tag-test -- /path/to/recording.webm` or call `extractFrames` then `tagChunk` from code.
4. Verify: non-empty summary text that references real on-screen content.

**Deterministic MCP browse helper smoke test:**

1. Build core: `pnpm --filter @context-manager/core build`
2. Run `pnpm --filter @context-manager/core search-test`
3. Verify it prints `Deterministic browse helper smoke test passed.`

## Upcoming Milestones
- **Milestone 5:** Storage to `~/context/YYYY/MM/DD/...`
- **Milestone 6:** Pipeline orchestration
- **Milestone 7:** Idle detection + "Process Now"
- **Milestone 8:** Polish + agent readability
