import * as path from "path";
import * as os from "os";

export const CONTEXT_ROOT =
  process.env.CONTEXT_ROOT || path.join(os.homedir(), ".context");
export const CHUNK_DURATION_MS = 300_000; // 5 minutes
export const FRAMES_PER_CHUNK = 15;
export const FRAMES_TO_KEEP = 5;

/** Rolling live screen buffer (`.context/.hotbuffer/`) — decoupled from chunk pipeline. */
export const HOT_BUFFER_CONFIG = {
  captureIntervalMs: 2000,
  maxEntries: 30,
  maxAgeMs: 60_000,
  purgeIntervalMs: 30_000,
  resolution: { width: 1280, height: 720 },
  jpegQuality: 70,
  maxFrameSizeBytes: 200_000,
} as const;

export function hotBufferDir(contextRoot: string = CONTEXT_ROOT): string {
  return path.join(contextRoot, ".hotbuffer");
}

