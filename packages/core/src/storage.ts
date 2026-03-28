import * as fs from "fs/promises";
import * as path from "path";
import { CONTEXT_ROOT } from "@context-manager/config";

const FRAMES_DIR_NAME = "frames";
const SUMMARY_FILE_NAME = "summary.txt";
const META_FILE_NAME = "meta.json";
const DAILY_INDEX_FILE_NAME = "index.txt";
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
  await fs.writeFile(path.join(chunkDir, SUMMARY_FILE_NAME), summary, "utf8");
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

/** Rebuild daily `index.txt` from all `summary.txt` files for the given date. */
export async function updateDailyIndex(date: Date): Promise<void> {
  const dayDir = dayDirFromDate(date);
  await fs.mkdir(dayDir, { recursive: true });

  const entries = await fs.readdir(dayDir, { withFileTypes: true });
  const chunkDirs = entries
    .filter((entry) => entry.isDirectory() && /^\d{2}-\d{2}$/.test(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));

  const sections: string[] = [];
  for (const dirName of chunkDirs) {
    const summaryPath = path.join(dayDir, dirName, SUMMARY_FILE_NAME);
    let summaryText: string;
    try {
      summaryText = (await fs.readFile(summaryPath, "utf8")).trim();
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
        console.warn(`Daily index: summary file not found: ${summaryPath}`);
        continue;
      }
      throw err;
    }

    if (!summaryText) {
      continue;
    }

    const [hh, min] = dirName.split("-");
    sections.push(`[${hh}:${min}]\n${summaryText}`);
  }

  const indexContents =
    sections.length > 0 ? `${sections.join("\n\n")}\n` : "";
  await fs.writeFile(path.join(dayDir, DAILY_INDEX_FILE_NAME), indexContents, "utf8");
}

/** Delete a raw recording file that lives under `~/.context/.tmp/`. */
export async function deleteRawVideo(videoPath: string): Promise<void> {
  const tmpDir = path.resolve(path.join(CONTEXT_ROOT, ".tmp"));
  const resolvedVideoPath = path.resolve(videoPath);

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
      return;
    }
    throw err;
  }
}
