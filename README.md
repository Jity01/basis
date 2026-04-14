# JustReheat

**Screen context for your AI.** JustReheat records your screen, summarizes what you do, and organizes it into a local filesystem that any AI model or agent can search—so you never have to explain yourself twice.

Open source, private, and local by default.

## Using the desktop app

These steps are for anyone running the **desktop app** (not for building from source).

### 1. Screen recording (macOS)

The first time you capture your screen, macOS may ask for permission. Allow it in **System Settings → Privacy & Security → Screen Recording**, and enable the app in the list if it appears there.

### 2. Fireworks API key

Summaries and image understanding use [Fireworks](https://fireworks.ai/). You need an API key from your Fireworks account.

1. Open the app and go to **Settings** (tab in the app).
2. Under **AI settings**, paste your key into **Fireworks API key**.
3. Click **Save Settings** at the bottom so the key is stored.

Without a valid key, processing that depends on Fireworks will not run.

### 3. Scope grants (required for MCP)

If you connect an AI assistant (for example Claude Desktop) to JustReheat over **MCP**, you must turn on **scope grants** in the app. Until you do, MCP tools will return errors asking for permission—**your assistant cannot read your context through MCP without these**.

1. In **Settings**, scroll to **Scope Grants** (below **MCP Access (Local stdio)**).
2. Enable the scopes you are comfortable with:
   - **context:metadata** — day names, summaries, search results (least sensitive).
   - **context:ocr** — text read from the screen (more sensitive).
   - **context:frames** — actual screenshots (most sensitive).

Some tools only need metadata; others need OCR or frames. Enable at least what your workflows require, then click **Save Settings**.

### 4. Excluded windows (privacy)

To stop specific apps from ever being captured (their pixels never enter JustReheat):

1. In **Settings**, open **Privacy — Excluded Windows**.
2. Click **Add App**, search for an app, and add it—or enter a **bundle ID** manually if you know it.
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

   Optional: `FIREWORKS_MODEL` and `FIREWORKS_BASE_URL` if you don’t want the defaults. The app reads this `.env` when you run from the monorepo.

3. **Settings** — open the desktop app and go to **Settings** to confirm your Fireworks API key (or rely on `FIREWORKS_API_KEY` from `.env`), configure **Scope Grants** if you use MCP, and set **Excluded Windows** as needed.

4. **Screen Recording** — the first time you record, macOS may ask you to allow screen capture for the app in **System Settings → Privacy & Security → Screen Recording**.

---

[JustReheat](https://github.com/Jity01/basis) · [Basis Labs](https://www.linkedin.com/company/justreheat)
