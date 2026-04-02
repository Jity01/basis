import * as fs from "fs/promises";
import * as path from "path";
import { CONTEXT_ROOT } from "@context-manager/config";

const DEFAULT_LIST_DAYS_LIMIT = 30;
const INDEX_FILE_NAME = "index.txt";
const META_FILE_NAME = "meta.json";
const FRAMES_DIR_NAME = "frames";
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const CHUNK_DIR_RE = /^(\d{2})-(\d{2})$/;
const CHUNK_KEY_RE = /^(\d{4})-(\d{2})-(\d{2})\/(\d{2})-(\d{2})$/;

const INDEX_SECTION_PATTERN = /\[(\d{2}):(\d{2})\]\n([\s\S]*?)(?=\n\n\[\d{2}:\d{2}\]\n|$)/g;

export type DaySummary = {
  date: string;
  chunkCount: number;
  firstChunkTime: string | null;
  lastChunkTime: string | null;
  hasIndex: boolean;
};

export type DayIndex = DaySummary & {
  chunkKeys: string[];
  indexText: string;
};

export type ChunkFrame = {
  name: string;
  path: string;
  mimeType: string;
  data: string;
};

export type ChunkContext = {
  chunkKey: string;
  date: string;
  time: string;
  summaryText: string;
  meta: Record<string, unknown> | null;
  frames: ChunkFrame[];
};

type ParsedDate = {
  year: string;
  month: string;
  day: string;
};

type ParsedChunkKey = ParsedDate & {
  hour: string;
  minute: string;
};

type IndexEntry = {
  time: string;
  chunkKey: string;
  summaryText: string;
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

function parseIndexEntries(date: string, indexText: string): IndexEntry[] {
  const out: IndexEntry[] = [];
  INDEX_SECTION_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = INDEX_SECTION_PATTERN.exec(indexText)) != null) {
    const hour = match[1]!;
    const minute = match[2]!;
    const summaryText = (match[3] || "").trim();
    if (!summaryText) {
      continue;
    }
    out.push({
      time: `${hour}:${minute}`,
      chunkKey: `${date}/${hour}-${minute}`,
      summaryText,
    });
  }
  return out;
}

function buildSummaryTextByChunkKey(date: string, indexText: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const entry of parseIndexEntries(date, indexText)) {
    out.set(entry.chunkKey, entry.summaryText);
  }
  return out;
}

function mergeSortedUnique(values: string[]): string[] {
  return Array.from(new Set(values)).sort((a, b) => a.localeCompare(b));
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
  const [chunkDirNames, indexText] = await Promise.all([
    listChunkDirNames(dayDir),
    readTextFileSafe(path.join(dayDir, INDEX_FILE_NAME)),
  ]);
  const indexTimes = parseIndexEntries(date, indexText).map((entry) => entry.time);
  const chunkTimes = chunkDirNames
    .map((chunkDirName) => clockTimeFromChunkDirName(chunkDirName))
    .filter((time): time is string => Boolean(time));
  const allTimes = mergeSortedUnique([...chunkTimes, ...indexTimes]);

  return {
    date,
    chunkCount: mergeSortedUnique([
      ...chunkDirNames
        .map((chunkDirName) => chunkKeyFromDateAndChunkDir(date, chunkDirName))
        .filter((chunkKey): chunkKey is string => Boolean(chunkKey)),
      ...parseIndexEntries(date, indexText).map((entry) => entry.chunkKey),
    ]).length,
    firstChunkTime: allTimes[0] || null,
    lastChunkTime: allTimes[allTimes.length - 1] || null,
    hasIndex: indexText.trim().length > 0,
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

export async function getDayIndex(
  date: string,
  contextRoot: string = CONTEXT_ROOT
): Promise<DayIndex> {
  const normalizedDate = `${parseDate(date).year}-${parseDate(date).month}-${parseDate(date).day}`;
  const dayDir = dayPathFromDate(normalizedDate, contextRoot);
  const [chunkDirNames, rawIndexText] = await Promise.all([
    listChunkDirNames(dayDir),
    readTextFileSafe(path.join(dayDir, INDEX_FILE_NAME)),
  ]);

  const indexText = rawIndexText.trim();
  const chunkKeys = mergeSortedUnique([
    ...chunkDirNames
      .map((chunkDirName) => chunkKeyFromDateAndChunkDir(normalizedDate, chunkDirName))
      .filter((chunkKey): chunkKey is string => Boolean(chunkKey)),
    ...parseIndexEntries(normalizedDate, indexText).map((entry) => entry.chunkKey),
  ]);

  const summary = await readDaySummary(normalizedDate, contextRoot);
  return {
    ...summary,
    chunkKeys,
    indexText,
  };
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
  const dayDir = dayPathFromDate(date, contextRoot);

  const [indexText, metaText] = await Promise.all([
    readTextFileSafe(path.join(dayDir, INDEX_FILE_NAME)),
    readTextFileSafe(path.join(chunkDir, META_FILE_NAME)),
  ]);

  const summaryByChunkKey = buildSummaryTextByChunkKey(date, indexText);
  const summaryText =
    summaryByChunkKey.get(normalizedChunkKey) || "(missing matching summary section in index.txt)";

  let meta: Record<string, unknown> | null = null;
  if (metaText.trim()) {
    meta = JSON.parse(metaText) as Record<string, unknown>;
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
  };
}
