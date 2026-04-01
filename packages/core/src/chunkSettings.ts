import * as fs from "fs";
import * as path from "path";
import { CHUNK_DURATION_MS, CONTEXT_ROOT } from "@context-manager/config";

const CHUNK_SETTINGS_FILE_NAME = "chunk-settings.json";
const MIN_CHUNK_DURATION_MINUTES = 1;
const DEFAULT_CHUNK_DURATION_MINUTES = Math.round(CHUNK_DURATION_MS / 60_000);

export type ChunkSettings = {
  chunkDurationMinutes: number;
};

function normalizeChunkDurationMinutes(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_CHUNK_DURATION_MINUTES;
  }
  return Math.max(MIN_CHUNK_DURATION_MINUTES, Math.round(value));
}

function normalizeChunkSettings(value: unknown): ChunkSettings {
  const raw = (value && typeof value === "object" ? value : {}) as Partial<ChunkSettings>;
  return {
    chunkDurationMinutes: normalizeChunkDurationMinutes(raw.chunkDurationMinutes),
  };
}

export function getChunkSettingsPath(): string {
  return path.join(CONTEXT_ROOT, CHUNK_SETTINGS_FILE_NAME);
}

export function readChunkSettings(): ChunkSettings {
  try {
    const raw = fs.readFileSync(getChunkSettingsPath(), "utf8");
    return normalizeChunkSettings(JSON.parse(raw));
  } catch {
    return { chunkDurationMinutes: DEFAULT_CHUNK_DURATION_MINUTES };
  }
}

export function writeChunkSettings(next: Partial<ChunkSettings>): ChunkSettings {
  const merged = normalizeChunkSettings({
    ...readChunkSettings(),
    ...next,
  });
  const settingsPath = getChunkSettingsPath();
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
  return merged;
}

export function getChunkDurationMs(): number {
  return readChunkSettings().chunkDurationMinutes * 60_000;
}
