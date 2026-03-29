import * as fs from "fs";
import * as path from "path";
import { CONTEXT_ROOT, CHUNK_DURATION_MS } from "@context-manager/config";

const TMP_DIR = path.join(CONTEXT_ROOT, ".tmp");
const EXT = ".webm"; // MediaRecorder outputs webm

let currentFilePath: string | null = null;

/** Set by main process when recording starts/stops or rotates */
export function setCurrentFile(path: string | null): void {
  currentFilePath = path;
}

/** Ensure the temp directory exists for recordings */
export function ensureTmpDir(): void {
  if (!fs.existsSync(TMP_DIR)) {
    fs.mkdirSync(TMP_DIR, { recursive: true });
  }
}

/** Get the next recording file path based on current time */
export function getNextRecordingPath(): string {
  ensureTmpDir();
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  const h = String(now.getHours()).padStart(2, "0");
  const min = String(now.getMinutes()).padStart(2, "0");
  const sec = String(now.getSeconds()).padStart(2, "0");
  return path.join(TMP_DIR, `${y}-${m}-${d}_${h}-${min}-${sec}${EXT}`);
}

/** Chunk duration in ms for rotation */
export { CHUNK_DURATION_MS };

/** Get current recording file path, or null if not recording */
export function getCurrentFile(): string | null {
  return currentFilePath;
}

/** Get all unprocessed files in .tmp/, excluding current, sorted oldest-first */
export function getUnprocessedFiles(): string[] {
  if (!fs.existsSync(TMP_DIR)) {
    return [];
  }
  const files = fs.readdirSync(TMP_DIR);
  const webmFiles = files
    .filter((f) => f.endsWith(EXT))
    .map((f) => path.join(TMP_DIR, f));
  const exclude = currentFilePath ? path.basename(currentFilePath) : null;
  const filtered = exclude
    ? webmFiles.filter((f) => path.basename(f) !== exclude)
    : webmFiles;
  return filtered.sort((a, b) => a.localeCompare(b));
}
