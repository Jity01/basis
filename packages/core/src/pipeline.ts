import * as fs from "fs/promises";
import * as path from "path";
import {
  CHUNK_DURATION_MS,
  CONTEXT_ROOT,
  FRAMES_PER_CHUNK,
  FRAMES_TO_KEEP,
} from "@context-manager/config";
import { extractFrames, selectRepresentativeFrames } from "./frames";
import { deleteRawVideo, storeChunk } from "./storage";
import { tagChunk } from "./tagger";
import type { AISettings } from "./aiSettings";

const TMP_DIR = path.join(CONTEXT_ROOT, ".tmp");
const MAX_ROLLING_CONTEXT_GAP_MS = 30 * 60 * 1000;

type BacklogItem = {
  filePath: string;
  mtimeMs: number;
  chunkStart: Date;
};

export type ProcessBacklogProgress =
  | { phase: "start"; total: number; completed: number }
  | { phase: "chunk-start"; total: number; completed: number; filePath: string }
  | { phase: "chunk-complete"; total: number; completed: number; filePath: string }
  | { phase: "paused"; total: number; completed: number }
  | { phase: "done"; total: number; completed: number };

export type ProcessBacklogOptions = {
  onProgress?: (progress: ProcessBacklogProgress) => void;
  aiSettings?: AISettings;
};

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function isSameLocalDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
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
    });
  }

  backlog.sort((a, b) => a.mtimeMs - b.mtimeMs || a.filePath.localeCompare(b.filePath));
  return backlog;
}

/**
 * Process all unprocessed raw chunk files in `~/.context/.tmp/` (except current).
 * For each chunk: extract -> tag -> choose representative frames -> store -> delete raw file.
 * Can be paused via `shouldContinue`; reruns will resume from remaining files.
 */
export async function processBacklog(
  getCurrentFile: () => string | null,
  shouldContinue: () => boolean,
  options: ProcessBacklogOptions = {}
): Promise<void> {
  const backlog = await getBacklogFiles(getCurrentFile());
  const total = backlog.length;
  let rollingContext = "";
  let previousChunkStart: Date | null = null;
  let completed = 0;

  options.onProgress?.({ phase: "start", total, completed });

  for (const item of backlog) {
    options.onProgress?.({
      phase: "chunk-start",
      total,
      completed,
      filePath: item.filePath,
    });

    const chunkStart = item.chunkStart;
    const chunkEnd = new Date(chunkStart.getTime() + CHUNK_DURATION_MS);

    const shouldResetContext =
      previousChunkStart === null ||
      !isSameLocalDay(previousChunkStart, chunkStart) ||
      chunkStart.getTime() - previousChunkStart.getTime() > MAX_ROLLING_CONTEXT_GAP_MS;
    if (shouldResetContext) {
      rollingContext = "";
    }

    const allFrames = await extractFrames(item.filePath, FRAMES_PER_CHUNK);
    const summary = await tagChunk(
      allFrames,
      hhmmss(chunkStart),
      hhmmss(chunkEnd),
      rollingContext,
      options.aiSettings
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
        processed_at_iso: new Date().toISOString(),
        frames_extracted: allFrames.length,
        frames_stored: representativeFrames.length,
      },
      representativeFrames
    );

    await deleteRawVideo(item.filePath);
    rollingContext = summary.trim();
    previousChunkStart = chunkStart;
    completed += 1;
    options.onProgress?.({
      phase: "chunk-complete",
      total,
      completed,
      filePath: item.filePath,
    });

    if (!shouldContinue()) {
      options.onProgress?.({ phase: "paused", total, completed });
      return;
    }
  }

  options.onProgress?.({ phase: "done", total, completed });
}
