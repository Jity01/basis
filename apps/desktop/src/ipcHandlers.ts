import { app, ipcMain, desktopCapturer, BrowserWindow } from "electron";
import * as path from "path";
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
import { scanInstalledApps } from "./appScanner";
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
import { detectInstalledMcpApps, registerMcpWithApps, isMcpRegistered } from "./mcpRegistration";
import {
  setTunnelStateListener,
  getTunnelState,
  startTunnel,
  stopTunnel,
  provisionTunnelCredentials,
} from "./tunnel";
import { readCredentials, writeCredentials, hasCredentials } from "@context-manager/config";

export function setMainWindow(win: BrowserWindow): void {
  setMainWindowRef(win);
}

export function setupIpc(): void {
  app.once("before-quit", () => {
    stopHotBuffer();
    stopTunnel();
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

  // ── Credentials ──────────────────────────────────────────────────────────
  ipcMain.handle("has-credentials", () => hasCredentials());
  ipcMain.handle("get-credentials", () => readCredentials());
  ipcMain.handle("save-credentials", (_event, creds: { authToken: string; accountEmail?: string; tunnelId?: string }) => {
    writeCredentials(creds);
    return { success: true };
  });

  // ── MCP Registration ─────────────────────────────────────────────────────
  ipcMain.handle("detect-mcp-apps", () => detectInstalledMcpApps());
  ipcMain.handle("register-mcp-apps", (_event, appNames: string[]) => registerMcpWithApps(appNames));
  ipcMain.handle("is-mcp-registered", (_event, appName: string) => isMcpRegistered(appName));

  // ── Tunnel ───────────────────────────────────────────────────────────────
  ipcMain.handle("get-tunnel-state", () => getTunnelState());
  ipcMain.handle("provision-tunnel", () => provisionTunnelCredentials());
  ipcMain.handle("start-tunnel", () => startTunnel());
  ipcMain.handle("stop-tunnel", () => stopTunnel());

  // Forward tunnel state changes to the renderer process
  setTunnelStateListener((state) => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win) {
      win.webContents.send("tunnel-state", state);
    }
  });
}
