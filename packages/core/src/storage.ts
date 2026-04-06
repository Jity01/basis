import * as fs from "fs/promises";
import * as path from "path";
import { CONTEXT_ROOT } from "@context-manager/config";

const FRAMES_DIR_NAME = "frames";
const META_FILE_NAME = "meta.json";
/** Per-chunk summary; day rollup is assembled at read time in searcher (no `index.txt`). */
export const SUMMARY_FILE_NAME = "summary.txt";
const REQUIRED_REPRESENTATIVE_FRAMES = 5;

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function chunkDirFromTimestamp(timestamp: Date): string {
  const yyyy = String(timestamp.getFullYear());
  const mm = pad2(timestamp.getMonth() + 1);
  const dd = pad2(timestamp.getDate());
  const hh = pad2(timestamp.getHours());
  const min = pad2(timestamp.getMinutes());
  return path.join(CONTEXT_ROOT, yyyy, mm, dd, `${hh}-${min}`);
}

/** Write one processed chunk to `~/.context/YYYY/MM/DD/HH-MM/`. */
export async function storeChunk(
  timestamp: Date,
  summary: string,
  meta: object,
  framePaths: string[]
): Promise<string> {
  if (framePaths.length < REQUIRED_REPRESENTATIVE_FRAMES) {
    console.warn(`storeChunk: requires at least ${REQUIRED_REPRESENTATIVE_FRAMES} frame paths, got ${framePaths.length}.`);
  }

  const chunkDir = chunkDirFromTimestamp(timestamp);
  const framesDir = path.join(chunkDir, FRAMES_DIR_NAME);

  await fs.mkdir(framesDir, { recursive: true });
  await fs.writeFile(
    path.join(chunkDir, SUMMARY_FILE_NAME),
    `${summary.trim()}\n`,
    "utf8"
  );
  await fs.writeFile(
    path.join(chunkDir, META_FILE_NAME),
    `${JSON.stringify(meta, null, 2)}\n`,
    "utf8"
  );

  for (let i = 0; i < Math.min(framePaths.length, REQUIRED_REPRESENTATIVE_FRAMES); i++) {
    const src = framePaths[i]!;
    const frameName = `${String(i + 1).padStart(3, "0")}.jpg`;
    const dest = path.join(framesDir, frameName);
    await fs.copyFile(src, dest);
  }

  return chunkDir;
}

const FAILED_DIR_NAME = ".failed";

/** Move a failed raw `.webm` from `.tmp/` into `.failed/` with error metadata (does not delete). */
export async function moveRawVideoToFailed(videoPath: string, err: unknown): Promise<void> {
  const tmpDir = path.resolve(path.join(CONTEXT_ROOT, ".tmp"));
  const failedRoot = path.resolve(path.join(CONTEXT_ROOT, FAILED_DIR_NAME));
  const resolvedVideoPath = path.resolve(videoPath);
  const resolvedMetaPath = path.resolve(`${videoPath}.meta.json`);

  if (
    resolvedVideoPath !== tmpDir &&
    !resolvedVideoPath.startsWith(`${tmpDir}${path.sep}`)
  ) {
    throw new Error(
      `Refusing to move file outside ${tmpDir}: ${resolvedVideoPath}`
    );
  }

  await fs.mkdir(failedRoot, { recursive: true });
  const destBase = `${Date.now()}_${path.basename(videoPath)}`;
  const destVideo = path.join(failedRoot, destBase);

  try {
    await fs.rename(resolvedVideoPath, destVideo);
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException)?.code === "ENOENT") {
      return;
    }
    throw e;
  }

  try {
    await fs.rename(resolvedMetaPath, `${destVideo}.meta.json`);
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException)?.code !== "ENOENT") {
      throw e;
    }
  }

  const message = err instanceof Error ? err.stack || err.message : String(err);
  await fs.writeFile(
    `${destVideo}.error.txt`,
    `${new Date().toISOString()}\n${message}\n`,
    "utf8"
  );
}

/** Delete a raw recording file that lives under `~/.context/.tmp/`. */
export async function deleteRawVideo(videoPath: string): Promise<void> {
  const tmpDir = path.resolve(path.join(CONTEXT_ROOT, ".tmp"));
  const resolvedVideoPath = path.resolve(videoPath);
  const resolvedMetaPath = path.resolve(`${videoPath}.meta.json`);

  if (
    resolvedVideoPath !== tmpDir &&
    !resolvedVideoPath.startsWith(`${tmpDir}${path.sep}`)
  ) {
    throw new Error(
      `Refusing to delete file outside ${tmpDir}: ${resolvedVideoPath}`
    );
  }

  try {
    await fs.unlink(resolvedVideoPath);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      // Continue so we still clean up stale sidecar metadata.
    } else {
      throw err;
    }
  }

  try {
    await fs.unlink(resolvedMetaPath);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      return;
    }
    throw err;
  }
}
