import * as dotenv from "dotenv";
import * as fs from "fs/promises";
import * as path from "path";

dotenv.config({ path: path.join(__dirname, "../../../.env") });

const DEFAULT_FIREWORKS_BASE_URL = "https://api.fireworks.ai/inference/v1";
const DEFAULT_FIREWORKS_MODEL = "accounts/fireworks/models/gpt-oss-120b";
const DEFAULT_BATCH_SIZE = 5;
const MAX_INDEX_FILES_TO_PROCESS = 25;
const TOP_RESULTS_LIMIT = 10;
const SUMMARY_FILE_NAME = "summary.txt";
const INDEX_FILE_NAME = "index.txt";
const FRAMES_DIR_NAME = "frames";

type SummaryEntry = {
  summaryPath: string;
};

type DayEntry = {
  indexPath: string;
  dayLabel: string;
  indexText: string;
  summaries: SummaryEntry[];
};

function getFireworksApiKey(): string {
  const key = process.env.FIREWORKS_API_KEY?.trim();
  if (!key) {
    throw new Error("Missing FIREWORKS_API_KEY.");
  }
  return key;
}

function getFireworksBaseUrl(): string {
  return process.env.FIREWORKS_BASE_URL?.trim() || DEFAULT_FIREWORKS_BASE_URL;
}

function getFireworksModel(): string {
  return process.env.FIREWORKS_MODEL?.trim() || DEFAULT_FIREWORKS_MODEL;
}

async function callFireworks(prompt: string): Promise<string> {
  const response = await fetch(`${getFireworksBaseUrl().replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${getFireworksApiKey()}`,
    },
    body: JSON.stringify({
      model: getFireworksModel(),
      temperature: 0.0,
      max_tokens: 1000,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Fireworks request failed (${response.status}): ${body}`);
  }

  const json = (await response.json()) as {
    choices?: Array<{ message?: { content?: string | null } }>;
  };
  const text = json.choices?.[0]?.message?.content?.trim();
  if (!text) {
    throw new Error("Fireworks returned empty content.");
  }
  return text;
}

async function discoverIndexFiles(contextRoot: string): Promise<string[]> {
  const out: string[] = [];

  async function walk(dir: string): Promise<void> {
    let entries: import("fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
        return;
      }
      throw err;
    }

    await Promise.all(
      entries.map(async (entry) => {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(fullPath);
          return;
        }
        if (entry.isFile() && entry.name === "index.txt") {
          out.push(fullPath);
        }
      })
    );
  }

  await walk(contextRoot);
  return out.sort((a, b) => b.localeCompare(a));
}

function buildBatches<T>(items: T[], batchSize: number): T[][] {
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += Math.max(1, batchSize)) {
    batches.push(items.slice(i, i + batchSize));
  }
  return batches;
}

function dayLabelFromIndexPath(indexPath: string): string {
  const dayDir = path.dirname(indexPath);
  const parts = dayDir.split(path.sep);
  const dd = parts[parts.length - 1] || "";
  const mm = parts[parts.length - 2] || "";
  const yyyy = parts[parts.length - 3] || "";
  if (/^\d{4}$/.test(yyyy) && /^\d{2}$/.test(mm) && /^\d{2}$/.test(dd)) {
    return `${yyyy}-${mm}-${dd}`;
  }
  return dayDir;
}

function parseSummariesFromIndex(indexPath: string, indexText: string): SummaryEntry[] {
  const dayDir = path.dirname(indexPath);
  const out: SummaryEntry[] = [];
  const pattern = /\[(\d{2}):(\d{2})\]\n([\s\S]*?)(?=\n\n\[\d{2}:\d{2}\]\n|$)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(indexText)) != null) {
    const hh = match[1];
    const mm = match[2];
    const summaryText = (match[3] || "").trim();
    if (!summaryText) {
      continue;
    }
    out.push({
      summaryPath: path.join(dayDir, `${hh}-${mm}`, SUMMARY_FILE_NAME),
    });
  }
  return out;
}

function addSummaryPathsToIndexText(indexPath: string, indexText: string): string {
  const dayDir = path.dirname(indexPath);
  return indexText.replace(/\[(\d{2}):(\d{2})\]\n/g, (_full, hh: string, mm: string) => {
    const summaryPath = path.join(dayDir, `${hh}-${mm}`, SUMMARY_FILE_NAME);
    return `SUMMARY_PATH: ${summaryPath}\n[${hh}:${mm}]\n`;
  });
}

function buildBatchPrompt(query: string, batch: DayEntry[]): string {
  const blocks = batch.map((day) => {
    return [
      `### DAY: ${day.dayLabel}`,
      `INDEX_PATH: ${day.indexPath}`,
      "INDEX_CONTENT:",
      day.indexText,
    ].join("\n");
  });

  return `You are a relevance filter for local context search.

Task:
Given a user query and day-level context, return relevant SUMMARY_PATH values.

Rules:
- Read and consider every day.
- Return ONLY SUMMARY_PATH values, one per line.
- Return at most 10 paths.
- Do not include any explanation or markdown.
- Do not invent paths; only return paths listed in SUMMARY_PATH fields.

Query:
${query}

Days:
${blocks.join("\n\n")}
`;
}

function parsePaths(raw: string, validPaths: Set<string>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const line of raw.split(/\r?\n/)) {
    const candidate = line
      .trim()
      .replace(/^[-*]\s+/, "")
      .replace(/^`|`$/g, "")
      .replace(/^["']|["']$/g, "");
    if (!candidate) {
      continue;
    }
    if (validPaths.has(candidate) && !seen.has(candidate)) {
      out.push(candidate);
      seen.add(candidate);
    }
  }
  return out;
}

async function runBatchSearch(query: string, batch: DayEntry[]): Promise<string[]> {
  const prompt = buildBatchPrompt(query, batch);
  const raw = await callFireworks(prompt);
  const validPaths = new Set(batch.flatMap((day) => day.summaries.map((s) => s.summaryPath)));
  return parsePaths(raw, validPaths);
}

/**
 * Reads newest index files in 5-file batches and returns relevant summary.txt paths.
 */
export async function findRelevantPaths(
  query: string,
  contextRoot: string
): Promise<string[]> {
  const indexPaths = await discoverIndexFiles(contextRoot);
  if (indexPaths.length === 0) {
    return [];
  }

  const targetIndexCount = Math.min(indexPaths.length, MAX_INDEX_FILES_TO_PROCESS);
  const selectedIndexPaths = indexPaths.slice(0, targetIndexCount);

  const loadedDays = await Promise.all(
    selectedIndexPaths.map(async (indexPath) => {
      const rawIndexText = await fs.readFile(indexPath, "utf8");
      const summaries = parseSummariesFromIndex(indexPath, rawIndexText);
      return {
        indexPath,
        dayLabel: dayLabelFromIndexPath(indexPath),
        indexText: addSummaryPathsToIndexText(indexPath, rawIndexText),
        summaries,
      } satisfies DayEntry;
    })
  );
  const nonEmptyDays = loadedDays.filter((day) => day.summaries.length > 0);
  if (nonEmptyDays.length === 0) {
    return [];
  }

  const dayBatches = buildBatches(nonEmptyDays, DEFAULT_BATCH_SIZE);
  const batchJobs = dayBatches.map((batch) => runBatchSearch(query, batch));

  if (batchJobs.length === 0) {
    return [];
  }

  const settled = await Promise.allSettled(batchJobs);
  const scores = new Map<string, number>();
  let failedBatches = 0;
  const failureReasons: string[] = [];

  for (let i = 0; i < settled.length; i += 1) {
    const result = settled[i];
    if (result.status !== "fulfilled") {
      failedBatches += 1;
      const reasonText =
        result.reason instanceof Error ? result.reason.message : String(result.reason);
      if (reasonText) {
        failureReasons.push(reasonText);
      }
      continue;
    }
    for (const selectedPath of result.value) {
      scores.set(selectedPath, (scores.get(selectedPath) || 0) + 1);
    }
  }

  if (failedBatches > 0) {
    console.warn(`[searcher] ${failedBatches}/${settled.length} Fireworks batch calls failed.`);
  }

  return Array.from(scores.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, TOP_RESULTS_LIMIT)
    .map(([summaryPath]) => summaryPath);
}

function formatTimestampFromChunkPath(chunkPath: string): string {
  const parts = chunkPath.split(path.sep);
  const hhmm = parts[parts.length - 1] || "";
  const dd = parts[parts.length - 2] || "";
  const mm = parts[parts.length - 3] || "";
  const yyyy = parts[parts.length - 4] || "";
  const hhmmParts = hhmm.split("-");
  const hour = hhmmParts[0] || "00";
  const minute = hhmmParts[1] || "00";
  if (!/^\d{4}$/.test(yyyy) || !/^\d{2}$/.test(mm) || !/^\d{2}$/.test(dd)) {
    return chunkPath;
  }
  return `${yyyy}-${mm}-${dd} ${hour}:${minute}`;
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

/**
 * For each selected day, include full index text.
 * For each selected summary path, include frame images as base64 data URLs.
 */
export async function loadResults(paths: string[]): Promise<string> {
  if (paths.length === 0) {
    return "";
  }

  const dedupedSummaryPaths: string[] = [];
  const seenSummaryPaths = new Set<string>();
  for (const p of paths) {
    if (!seenSummaryPaths.has(p)) {
      seenSummaryPaths.add(p);
      dedupedSummaryPaths.push(p);
    }
  }

  const summariesByDay = new Map<string, string[]>();
  for (const summaryPath of dedupedSummaryPaths) {
    const dayDir = path.dirname(path.dirname(summaryPath));
    const existing = summariesByDay.get(dayDir) || [];
    existing.push(summaryPath);
    summariesByDay.set(dayDir, existing);
  }

  const sections: string[] = [];
  for (const [dayDir, summaryPaths] of Array.from(summariesByDay.entries())) {
    const indexPath = path.join(dayDir, INDEX_FILE_NAME);
    let indexText = "";
    try {
      indexText = (await fs.readFile(indexPath, "utf8")).trim();
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
        indexText = "(missing index.txt)";
      } else {
        throw err;
      }
    }

    sections.push([`[DAY INDEX] ${dayLabelFromIndexPath(indexPath)} (${indexPath})`, indexText].join("\n"));

    for (const summaryPath of summaryPaths) {
      const chunkPath = path.dirname(summaryPath);
      let frameLines: string[] = [];
      try {
        const framesDir = path.join(chunkPath, FRAMES_DIR_NAME);
        const entries = await fs.readdir(framesDir, { withFileTypes: true });
        const framePaths = entries
          .filter((entry) => entry.isFile())
          .map((entry) => path.join(framesDir, entry.name))
          .sort((a, b) => a.localeCompare(b));

        frameLines = await Promise.all(
          framePaths.map(async (framePath) => {
            const mimeType = mimeTypeForFile(framePath);
            const bytes = await fs.readFile(framePath);
            const base64 = bytes.toString("base64");
            return `- ${path.basename(framePath)} | data:${mimeType};base64,${base64}`;
          })
        );
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
          throw err;
        }
      }

      const timestamp = formatTimestampFromChunkPath(chunkPath);
      const framesBlock =
        frameLines.length > 0 ? frameLines.map((f) => `- ${f}`).join("\n") : "- (none)";
      sections.push(
        [
          `[SUMMARY] ${timestamp} (${summaryPath})`,
          "FramesBase64:",
          framesBlock,
        ].join("\n")
      );
    }
  }

  return sections.join("\n\n");
}
