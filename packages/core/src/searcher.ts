import * as fs from "fs/promises";
import * as path from "path";
import { CONTEXT_ROOT } from "@context-manager/config";
import type { DaySummary, DayIndex, ChunkFrame, ChunkContext, DayCatalog } from "@context-manager/config";
import {
  SUMMARY_FILE_NAME,
  CATALOG_FILE_NAME,
  TEMPORAL_DESCRIPTION_FILE_NAME,
  OCR_DIR_NAME,
} from "./storage";

export type { DaySummary, DayIndex, ChunkFrame, ChunkContext, DayCatalog } from "@context-manager/config";

const DEFAULT_LIST_DAYS_LIMIT = 30;
const META_FILE_NAME = "meta.json";
const FRAMES_DIR_NAME = "frames";

async function readChunkNarrativeText(chunkDir: string): Promise<string> {
  const temporal = (await readTextFileSafe(path.join(chunkDir, TEMPORAL_DESCRIPTION_FILE_NAME))).trim();
  if (temporal) {
    return temporal;
  }
  return (await readTextFileSafe(path.join(chunkDir, SUMMARY_FILE_NAME))).trim();
}
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const CHUNK_DIR_RE = /^(\d{2})-(\d{2})$/;
const CHUNK_KEY_RE = /^(\d{4})-(\d{2})-(\d{2})\/(\d{2})-(\d{2})$/;

/** Exported for the legacy `index.txt` → `summary.txt` backfill script. */
export const INDEX_SECTION_PATTERN =
  /\[(\d{2}):(\d{2})\]\n([\s\S]*?)(?=\n\n\[\d{2}:\d{2}\]\n|$)/g;

type ParsedDate = {
  year: string;
  month: string;
  day: string;
};

type ParsedChunkKey = ParsedDate & {
  hour: string;
  minute: string;
};

async function readDirSafe(dirPath: string): Promise<import("fs").Dirent[]> {
  try {
    return await fs.readdir(dirPath, { withFileTypes: true });
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      return [];
    }
    throw err;
  }
}

async function readTextFileSafe(filePath: string): Promise<string> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      return "";
    }
    throw err;
  }
}

function parseDate(date: string): ParsedDate {
  const match = date.trim().match(DATE_RE);
  if (!match) {
    throw new Error(`Invalid date "${date}". Expected YYYY-MM-DD.`);
  }
  return {
    year: match[1]!,
    month: match[2]!,
    day: match[3]!,
  };
}

function parseChunkKey(chunkKey: string): ParsedChunkKey {
  const match = chunkKey.trim().match(CHUNK_KEY_RE);
  if (!match) {
    throw new Error(`Invalid chunkKey "${chunkKey}". Expected YYYY-MM-DD/HH-MM.`);
  }
  return {
    year: match[1]!,
    month: match[2]!,
    day: match[3]!,
    hour: match[4]!,
    minute: match[5]!,
  };
}

function dayPathFromDate(date: string, contextRoot: string): string {
  const parsed = parseDate(date);
  return path.join(contextRoot, parsed.year, parsed.month, parsed.day);
}

function chunkPathFromKey(chunkKey: string, contextRoot: string): string {
  const parsed = parseChunkKey(chunkKey);
  return path.join(
    contextRoot,
    parsed.year,
    parsed.month,
    parsed.day,
    `${parsed.hour}-${parsed.minute}`
  );
}

function clockTimeFromChunkDirName(chunkDirName: string): string | null {
  const match = chunkDirName.match(CHUNK_DIR_RE);
  if (!match) {
    return null;
  }
  return `${match[1]}:${match[2]}`;
}

function chunkKeyFromDateAndChunkDir(date: string, chunkDirName: string): string | null {
  const match = chunkDirName.match(CHUNK_DIR_RE);
  if (!match) {
    return null;
  }
  return `${date}/${match[1]}-${match[2]}`;
}

function mimeTypeForFile(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".png") {
    return "image/png";
  }
  if (ext === ".webp") {
    return "image/webp";
  }
  if (ext === ".gif") {
    return "image/gif";
  }
  return "image/jpeg";
}

async function listChunkDirNames(dayDir: string): Promise<string[]> {
  const entries = await readDirSafe(dayDir);
  return entries
    .filter((entry) => entry.isDirectory() && CHUNK_DIR_RE.test(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
}

async function readDaySummary(date: string, contextRoot: string): Promise<DaySummary> {
  const dayDir = dayPathFromDate(date, contextRoot);
  const chunkDirNames = await listChunkDirNames(dayDir);
  const timesWithSummary: string[] = [];
  for (const name of chunkDirNames) {
    const text = (await readChunkNarrativeText(path.join(dayDir, name))).trim();
    if (!text) {
      continue;
    }
    const t = clockTimeFromChunkDirName(name);
    if (t) {
      timesWithSummary.push(t);
    }
  }

  return {
    date,
    chunkCount: timesWithSummary.length,
    firstChunkTime: timesWithSummary[0] || null,
    lastChunkTime: timesWithSummary[timesWithSummary.length - 1] || null,
    hasIndex: timesWithSummary.length > 0,
  };
}

export async function listDays(
  contextRoot: string = CONTEXT_ROOT,
  limit: number = DEFAULT_LIST_DAYS_LIMIT
): Promise<DaySummary[]> {
  const yearEntries = await readDirSafe(contextRoot);
  const dates: string[] = [];

  for (const yearEntry of yearEntries) {
    if (!yearEntry.isDirectory() || !/^\d{4}$/.test(yearEntry.name)) {
      continue;
    }
    const yearDir = path.join(contextRoot, yearEntry.name);
    const monthEntries = await readDirSafe(yearDir);
    for (const monthEntry of monthEntries) {
      if (!monthEntry.isDirectory() || !/^\d{2}$/.test(monthEntry.name)) {
        continue;
      }
      const monthDir = path.join(yearDir, monthEntry.name);
      const dayEntries = await readDirSafe(monthDir);
      for (const dayEntry of dayEntries) {
        if (!dayEntry.isDirectory() || !/^\d{2}$/.test(dayEntry.name)) {
          continue;
        }
        dates.push(`${yearEntry.name}-${monthEntry.name}-${dayEntry.name}`);
      }
    }
  }

  const newestFirstDates = dates.sort((a, b) => b.localeCompare(a)).slice(0, Math.max(1, limit));
  return await Promise.all(newestFirstDates.map((date) => readDaySummary(date, contextRoot)));
}

async function buildDayIndexTextFromDisk(dayDir: string): Promise<string> {
  const chunkDirNames = await listChunkDirNames(dayDir);
  const parts: string[] = [];
  for (const name of chunkDirNames) {
    const text = (await readChunkNarrativeText(path.join(dayDir, name))).trim();
    if (!text) {
      continue;
    }
    const clock = clockTimeFromChunkDirName(name);
    if (!clock) {
      continue;
    }
    parts.push(`[${clock}]\n${text}`);
  }
  return parts.length > 0 ? `${parts.join("\n\n")}\n` : "";
}

export async function getDayIndex(
  date: string,
  contextRoot: string = CONTEXT_ROOT
): Promise<DayIndex> {
  const normalizedDate = `${parseDate(date).year}-${parseDate(date).month}-${parseDate(date).day}`;
  const dayDir = dayPathFromDate(normalizedDate, contextRoot);
  const chunkDirNames = await listChunkDirNames(dayDir);
  const chunkKeys: string[] = [];
  for (const name of chunkDirNames) {
    const text = (await readChunkNarrativeText(path.join(dayDir, name))).trim();
    if (!text) {
      continue;
    }
    const ck = chunkKeyFromDateAndChunkDir(normalizedDate, name);
    if (ck) {
      chunkKeys.push(ck);
    }
  }

  const indexText = (await buildDayIndexTextFromDisk(dayDir)).trim();
  const summary = await readDaySummary(normalizedDate, contextRoot);
  return {
    ...summary,
    chunkKeys,
    indexText,
  };
}

/** Read the structured catalog for a day, or null if not available. */
export async function readDayCatalog(
  date: string,
  contextRoot: string = CONTEXT_ROOT
): Promise<DayCatalog | null> {
  const normalizedDate = `${parseDate(date).year}-${parseDate(date).month}-${parseDate(date).day}`;
  const dayDir = dayPathFromDate(normalizedDate, contextRoot);
  const catalogPath = path.join(dayDir, CATALOG_FILE_NAME);
  try {
    const raw = await fs.readFile(catalogPath, "utf8");
    const catalog = JSON.parse(raw) as DayCatalog;
    if (Array.isArray(catalog.chunks)) {
      return catalog;
    }
    return null;
  } catch {
    return null;
  }
}

export async function getChunkContext(
  chunkKey: string,
  contextRoot: string = CONTEXT_ROOT
): Promise<ChunkContext> {
  const parsed = parseChunkKey(chunkKey);
  const normalizedChunkKey = `${parsed.year}-${parsed.month}-${parsed.day}/${parsed.hour}-${parsed.minute}`;
  const date = `${parsed.year}-${parsed.month}-${parsed.day}`;
  const time = `${parsed.hour}:${parsed.minute}`;
  const chunkDir = chunkPathFromKey(normalizedChunkKey, contextRoot);

  const [narrativeRaw, metaText] = await Promise.all([
    readChunkNarrativeText(chunkDir),
    readTextFileSafe(path.join(chunkDir, META_FILE_NAME)),
  ]);

  const summaryText =
    narrativeRaw.trim() || "(missing temporal_description.txt or summary.txt)";

  let meta: Record<string, unknown> | null = null;
  if (metaText.trim()) {
    meta = JSON.parse(metaText) as Record<string, unknown>;
  }

  const ocrDir = path.join(chunkDir, OCR_DIR_NAME);
  const ocrEntries = await readDirSafe(ocrDir);
  const ocrFiles = ocrEntries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".txt"))
    .map((entry) => path.join(ocrDir, entry.name))
    .sort((a, b) => a.localeCompare(b));

  let ocrTexts: { name: string; text: string }[] | undefined;
  if (ocrFiles.length > 0) {
    ocrTexts = await Promise.all(
      ocrFiles.map(async (p) => ({
        name: path.basename(p),
        text: (await readTextFileSafe(p)).trim(),
      }))
    );
  }

  const frameEntries = await readDirSafe(path.join(chunkDir, FRAMES_DIR_NAME));
  const frameFiles = frameEntries
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(chunkDir, FRAMES_DIR_NAME, entry.name))
    .sort((a, b) => a.localeCompare(b));

  const frames = await Promise.all(
    frameFiles.map(async (framePath) => {
      const data = await fs.readFile(framePath);
      return {
        name: path.basename(framePath),
        path: framePath,
        mimeType: mimeTypeForFile(framePath),
        data: data.toString("base64"),
      } satisfies ChunkFrame;
    })
  );

  return {
    chunkKey: normalizedChunkKey,
    date,
    time,
    summaryText,
    meta,
    frames,
    ...(ocrTexts && ocrTexts.length > 0 ? { ocrTexts } : {}),
  };
}
