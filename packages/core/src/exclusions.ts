import * as fs from "fs";
import * as path from "path";
import { BASIS_ROOT } from "@context-manager/config";
import type { ExclusionEntry, ExclusionsConfig } from "@context-manager/config";

export type { ExclusionEntry, ExclusionsConfig } from "@context-manager/config";

type ExclusionSeed = {
  bundle_id: string;
  name: string;
};

const EXCLUSIONS_FILE_NAME = "exclusions.json";

const DEFAULT_EXCLUSIONS: ExclusionSeed[] = [
  { bundle_id: "com.1password.1password", name: "1Password" },
  { bundle_id: "com.agilebits.onepassword7", name: "1Password 7" },
  { bundle_id: "com.apple.keychainaccess", name: "Keychain Access" },
  { bundle_id: "com.apple.systempreferences", name: "System Settings" },
  { bundle_id: "com.bitwarden.desktop", name: "Bitwarden" },
  { bundle_id: "com.dashlane.dashlane", name: "Dashlane" },
];

function normalizeEntry(raw: unknown): ExclusionEntry | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const candidate = raw as Partial<ExclusionEntry>;
  const bundleId = typeof candidate.bundle_id === "string" ? candidate.bundle_id.trim() : "";
  if (!bundleId) {
    return null;
  }
  const name = typeof candidate.name === "string" && candidate.name.trim() ? candidate.name.trim() : bundleId;
  return {
    bundle_id: bundleId,
    name,
    is_default: candidate.is_default === true,
    enabled: candidate.enabled !== false,
  };
}

function defaultEntries(): ExclusionEntry[] {
  return DEFAULT_EXCLUSIONS.map((entry) => ({
    bundle_id: entry.bundle_id,
    name: entry.name,
    is_default: true,
    enabled: true,
  }));
}

function dedupeEntries(entries: ExclusionEntry[]): ExclusionEntry[] {
  const byBundleId = new Map<string, ExclusionEntry>();
  for (const entry of entries) {
    const existing = byBundleId.get(entry.bundle_id);
    if (!existing) {
      byBundleId.set(entry.bundle_id, entry);
      continue;
    }
    byBundleId.set(entry.bundle_id, {
      ...existing,
      ...entry,
      is_default: existing.is_default || entry.is_default,
    });
  }
  return Array.from(byBundleId.values()).sort((a, b) => a.name.localeCompare(b.name));
}

function normalizeConfig(raw: unknown): ExclusionsConfig {
  const fallback = {
    requires_restart: false,
    bundle_ids: defaultEntries(),
  };
  if (!raw || typeof raw !== "object") {
    return fallback;
  }
  const candidate = raw as Partial<ExclusionsConfig>;
  const bundleIds = Array.isArray(candidate.bundle_ids)
    ? candidate.bundle_ids.map(normalizeEntry).filter((entry): entry is ExclusionEntry => Boolean(entry))
    : [];
  return {
    requires_restart: candidate.requires_restart === true,
    bundle_ids: dedupeEntries(bundleIds.length > 0 ? bundleIds : fallback.bundle_ids),
  };
}

export function mergeWithDefaults(config: ExclusionsConfig): ExclusionsConfig {
  const currentById = new Map<string, ExclusionEntry>();
  for (const entry of config.bundle_ids) {
    currentById.set(entry.bundle_id, entry);
  }

  const merged: ExclusionEntry[] = [];
  for (const def of DEFAULT_EXCLUSIONS) {
    const existing = currentById.get(def.bundle_id);
    if (existing) {
      merged.push({
        bundle_id: def.bundle_id,
        name: existing.name || def.name,
        is_default: true,
        enabled: existing.enabled !== false,
      });
      currentById.delete(def.bundle_id);
    } else {
      merged.push({
        bundle_id: def.bundle_id,
        name: def.name,
        is_default: true,
        enabled: true,
      });
    }
  }

  for (const entry of Array.from(currentById.values())) {
    merged.push({
      bundle_id: entry.bundle_id,
      name: entry.name,
      is_default: false,
      enabled: entry.enabled !== false,
    });
  }

  return {
    requires_restart: config.requires_restart === true,
    bundle_ids: dedupeEntries(merged),
  };
}

export function getExclusionsPath(): string {
  return path.join(BASIS_ROOT, EXCLUSIONS_FILE_NAME);
}

function writeConfig(config: ExclusionsConfig): ExclusionsConfig {
  const filePath = getExclusionsPath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return config;
}

export function loadExclusions(): ExclusionsConfig {
  const filePath = getExclusionsPath();
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const normalized = mergeWithDefaults(normalizeConfig(JSON.parse(raw)));
    writeConfig(normalized);
    return normalized;
  } catch {
    const initial = mergeWithDefaults(
      normalizeConfig({
        requires_restart: false,
        bundle_ids: defaultEntries(),
      })
    );
    return writeConfig(initial);
  }
}

export function updateExclusions(next: Partial<ExclusionsConfig>): ExclusionsConfig {
  const current = loadExclusions();
  const nextEntries =
    Array.isArray(next.bundle_ids) && next.bundle_ids.length > 0
      ? next.bundle_ids.map(normalizeEntry).filter((entry): entry is ExclusionEntry => Boolean(entry))
      : current.bundle_ids;
  const merged = mergeWithDefaults({
    requires_restart: true,
    bundle_ids: dedupeEntries(nextEntries),
  });
  return writeConfig(merged);
}

export function clearExclusionsRequiresRestart(): ExclusionsConfig {
  const current = loadExclusions();
  if (!current.requires_restart) {
    return current;
  }
  return writeConfig({ ...current, requires_restart: false });
}

export function enabledExclusionBundleIds(config: ExclusionsConfig): string[] {
  return config.bundle_ids.filter((entry) => entry.enabled).map((entry) => entry.bundle_id);
}
