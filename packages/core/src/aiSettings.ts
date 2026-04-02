import * as fs from "fs";
import * as path from "path";
import { CONTEXT_ROOT } from "@context-manager/config";

export type AIProvider = "fireworks" | "local";

export type AISettings = {
  provider: AIProvider;
  localBaseUrl: string;
  localTaggingModel: string;
  /** Used when `FIREWORKS_API_KEY` is not set in the environment. */
  fireworksApiKey?: string;
};

const AI_SETTINGS_FILE_NAME = "ai-settings.json";
const DEFAULT_LOCAL_BASE_URL = "http://127.0.0.1:11434/v1";

export const DEFAULT_AI_SETTINGS: AISettings = {
  provider: "fireworks",
  localBaseUrl: DEFAULT_LOCAL_BASE_URL,
  localTaggingModel: "llava:7b",
};

export function getAISettingsPath(): string {
  return path.join(CONTEXT_ROOT, AI_SETTINGS_FILE_NAME);
}

function normalizeProvider(value: unknown): AIProvider {
  return value === "local" ? "local" : "fireworks";
}

function normalizeLocalBaseUrl(value: unknown): string {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed) {
    return DEFAULT_LOCAL_BASE_URL;
  }
  const withoutTrailingSlash = trimmed.replace(/\/+$/, "");
  return /\/v1$/i.test(withoutTrailingSlash) ? withoutTrailingSlash : `${withoutTrailingSlash}/v1`;
}

function normalizeModel(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function normalizeFireworksApiKey(value: unknown): string | undefined {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed || undefined;
}

function normalizeAISettings(value: unknown): AISettings {
  const raw = (value && typeof value === "object" ? value : {}) as Partial<AISettings>;
  return {
    provider: normalizeProvider(raw.provider),
    localBaseUrl: normalizeLocalBaseUrl(raw.localBaseUrl),
    localTaggingModel: normalizeModel(raw.localTaggingModel, DEFAULT_AI_SETTINGS.localTaggingModel),
    fireworksApiKey: normalizeFireworksApiKey(raw.fireworksApiKey),
  };
}

export function readAISettings(): AISettings {
  try {
    const raw = fs.readFileSync(getAISettingsPath(), "utf8");
    return normalizeAISettings(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_AI_SETTINGS };
  }
}

export function writeAISettings(next: Partial<AISettings>): AISettings {
  const merged = normalizeAISettings({
    ...readAISettings(),
    ...next,
  });
  const settingsPath = getAISettingsPath();
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
  return merged;
}
