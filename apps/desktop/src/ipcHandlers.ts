import { app, ipcMain, desktopCapturer } from "electron";
import * as path from "path";
import type { BrowserWindow } from "electron";
import {
  getUnprocessedFiles,
  getCurrentFile,
  getChunkDurationMs,
  readAISettings,
  writeAISettings,
  readChunkSettings,
  writeChunkSettings,
  startHotBuffer,
  stopHotBuffer,
  loadExclusions,
  updateExclusions,
} from "@context-manager/core";
import type {
  AISettings,
  ChunkSettings,
  ContextScope,
  ExclusionsConfig,
} from "@context-manager/config";
import { CONTEXT_ROOT, HOT_BUFFER_CONFIG, hotBufferDir } from "@context-manager/config";
import { inspectAppBundlePath, scanInstalledApps } from "./appScanner";
import { getInitializedExclusionBundleIds, getSckitExclusionsInitState } from "./sckitExclusions";
import { setMainWindow as setMainWindowRef } from "./mainWindowRef";
import {
  openNewFile,
  closeCurrentFile,
  enqueueChunkWrite,
  coerceChunkToBuffer,
  resolveOcrBinaryPath,
  setActiveRecordingChunkDurationMs,
  getActiveRecordingChunkDurationMs,
} from "./recording";
import {
  processingState,
  countPendingChunks,
  countVisiblePendingChunks,
  getActiveRecordingChunk,
  emitProcessingStatus,
  runBacklog,
  maybeStartLiveProcessing,
  setupIdleProcessing,
} from "./processing";
import { getLocalGrant, setLocalScopes, revokeLocalGrant } from "./grants";

export function setMainWindow(win: BrowserWindow): void {
  setMainWindowRef(win);
}

export function setupIpc(): void {
  app.once("before-quit", () => {
    stopHotBuffer();
  });

  setupIdleProcessing();

  // ── Recording ────────────────────────────────────────────────────────────

  ipcMain.handle("start-recording", async () => {
    const chunkDurationMs = getChunkDurationMs();
    setActiveRecordingChunkDurationMs(chunkDurationMs);
    const filePath = await openNewFile(chunkDurationMs);
    startHotBuffer({
      captureIntervalMs: HOT_BUFFER_CONFIG.captureIntervalMs,
      maxAgeMs: HOT_BUFFER_CONFIG.maxAgeMs,
      purgeIntervalMs: HOT_BUFFER_CONFIG.purgeIntervalMs,
      resolution: { ...HOT_BUFFER_CONFIG.resolution },
      jpegQuality: HOT_BUFFER_CONFIG.jpegQuality,
      hotbufferDir: hotBufferDir(CONTEXT_ROOT),
      ocrBinaryPath: resolveOcrBinaryPath(),
      excludedBundleIds: getInitializedExclusionBundleIds(),
    });
    return { success: true, filePath };
  });

  ipcMain.handle("recording-chunk", async (_event, chunkPayload: unknown) => {
    const chunk = coerceChunkToBuffer(chunkPayload);
    if (!chunk) {
      throw new Error("Invalid recording chunk payload");
    }
    await enqueueChunkWrite(chunk);
  });

  ipcMain.handle("rotate-recording", async () => {
    const filePath = await openNewFile(getActiveRecordingChunkDurationMs() ?? getChunkDurationMs());
    maybeStartLiveProcessing();
    emitProcessingStatus();
    return { filePath };
  });

  ipcMain.handle("stop-recording", async () => {
    setActiveRecordingChunkDurationMs(null);
    stopHotBuffer();
    await closeCurrentFile();
    maybeStartLiveProcessing();
    return { success: true };
  });

  // ── Recording state queries ──────────────────────────────────────────────

  ipcMain.handle("get-current-file", () => {
    return getCurrentFile();
  });

  ipcMain.handle("get-unprocessed-files", () => {
    return getUnprocessedFiles();
  });

  ipcMain.handle("get-processing-status", () => {
    processingState.pendingChunks = countPendingChunks();
    processingState.visiblePendingChunks = countVisiblePendingChunks();
    processingState.activeRecordingChunk = getActiveRecordingChunk();
    return { ...processingState };
  });

  // ── Processing ───────────────────────────────────────────────────────────

  ipcMain.handle("process-now", async () => {
    const started = await runBacklog("manual", () => true);
    return { started };
  });

  // ── Chunk settings ───────────────────────────────────────────────────────

  ipcMain.handle("get-chunk-duration-ms", () => {
    return getChunkDurationMs();
  });

  ipcMain.handle("get-chunk-settings", () => {
    return readChunkSettings();
  });

  ipcMain.handle("update-chunk-settings", (_event, payload: Partial<ChunkSettings>) => {
    return writeChunkSettings(payload || {});
  });

  // ── Exclusions ───────────────────────────────────────────────────────────

  ipcMain.handle("get-exclusions", () => {
    return loadExclusions();
  });

  ipcMain.handle("update-exclusions", (_event, payload: Partial<ExclusionsConfig>) => {
    return updateExclusions(payload || {});
  });

  ipcMain.handle("scan-installed-apps", (_event, payload?: { forceRefresh?: boolean }) => {
    return scanInstalledApps(payload?.forceRefresh === true);
  });

  ipcMain.handle("scan-installed-app-from-path", (_event, appPath: string) => {
    return inspectAppBundlePath(appPath);
  });

  ipcMain.handle("get-initialized-exclusion-bundle-ids", () => {
    return getInitializedExclusionBundleIds();
  });

  ipcMain.handle("get-sckit-exclusions-init-state", () => {
    return getSckitExclusionsInitState();
  });

  // ── System ───────────────────────────────────────────────────────────────

  ipcMain.handle("restart-app", () => {
    app.relaunch();
    app.exit(0);
  });

  ipcMain.handle(
    "get-desktop-sources",
    (_event, opts: { types: ("screen" | "window")[] }) =>
      desktopCapturer.getSources(opts)
  );

  // ── MCP scope grants ─────────────────────────────────────────────────────

  ipcMain.handle("get-local-grant", () => {
    return getLocalGrant();
  });

  ipcMain.handle("set-local-scopes", (_event, scopes: ContextScope[]) => {
    return setLocalScopes(Array.isArray(scopes) ? scopes : []);
  });

  ipcMain.handle("revoke-local-grant", () => {
    return revokeLocalGrant();
  });

  ipcMain.handle("get-mcp-server-path", () => {
    if (app.isPackaged) {
      return path.join(process.resourcesPath, "mcp-server", "dist", "server.js");
    }
    return path.join(__dirname, "..", "..", "mcp_server", "dist", "server.js");
  });

  // ── AI settings ──────────────────────────────────────────────────────────

  ipcMain.handle("get-ai-settings", () => {
    return readAISettings();
  });

  ipcMain.handle("update-ai-settings", (_event, payload: Partial<AISettings>) => {
    return writeAISettings(payload || {});
  });
}
