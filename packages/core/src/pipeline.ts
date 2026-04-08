import * as fs from "fs/promises";
import * as path from "path";
import {
  CONTEXT_ROOT,
  FRAMES_PER_CHUNK,
  FRAMES_TO_KEEP,
  MAX_RETRIES,
  PIPELINE_CONCURRENCY,
  RETRY_DELAY_MS,
} from "@context-manager/config";
import type { AISettings, ProcessBacklogProgress, ProcessBacklogOptions } from "@context-manager/config";
import { extractFrames, selectRepresentativeFrames } from "./frames";
import { readChunkDurationMsForFile } from "./recorder";
import { deleteRawVideo, moveRawVideoToFailed, storeChunk, appendToCatalog, CATALOG_FILE_NAME } from "./storage";
import { tagChunk, extractChunkMetadata } from "./tagger";
import { computeSessions } from "./sessions";
import { updateProfile } from "./profile";

export type { ProcessBacklogProgress, ProcessBacklogOptions } from "@context-manager/config";

const TMP_DIR = path.join(CONTEXT_ROOT, ".tmp");

type BacklogItem = {
  filePath: string;
  mtimeMs: number;
  chunkStart: Date;
  chunkDurationMs: number;
};

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function hhmmss(d: Date): string {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/**
 * Recorder file names follow `YYYY-MM-DD_HH-MM.webm`.
 * If parsing fails, we fall back to filesystem mtime.
 */
function chunkStartFromNameOrMtime(filePath: string, mtimeMs: number): Date {
  const base = path.basename(filePath);
  const m = base.match(/^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})/);
  if (!m) {
    return new Date(mtimeMs);
  }

  const year = Number(m[1]);
  const month = Number(m[2]) - 1;
  const day = Number(m[3]);
  const hour = Number(m[4]);
  const minute = Number(m[5]);
  const parsed = new Date(year, month, day, hour, minute, 0, 0);
  if (Number.isNaN(parsed.getTime())) {
    return new Date(mtimeMs);
  }
  return parsed;
}

async function getBacklogFiles(currentFile: string | null): Promise<BacklogItem[]> {
  let entries: import("fs").Dirent[];
  try {
    entries = (await fs.readdir(TMP_DIR, {
      withFileTypes: true,
      encoding: "utf8",
    })) as import("fs").Dirent[];
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      return [];
    }
    throw err;
  }

  const currentAbs = currentFile ? path.resolve(currentFile) : null;
  const currentBase = currentFile ? path.basename(currentFile) : null;
  const backlog: BacklogItem[] = [];

  for (const entry of entries) {
    const entryName = String(entry.name);
    if (!entry.isFile()) {
      continue;
    }
    if (path.extname(entryName).toLowerCase() !== ".webm") {
      continue;
    }

    const filePath = path.join(TMP_DIR, entryName);
    const filePathAbs = path.resolve(filePath);
    if (
      (currentAbs && filePathAbs === currentAbs) ||
      (currentBase && entryName === currentBase)
    ) {
      continue;
    }

    const stat = await fs.stat(filePath);
    backlog.push({
      filePath,
      mtimeMs: stat.mtimeMs,
      chunkStart: chunkStartFromNameOrMtime(filePath, stat.mtimeMs),
      chunkDurationMs: readChunkDurationMsForFile(filePath),
    });
  }

  backlog.sort((a, b) => a.mtimeMs - b.mtimeMs || a.filePath.localeCompare(b.filePath));
  return backlog;
}

async function processOneChunk(
  item: BacklogItem,
  aiSettings?: AISettings
): Promise<void> {
  const chunkStart = item.chunkStart;
  const chunkEnd = new Date(chunkStart.getTime() + item.chunkDurationMs);

  const startTimeStr = hhmmss(chunkStart);
  const endTimeStr = hhmmss(chunkEnd);

  const allFrames = await extractFrames(item.filePath, FRAMES_PER_CHUNK);

  // Pass 1: prose summary (unchanged from original)
  const summary = await tagChunk(allFrames, startTimeStr, endTimeStr, aiSettings);

  // Pass 2: structured metadata extraction
  const metadata = await extractChunkMetadata(
    summary,
    allFrames,
    startTimeStr,
    endTimeStr,
    aiSettings
  );

  const representativeFrames = selectRepresentativeFrames(allFrames, FRAMES_TO_KEEP);

  await storeChunk(
    chunkStart,
    summary,
    {
      raw_video_file: path.basename(item.filePath),
      raw_video_path: item.filePath,
      chunk_start_iso: chunkStart.toISOString(),
      chunk_end_iso: chunkEnd.toISOString(),
      chunk_duration_ms: item.chunkDurationMs,
      processed_at_iso: new Date().toISOString(),
      frames_extracted: allFrames.length,
      frames_stored: representativeFrames.length,
      ...metadata,
    },
    representativeFrames
  );

  await appendToCatalog(chunkStart, summary, metadata);
  await deleteRawVideo(item.filePath);
}

async function processChunkWithRetry(
  item: BacklogItem,
  aiSettings?: AISettings
): Promise<boolean> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      await processOneChunk(item, aiSettings);
      return true;
    } catch (err: unknown) {
      if (attempt === MAX_RETRIES) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[pipeline] chunk failed after retries: ${item.filePath}: ${message}`);
        await moveRawVideoToFailed(item.filePath, err);
        return false;
      }
      await sleep(RETRY_DELAY_MS * Math.pow(2, attempt));
    }
  }
  return false;
}

/**
 * Process all unprocessed raw chunk files in `~/context/.tmp/` (except current).
 * Chunks are processed in parallel batches (concurrency-limited). Each chunk is independent.
 * Can be paused via `shouldContinue`; reruns will resume from remaining files.
 */
export async function processBacklog(
  getCurrentFile: () => string | null,
  shouldContinue: () => boolean,
  options: ProcessBacklogOptions = {}
): Promise<void> {
  const backlog = await getBacklogFiles(getCurrentFile());
  const total = backlog.length;
  let completed = 0;
  let completedChain: Promise<void> = Promise.resolve();
  const incrementCompleted = (): Promise<number> => {
    return new Promise((resolve, reject) => {
      completedChain = completedChain
        .then(() => {
          completed += 1;
          resolve(completed);
        })
        .catch(reject);
    });
  };

  options.onProgress?.({ phase: "start", total, completed });

  for (let i = 0; i < backlog.length; i += PIPELINE_CONCURRENCY) {
    if (!shouldContinue()) {
      options.onProgress?.({ phase: "paused", total, completed });
      return;
    }

    const batch = backlog.slice(i, i + PIPELINE_CONCURRENCY);
    await Promise.all(
      batch.map(async (item) => {
        options.onProgress?.({
          phase: "chunk-start",
          total,
          completed,
          filePath: item.filePath,
        });

        const ok = await processChunkWithRetry(item, options.aiSettings);
        if (ok) {
          const c = await incrementCompleted();
          options.onProgress?.({
            phase: "chunk-complete",
            total,
            completed: c,
            filePath: item.filePath,
          });
        }
      })
    );
  }

  options.onProgress?.({ phase: "done", total, completed });

  // Post-processing: compute sessions for affected days
  if (completed > 0) {
    const affectedDates = new Set<string>();
    for (const item of backlog) {
      const d = item.chunkStart;
      const dateStr = `${String(d.getFullYear())}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
      affectedDates.add(dateStr);
    }
    for (const date of Array.from(affectedDates)) {
      try {
        const [yyyy, mm, dd] = date.split("-");
        const catalogPath = path.join(CONTEXT_ROOT, yyyy!, mm!, dd!, CATALOG_FILE_NAME);
        const raw = await fs.readFile(catalogPath, "utf8");
        const catalog = JSON.parse(raw) as import("@context-manager/config").DayCatalog;
        if (Array.isArray(catalog.chunks) && catalog.chunks.length > 0) {
          const daySessions = await computeSessions(catalog, CONTEXT_ROOT, options.aiSettings);
          await updateProfile(daySessions);
        }
      } catch {
        // Catalog may not exist yet for this day
      }
    }
  }
}
