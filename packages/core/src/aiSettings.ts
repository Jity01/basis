import * as fs from "fs";
import * as path from "path";
import { BASIS_ROOT } from "@context-manager/config";
import type { AISettings } from "@context-manager/config";

export type { AISettings } from "@context-manager/config";

const AI_SETTINGS_FILE_NAME = "ai-settings.json";

export const DEFAULT_AI_SETTINGS: AISettings = {};

export function getAISettingsPath(): string {
  return path.join(BASIS_ROOT, AI_SETTINGS_FILE_NAME);
}

function normalizeFireworksApiKey(value: unknown): string | undefined {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed || undefined;
}

function normalizeAISettings(value: unknown): AISettings {
  const raw = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  return {
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
