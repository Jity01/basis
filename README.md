# JustReheat (www.justreheat.com)

**Screen context for your AI.** JustReheat records your screen, summarizes what you do, and organizes it into a local filesystem that any AI model or agent can search—so you never have to explain yourself twice.

Open source, private, and local storage by default.

## Using the desktop app

These steps are for anyone running the **desktop app** (not for building from source).

### 1. Screen recording (macOS)

The first time you capture your screen, macOS may ask for permission. Allow it in **System Settings → Privacy & Security → Screen Recording**, and enable the app in the list if it appears there.

### 2. Fireworks API key

Summaries and image understanding use [Fireworks](https://fireworks.ai/). You need an API key from your Fireworks account.

1. Open the app and go to **Settings** (tab in the app).
2. Under **Settings**, paste your key into **Fireworks API key**.
3. Click **Save Settings** at the bottom so the key is stored.

Without a valid key, processing that depends on Fireworks will not run.

### 3. Excluded windows (privacy)

To stop specific apps from ever being captured:

1. In **Settings**, open **Privacy — Excluded Windows**.
2. Click **Add App** and enter the **bundle ID**.
3. Use the **Enabled** checkbox on each row so exclusions you want are turned on.
4. If the app says a restart is required, use **Restart Now** (or quit and reopen the app) so the OS-level blocking takes effect.

---

## Quick start (developers)

```bash
pnpm install
pnpm dev
```

For development you’ll need **Node.js 18+**, **pnpm**, and **ffmpeg** on your `PATH`. Packaged builds and optional remote MCP access are configured in-app.

### macOS desktop (dev)

1. **ffmpeg** — install so `ffmpeg` and `ffprobe` are on your `PATH`, for example:

   ```bash
   brew install ffmpeg
   ```

2. **Fireworks** — at the repo root, you can add a `.env` file with your API key (or paste the key in the app under **Settings** instead):

   ```bash
   FIREWORKS_API_KEY=your_key_here
   ```

3. **Settings** — open the desktop app and go to **Settings** to confirm your Fireworks API key (or rely on `FIREWORKS_API_KEY` from `.env`).

4. **Screen Recording** — the first time you record, macOS may ask you to allow screen capture for the app in **System Settings → Privacy & Security → Screen Recording**.
