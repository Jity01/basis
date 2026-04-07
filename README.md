# Context Manager

Personal, local-first screen recording tool that captures your screen, tags each segment with either **Fireworks** or a local **Ollama** model, and stores structured summaries + frames in `~/.context/`. Remote AI agents access the data by mounting this directory over the network via **Tailscale + SSHFS**.

## How It Works

1. **Record** — the desktop app captures your screen, rotating into 5-minute chunks
2. **Tag** — each chunk is sent to a vision model (Fireworks or Ollama) that writes a summary
3. **Store** — tagged summaries, metadata, and representative frames are saved to `~/.context/YYYY/MM/DD/HH-MM/`
4. **Access** — a remote machine (e.g. EC2) mounts `~/.context/` read-only via SSHFS over Tailscale and reads the files directly

## Quick Start

```bash
# Install dependencies (requires pnpm 9.x, Node 18+)
pnpm install

# Run the Electron app (dev mode)
pnpm dev
```

### Configure AI tagging

Open the **Settings** tab in the app and choose a provider:

- **Fireworks** — set `FIREWORKS_API_KEY` in `.env` or paste it in Settings
- **Local (Ollama)** — have Ollama running at `http://127.0.0.1:11434` with a vision-capable model

### Start recording

Click **Start Recording** in the Controls tab. The app captures your screen, rotates files every N minutes (configurable in Settings), and processes the backlog automatically when your machine is idle.

## Remote Access (Tailscale + SSHFS)

The **Network** tab in the app shows your Tailscale status, IP, and connected peers. When Tailscale is running, it also shows a ready-to-copy SSHFS mount command.

### Mac setup (context provider)

1. Install [Tailscale](https://tailscale.com/download) and sign in
2. Enable **Remote Login** in System Settings > General > Sharing (this enables SSH)
3. Run the Context Manager desktop app — the Network tab shows your Tailscale IP

### EC2 setup (context consumer)

Run the one-time setup script:

```bash
# Installs Tailscale, SSHFS, creates /mnt/context
./scripts/remote/setup-ec2.sh
```

Then mount your Mac's context directory:

```bash
# Replace with your Mac's Tailscale IP and username
./scripts/remote/mount-context.sh 100.x.y.z your-mac-user
```

The mount is **read-only** — the EC2 instance can read all your summaries, metadata, and frames but cannot modify them. To unmount:

```bash
./scripts/remote/unmount-context.sh
```

### Scheduling access

Toggle access by turning Tailscale on/off from the menu bar, or automate it with cron. See `scripts/remote/cron-schedule.example` for a template that enables access 9am-6pm on weekdays.

### What the remote machine sees

```
/mnt/context/
├── 2026/04/07/
│   ├── 14-30/
│   │   ├── summary.txt    # AI-generated summary of this 5-min chunk
│   │   ├── meta.json      # Timestamps, durations, frame counts
│   │   └── frames/        # 5 representative JPEGs
│   ├── 14-35/
│   └── ...
├── .hotbuffer/             # Live screenshots (last 60s, updated every 2s)
└── ai-settings.json        # Current AI provider config
```

## Requirements

- **Node.js** 18+
- **pnpm** 9.x (`npm install -g pnpm`)
- **ffmpeg** — install on your `PATH` for dev (`brew install ffmpeg` on macOS). Packaged builds bundle it automatically.
- **Tailscale** — for remote access (optional, only needed if sharing context with a remote machine)
- **Fireworks** or **Ollama** — for AI tagging

## Project Structure

```
context-manager/
├── apps/desktop/           # Electron app (main + renderer)
├── packages/config/        # Shared constants (CONTEXT_ROOT, etc.)
├── packages/core/          # Recording, tagging, storage logic
└── scripts/remote/         # EC2 setup + mount scripts
```

## Desktop Packaging

```bash
# Unpacked app (fast iteration)
pnpm --filter @context-manager/desktop dist:dir

# Platform installers (DMG/ZIP on macOS)
pnpm --filter @context-manager/desktop dist
```

## Build (Production)

```bash
pnpm build
cd apps/desktop && electron .
```
