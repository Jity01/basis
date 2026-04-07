import { app } from "electron";
import * as path from "path";
import { spawnSync } from "child_process";
import { enabledExclusionBundleIds, loadExclusions, type ExclusionsConfig } from "@context-manager/core";

type SckitInitResult = {
  ok: boolean;
  excludedApplicationCount?: number;
};

let initializedBundleIds: string[] = [];
let isInitialized = false;
let lastInitError: string | null = null;

function helperBinaryPath(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "sckit-bin", "sckit-exclusions-init");
  }
  return path.join(__dirname, "..", "resources", "sckit-bin", "sckit-exclusions-init");
}

export function initializeSckitExclusions(config?: ExclusionsConfig): void {
  isInitialized = false;
  lastInitError = null;
  const nextConfig = config || loadExclusions();
  const bundleIds = enabledExclusionBundleIds(nextConfig);
  initializedBundleIds = bundleIds;

  if (process.platform !== "darwin") {
    isInitialized = true;
    return;
  }

  const helperPath = helperBinaryPath();
  const result = spawnSync(helperPath, [JSON.stringify(bundleIds)], {
    encoding: "utf8",
    timeout: 15000,
  });

  if (result.error) {
    lastInitError = result.error.message;
    throw result.error;
  }
  if (result.status !== 0) {
    const details = result.stderr?.trim() || result.stdout?.trim() || "unknown error";
    lastInitError = details;
    throw new Error(`SCKit exclusions init failed (${result.status}): ${details}`);
  }

  if (result.stdout?.trim()) {
    try {
      const parsed = JSON.parse(result.stdout.trim()) as SckitInitResult;
      if (!parsed.ok) {
        throw new Error("SCKit helper reported failure.");
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      lastInitError = msg;
      throw new Error(`SCKit exclusions helper output invalid JSON: ${msg}`);
    }
  }

  isInitialized = true;
  lastInitError = null;
}

export function getInitializedExclusionBundleIds(): string[] {
  return [...initializedBundleIds];
}

export function getSckitExclusionsInitState(): {
  initialized: boolean;
  bundleIds: string[];
  error: string | null;
} {
  return {
    initialized: isInitialized,
    bundleIds: getInitializedExclusionBundleIds(),
    error: lastInitError,
  };
}
