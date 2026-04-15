import * as path from "path";
import { CONTEXT_ROOT } from "./paths";
export * from "./types";
export * from "./credentials";
export * from "./paths";
export { DEFAULT_LOCAL_SCOPES } from "./localScopes";

export const CHUNK_DURATION_MS = 60_000; // 1 minute
export const FRAMES_PER_CHUNK = 15;
export const FRAMES_TO_KEEP = 5;

/** Parallel Fireworks tagging calls in the chunk pipeline (safe default vs typical RPM limits). */
export const PIPELINE_CONCURRENCY = 10;
/** Per-chunk retries after a failed API/store step (attempts = MAX_RETRIES + 1). */
export const MAX_RETRIES = 2;
export const RETRY_DELAY_MS = 1000;

/** Rolling live screen buffer (`context/.hotbuffer/`) — decoupled from chunk pipeline. */
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

/** Flat wiki root under context (`~/context/wiki/`). */
export const WIKI_DIR_NAME = "wiki";
export const OCR_DIR_NAME = "ocr";
export const TEMPORAL_DESCRIPTION_FILE_NAME = "temporal_description.txt";
export const TEMPORAL_INDEX_FILE_NAME = "temporal_index.json";

/** Fireworks chat model for wiki JSON ops (text-only). Override with `FIREWORKS_WIKI_MODEL`. */
export const DEFAULT_WIKI_TEXT_MODEL =
  process.env.FIREWORKS_WIKI_MODEL?.trim() || "accounts/fireworks/models/llama-v3p3-70b-instruct";

export function wikiRootPath(contextRoot: string = CONTEXT_ROOT): string {
  return path.join(contextRoot, WIKI_DIR_NAME);
}
