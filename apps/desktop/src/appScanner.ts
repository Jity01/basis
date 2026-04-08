import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFileSync } from "child_process";
import { BASIS_ROOT } from "@context-manager/config";
import type { InstalledApp } from "@context-manager/config";

export type { InstalledApp } from "@context-manager/config";

let cachedApps: InstalledApp[] | null = null;

function plistValue(plistPath: string, key: string): string | null {
  try {
    const out = execFileSync("/usr/libexec/PlistBuddy", ["-c", `Print :${key}`, plistPath], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}

function resolveIconPng(appPath: string): string | null {
  const plistPath = path.join(appPath, "Contents", "Info.plist");
  const iconNameRaw = plistValue(plistPath, "CFBundleIconFile");
  if (!iconNameRaw) {
    return null;
  }
  const iconName = iconNameRaw.endsWith(".icns") ? iconNameRaw : `${iconNameRaw}.icns`;
  const icnsPath = path.join(appPath, "Contents", "Resources", iconName);
  if (!fs.existsSync(icnsPath)) {
    return null;
  }

  const cacheDir = path.join(BASIS_ROOT, "cache", "app-icons");
  fs.mkdirSync(cacheDir, { recursive: true });
  const outPath = path.join(cacheDir, `${path.basename(appPath, ".app")}.png`);
  try {
    execFileSync("sips", ["-s", "format", "png", icnsPath, "--out", outPath], {
      stdio: ["ignore", "ignore", "ignore"],
    });
    return fs.existsSync(outPath) ? outPath : null;
  } catch {
    return null;
  }
}

function inspectApp(appPath: string): InstalledApp | null {
  const plistPath = path.join(appPath, "Contents", "Info.plist");
  if (!fs.existsSync(plistPath)) {
    return null;
  }

  const bundleId = plistValue(plistPath, "CFBundleIdentifier");
  if (!bundleId) {
    return null;
  }
  const name =
    plistValue(plistPath, "CFBundleDisplayName") ||
    plistValue(plistPath, "CFBundleName") ||
    path.basename(appPath, ".app");

  return {
    bundleId,
    name,
    iconPath: resolveIconPng(appPath),
  };
}

function scanRoot(rootPath: string): InstalledApp[] {
  if (!fs.existsSync(rootPath)) {
    return [];
  }
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(rootPath);
  } catch {
    return [];
  }
  const apps: InstalledApp[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".app")) {
      continue;
    }
    const appPath = path.join(rootPath, entry);
    const inspected = inspectApp(appPath);
    if (inspected) {
      apps.push(inspected);
    }
  }
  return apps;
}

function dedupeApps(apps: InstalledApp[]): InstalledApp[] {
  const byBundle = new Map<string, InstalledApp>();
  for (const appEntry of apps) {
    const existing = byBundle.get(appEntry.bundleId);
    if (!existing) {
      byBundle.set(appEntry.bundleId, appEntry);
      continue;
    }
    byBundle.set(appEntry.bundleId, {
      bundleId: appEntry.bundleId,
      name: existing.name.length >= appEntry.name.length ? existing.name : appEntry.name,
      iconPath: existing.iconPath || appEntry.iconPath,
    });
  }
  return Array.from(byBundle.values()).sort((a, b) => a.name.localeCompare(b.name));
}

export function scanInstalledApps(forceRefresh = false): InstalledApp[] {
  if (cachedApps && !forceRefresh) {
    return cachedApps;
  }
  const apps = dedupeApps([
    ...scanRoot("/Applications"),
    ...scanRoot(path.join(os.homedir(), "Applications")),
  ]);
  cachedApps = apps;
  return apps;
}

export function inspectAppBundlePath(appBundlePath: string): InstalledApp | null {
  const normalizedPath = appBundlePath.trim();
  if (!normalizedPath.endsWith(".app")) {
    return null;
  }
  return inspectApp(normalizedPath);
}
