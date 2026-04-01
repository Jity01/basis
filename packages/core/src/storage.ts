import * as fs from "fs/promises";
import * as path from "path";
import { CONTEXT_ROOT } from "@context-manager/config";

const FRAMES_DIR_NAME = "frames";
const META_FILE_NAME = "meta.json";
const DAILY_INDEX_FILE_NAME = "index.txt";
const REQUIRED_REPRESENTATIVE_FRAMES = 5;
const INDEX_SECTION_PATTERN = /\[(\d{2}:\d{2})\]\n([\s\S]*?)(?=\n\n\[\d{2}:\d{2}\]\n|$)/g;

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

function dayDirFromDate(date: Date): string {
  const yyyy = String(date.getFullYear());
  const mm = pad2(date.getMonth() + 1);
  const dd = pad2(date.getDate());
  return path.join(CONTEXT_ROOT, yyyy, mm, dd);
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
  await upsertDailyIndex(timestamp, summary);
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

async function upsertDailyIndex(timestamp: Date, summary: string): Promise<void> {
  const dayDir = dayDirFromDate(timestamp);
  await fs.mkdir(dayDir, { recursive: true });

  const indexPath = path.join(dayDir, DAILY_INDEX_FILE_NAME);
  const hh = pad2(timestamp.getHours());
  const min = pad2(timestamp.getMinutes());
  const key = `${hh}:${min}`;

  const sections = new Map<string, string>();
  try {
    const existing = await fs.readFile(indexPath, "utf8");
    let match: RegExpExecArray | null;
    INDEX_SECTION_PATTERN.lastIndex = 0;
    while ((match = INDEX_SECTION_PATTERN.exec(existing)) != null) {
      sections.set(match[1], match[2].trim());
    }
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
      throw err;
    }
  }

  sections.set(key, summary.trim());

  const sorted = Array.from(sections.entries()).sort((a, b) =>
    a[0].localeCompare(b[0])
  );
  const indexContents =
    sorted.length > 0
      ? `${sorted.map(([k, v]) => `[${k}]\n${v}`).join("\n\n")}\n`
      : "";
  await fs.writeFile(indexPath, indexContents, "utf8");
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
