import * as fs from "fs/promises";
import * as path from "path";
import {
  CONTEXT_ROOT,
  OCR_DIR_NAME,
  TEMPORAL_DESCRIPTION_FILE_NAME,
  TEMPORAL_INDEX_FILE_NAME,
} from "@context-manager/config";
import type { CatalogEntry, DayCatalog, ChunkMetadata } from "@context-manager/config";

const META_FILE_NAME = "meta.json";

/** Legacy per-chunk summary filename (older chunks only). */
export const SUMMARY_FILE_NAME = "summary.txt";
export { OCR_DIR_NAME, TEMPORAL_DESCRIPTION_FILE_NAME, TEMPORAL_INDEX_FILE_NAME };

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function chunkDirFromTimestamp(timestamp: Date, contextRoot: string = CONTEXT_ROOT): string {
  const yyyy = String(timestamp.getFullYear());
  const mm = pad2(timestamp.getMonth() + 1);
  const dd = pad2(timestamp.getDate());
  const hh = pad2(timestamp.getHours());
  const min = pad2(timestamp.getMinutes());
  return path.join(contextRoot, yyyy, mm, dd, `${hh}-${min}`);
}

function formatDate(timestamp: Date): string {
  const yyyy = String(timestamp.getFullYear());
  const mm = pad2(timestamp.getMonth() + 1);
  const dd = pad2(timestamp.getDate());
  return `${yyyy}-${mm}-${dd}`;
}

function chunkSlugFromTimestamp(timestamp: Date): string {
  return `${pad2(timestamp.getHours())}-${pad2(timestamp.getMinutes())}`;
}

/**
 * Write one segment-wiki chunk: `temporal_description.txt`, `ocr/*.txt`, `temporal_index.json`, `meta.json`.
 */
export async function storeSegmentWikiChunk(
  timestamp: Date,
  temporalDescription: string,
  meta: Record<string, unknown>,
  ocrTexts: string[],
  keySourceIndices1Based: number[],
  inputFrameCount: number,
  contextRoot: string = CONTEXT_ROOT
): Promise<string> {
  const chunkDir = chunkDirFromTimestamp(timestamp, contextRoot);
  const ocrDir = path.join(chunkDir, OCR_DIR_NAME);
  const chunkSlug = chunkSlugFromTimestamp(timestamp);

  await fs.mkdir(ocrDir, { recursive: true });

  await fs.writeFile(
    path.join(chunkDir, TEMPORAL_DESCRIPTION_FILE_NAME),
    `${temporalDescription.trim()}\n`,
    "utf8"
  );

  for (let i = 0; i < ocrTexts.length; i++) {
    const fname = `${String(i + 1).padStart(3, "0")}.txt`;
    await fs.writeFile(path.join(ocrDir, fname), `${(ocrTexts[i] ?? "").trim()}\n`, "utf8");
  }

  const temporalIndexDoc = {
    schema_version: 1,
    date: formatDate(timestamp),
    chunk_dir: chunkSlug,
    input_frame_count: inputFrameCount,
    key_frame_source_indices_1based: keySourceIndices1Based,
    temporal_description_path: path.join(chunkDir, TEMPORAL_DESCRIPTION_FILE_NAME),
    mappings: ocrTexts.map((_, wi) => ({
      wiki_frame_index_1based: wi + 1,
      source_input_frame_index_1based: keySourceIndices1Based[wi] ?? wi + 1,
      text_file: `${String(wi + 1).padStart(3, "0")}.txt`,
    })),
    note:
      "OCR text files correspond to key frames; source_input_frame_index_1based refers to narrator input frames.",
  };

  await fs.writeFile(
    path.join(chunkDir, TEMPORAL_INDEX_FILE_NAME),
    `${JSON.stringify(temporalIndexDoc, null, 2)}\n`,
    "utf8"
  );

  await fs.writeFile(
    path.join(chunkDir, META_FILE_NAME),
    `${JSON.stringify(meta, null, 2)}\n`,
    "utf8"
  );

  return chunkDir;
}

const CATALOG_FILE_NAME = "catalog.json";
export { CATALOG_FILE_NAME };

function dayDirFromTimestamp(timestamp: Date, contextRoot: string): string {
  const yyyy = String(timestamp.getFullYear());
  const mm = pad2(timestamp.getMonth() + 1);
  const dd = pad2(timestamp.getDate());
  return path.join(contextRoot, yyyy, mm, dd);
}

function formatTime(timestamp: Date): string {
  return `${pad2(timestamp.getHours())}:${pad2(timestamp.getMinutes())}`;
}

function formatChunkKey(timestamp: Date): string {
  return `${formatDate(timestamp)}/${pad2(timestamp.getHours())}-${pad2(timestamp.getMinutes())}`;
}

/** Append a chunk entry to the day's catalog.json. Creates the file if it doesn't exist. */
export async function appendToCatalog(
  timestamp: Date,
  summary: string,
  meta: ChunkMetadata,
  contextRoot: string = CONTEXT_ROOT
): Promise<void> {
  const dayDir = dayDirFromTimestamp(timestamp, contextRoot);
  const catalogPath = path.join(dayDir, CATALOG_FILE_NAME);

  let catalog: DayCatalog;
  try {
    const raw = await fs.readFile(catalogPath, "utf8");
    catalog = JSON.parse(raw) as DayCatalog;
    if (!Array.isArray(catalog.chunks)) {
      catalog.chunks = [];
    }
  } catch {
    catalog = { date: formatDate(timestamp), chunks: [] };
  }

  const chunkKey = formatChunkKey(timestamp);
  const time = formatTime(timestamp);

  catalog.chunks = catalog.chunks.filter((c) => c.chunk_key !== chunkKey);

  const entry: CatalogEntry = {
    time,
    chunk_key: chunkKey,
    primary_intent: meta.primary_intent,
    activities: meta.activities.map((a) => `${a.type}:${a.topics.join(":")}`),
    apps: meta.apps.map((a) => a.name),
    topics: Array.from(new Set(meta.activities.flatMap((a) => a.topics))),
    entities: meta.entities,
    context_switches: meta.context_switches,
    summary_preview: summary.length > 200 ? `${summary.slice(0, 200)}...` : summary,
  };

  catalog.chunks.push(entry);
  catalog.chunks.sort((a, b) => a.time.localeCompare(b.time));

  await fs.mkdir(dayDir, { recursive: true });
  await fs.writeFile(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`, "utf8");
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
    throw new Error(`Refusing to move file outside ${tmpDir}: ${resolvedVideoPath}`);
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

/** Delete a raw recording file that lives under `~/context/.tmp/`. */
export async function deleteRawVideo(videoPath: string): Promise<void> {
  const tmpDir = path.resolve(path.join(CONTEXT_ROOT, ".tmp"));
  const resolvedVideoPath = path.resolve(videoPath);
  const resolvedMetaPath = path.resolve(`${videoPath}.meta.json`);

  if (
    resolvedVideoPath !== tmpDir &&
    !resolvedVideoPath.startsWith(`${tmpDir}${path.sep}`)
  ) {
    throw new Error(`Refusing to delete file outside ${tmpDir}: ${resolvedVideoPath}`);
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
