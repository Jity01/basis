import * as fs from "fs";
import * as path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import screenshot from "screenshot-desktop";
import sharp from "sharp";
import { CONTEXT_ROOT, HOT_BUFFER_CONFIG, hotBufferDir as hotBufferDirFromRoot } from "@context-manager/config";

const execFileAsync = promisify(execFile);

export interface HotBufferConfig {
  captureIntervalMs: number;
  maxAgeMs: number;
  purgeIntervalMs: number;
  resolution: { width: number; height: number };
  jpegQuality: number;
  hotbufferDir: string;
  /** macOS: path to Vision OCR CLI (JPEG path as argv[1], UTF-8 text on stdout). */
  ocrBinaryPath?: string;
}

export interface HotBufferEntry {
  timestamp: number;
  timestampISO: string;
  app: string;
  windowTitle: string;
  ocrText: string;
}

export interface HotBufferSnapshot extends HotBufferEntry {
  frameBuffer: Buffer;
}

let captureTimer: ReturnType<typeof setInterval> | null = null;
let purgeTimer: ReturnType<typeof setInterval> | null = null;
let captureInFlight = false;
let activeConfig: HotBufferConfig | null = null;

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

async function getFrontWindowInfoDarwin(): Promise<{ app: string; windowTitle: string }> {
  const script = `tell application "System Events"
  set frontApp to name of first application process whose frontmost is true
  set windowTitle to ""
  try
    tell process frontApp
      if (count of windows) > 0 then
        set windowTitle to name of window 1
      end if
    end tell
  end try
  return frontApp & "|||" & windowTitle
end tell`;
  try {
    const { stdout } = await execFileAsync("osascript", ["-e", script], {
      timeout: 5000,
      maxBuffer: 1024 * 1024,
    });
    const text = String(stdout).trim();
    const parts = text.split("|||");
    const app = parts[0] ?? "";
    const windowTitle = parts.slice(1).join("|||");
    return { app, windowTitle };
  } catch {
    return { app: "", windowTitle: "" };
  }
}

async function getFrontWindowInfo(): Promise<{ app: string; windowTitle: string }> {
  if (process.platform === "darwin") {
    return getFrontWindowInfoDarwin();
  }
  return { app: "", windowTitle: "" };
}

async function runOcr(jpegPath: string, ocrBinaryPath: string | undefined): Promise<string> {
  if (!ocrBinaryPath || !fs.existsSync(ocrBinaryPath)) {
    return "";
  }
  try {
    const { stdout } = await execFileAsync(ocrBinaryPath, [jpegPath], {
      timeout: 60_000,
      maxBuffer: 10 * 1024 * 1024,
      encoding: "utf8",
    });
    return String(stdout).trim();
  } catch (err) {
    console.error("[hotbuffer] OCR failed:", err instanceof Error ? err.message : err);
    return "";
  }
}

async function encodeJpegUnderCap(
  raw: Buffer,
  width: number,
  height: number,
  quality: number,
  maxBytes: number
): Promise<Buffer> {
  let q = quality;
  let buf = await sharp(raw)
    .resize(width, height, { fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: q, mozjpeg: true })
    .toBuffer();
  while (buf.length > maxBytes && q > 40) {
    q -= 5;
    buf = await sharp(raw)
      .resize(width, height, { fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: q, mozjpeg: true })
      .toBuffer();
  }
  return buf;
}

async function captureOnce(config: HotBufferConfig): Promise<void> {
  if (process.platform !== "darwin") {
    console.warn("[hotbuffer] Screen capture is only enabled on macOS in this build.");
    return;
  }

  const { width, height } = config.resolution;
  const maxBytes = HOT_BUFFER_CONFIG.maxFrameSizeBytes;

  let raw: Buffer;
  try {
    raw = await screenshot({ format: "png" });
  } catch (err) {
    console.error("[hotbuffer] Screenshot failed:", err instanceof Error ? err.message : err);
    return;
  }

  let jpeg: Buffer;
  try {
    jpeg = await encodeJpegUnderCap(raw, width, height, config.jpegQuality, maxBytes);
  } catch (err) {
    console.error("[hotbuffer] JPEG encode failed:", err instanceof Error ? err.message : err);
    return;
  }

  const ts = Date.now();
  const { app, windowTitle } = await getFrontWindowInfo();

  ensureDir(config.hotbufferDir);
  const base = path.join(config.hotbufferDir, String(ts));
  const jpgPath = `${base}.jpg`;
  fs.writeFileSync(jpgPath, jpeg);

  const ocrFromVision = await runOcr(jpgPath, config.ocrBinaryPath);
  const meta: HotBufferEntry = {
    timestamp: ts,
    timestampISO: new Date(ts).toISOString(),
    app,
    windowTitle,
    ocrText: ocrFromVision,
  };
  fs.writeFileSync(`${base}.json`, `${JSON.stringify(meta, null, 2)}\n`, "utf8");

  trimToMaxEntries(config.hotbufferDir, HOT_BUFFER_CONFIG.maxEntries);
}

function trimToMaxEntries(dir: string, maxEntries: number): void {
  let files: string[];
  try {
    files = fs.readdirSync(dir);
  } catch {
    return;
  }
  const stamps = files
    .filter((f) => f.endsWith(".json"))
    .map((f) => Number(path.basename(f, ".json")))
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => b - a);
  if (stamps.length <= maxEntries) {
    return;
  }
  const drop = stamps.slice(maxEntries);
  for (const ts of drop) {
    const jpg = path.join(dir, `${ts}.jpg`);
    const jsonPath = path.join(dir, `${ts}.json`);
    try {
      fs.unlinkSync(jpg);
    } catch {
      /* ignore */
    }
    try {
      fs.unlinkSync(jsonPath);
    } catch {
      /* ignore */
    }
  }
}

function purgeOld(dir: string, maxAgeMs: number): void {
  const cutoff = Date.now() - maxAgeMs;
  let files: string[];
  try {
    files = fs.readdirSync(dir);
  } catch {
    return;
  }
  const stamps = files
    .filter((f) => f.endsWith(".json"))
    .map((f) => Number(path.basename(f, ".json")))
    .filter((n) => Number.isFinite(n));
  for (const ts of stamps) {
    if (!Number.isFinite(ts) || ts >= cutoff) {
      continue;
    }
    const jpg = path.join(dir, `${ts}.jpg`);
    const jsonPath = path.join(dir, `${ts}.json`);
    try {
      fs.unlinkSync(jpg);
    } catch {
      /* ignore */
    }
    try {
      fs.unlinkSync(jsonPath);
    } catch {
      /* ignore */
    }
  }
}

export function startHotBuffer(config: HotBufferConfig): void {
  stopHotBuffer();
  activeConfig = config;
  ensureDir(config.hotbufferDir);

  if (process.platform !== "darwin") {
    console.warn("[hotbuffer] Not starting capture loop (unsupported platform).");
    return;
  }

  void captureOnce(config).catch((err) =>
    console.error("[hotbuffer] Initial capture error:", err instanceof Error ? err.message : err)
  );

  captureTimer = setInterval(() => {
    if (captureInFlight || !activeConfig) {
      return;
    }
    captureInFlight = true;
    void captureOnce(activeConfig)
      .catch((err) => console.error("[hotbuffer] Capture error:", err instanceof Error ? err.message : err))
      .finally(() => {
        captureInFlight = false;
      });
  }, config.captureIntervalMs);

  purgeTimer = setInterval(() => {
    if (!activeConfig) {
      return;
    }
    purgeOld(activeConfig.hotbufferDir, activeConfig.maxAgeMs);
    trimToMaxEntries(activeConfig.hotbufferDir, HOT_BUFFER_CONFIG.maxEntries);
  }, config.purgeIntervalMs);
}

export function stopHotBuffer(): void {
  if (captureTimer) {
    clearInterval(captureTimer);
    captureTimer = null;
  }
  if (purgeTimer) {
    clearInterval(purgeTimer);
    purgeTimer = null;
  }
  activeConfig = null;
  captureInFlight = false;
}

function readAllEntriesFromDisk(hotbufferDir: string): HotBufferEntry[] {
  if (!fs.existsSync(hotbufferDir)) {
    return [];
  }
  let files: string[];
  try {
    files = fs.readdirSync(hotbufferDir);
  } catch {
    return [];
  }
  const entries: HotBufferEntry[] = [];
  for (const f of files) {
    if (!f.endsWith(".json")) {
      continue;
    }
    const fp = path.join(hotbufferDir, f);
    try {
      const raw = fs.readFileSync(fp, "utf8");
      const parsed = JSON.parse(raw) as Partial<HotBufferEntry>;
      if (
        typeof parsed.timestamp === "number" &&
        typeof parsed.timestampISO === "string" &&
        typeof parsed.app === "string" &&
        typeof parsed.windowTitle === "string" &&
        typeof parsed.ocrText === "string"
      ) {
        entries.push({
          timestamp: parsed.timestamp,
          timestampISO: parsed.timestampISO,
          app: parsed.app,
          windowTitle: parsed.windowTitle,
          ocrText: parsed.ocrText,
        });
      }
    } catch {
      /* skip corrupt */
    }
  }
  entries.sort((a, b) => b.timestamp - a.timestamp);
  return entries;
}

/** @param contextRoot - defaults to CONTEXT_ROOT */
export function readHotBuffer(
  lastNSeconds?: number,
  contextRoot: string = CONTEXT_ROOT
): HotBufferEntry[] {
  const sec = Math.min(60, Math.max(1, lastNSeconds ?? 30));
  const dir = hotBufferDirFromRoot(contextRoot);
  const entries = readAllEntriesFromDisk(dir);
  const cutoff = Date.now() - sec * 1000;
  return entries.filter((e) => e.timestamp >= cutoff);
}

export function readHotFrame(timestamp: number, contextRoot: string = CONTEXT_ROOT): Buffer | null {
  const dir = hotBufferDirFromRoot(contextRoot);
  const jpg = path.join(dir, `${timestamp}.jpg`);
  try {
    if (!fs.existsSync(jpg)) {
      return null;
    }
    return fs.readFileSync(jpg);
  } catch {
    return null;
  }
}

export function readLatestSnapshots(
  count: number = 2,
  contextRoot: string = CONTEXT_ROOT
): HotBufferSnapshot[] {
  const dir = hotBufferDirFromRoot(contextRoot);
  const entries = readAllEntriesFromDisk(dir);
  const n = Math.max(1, Math.min(5, count));
  const slice = entries.slice(0, n);
  const out: HotBufferSnapshot[] = [];
  for (const e of slice) {
    const buf = readHotFrame(e.timestamp, contextRoot);
    if (buf) {
      out.push({ ...e, frameBuffer: buf });
    }
  }
  return out;
}
