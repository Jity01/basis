import { contextBridge, ipcRenderer } from "electron";
import type { AISettings, ContextScope } from "@context-manager/config";

contextBridge.exposeInMainWorld("contextManager", {
  startRecording: () => ipcRenderer.invoke("start-recording"),
  stopRecording: () => ipcRenderer.invoke("stop-recording"),
  rotateRecording: () => ipcRenderer.invoke("rotate-recording"),
  processNow: () => ipcRenderer.invoke("process-now"),
  sendRecordingChunk: (chunk: ArrayBuffer) =>
    ipcRenderer.invoke("recording-chunk", Buffer.from(chunk)),
  getCurrentFile: () => ipcRenderer.invoke("get-current-file"),
  getUnprocessedFiles: () => ipcRenderer.invoke("get-unprocessed-files"),
  getProcessingStatus: () => ipcRenderer.invoke("get-processing-status"),
  onProcessingStatus: (
    callback: (status: {
      isProcessing: boolean;
      currentChunk: number;
      totalChunks: number;
      pendingChunks: number;
      visiblePendingChunks: number;
      activeRecordingChunk: boolean;
      trigger: "idle" | "manual" | "live" | null;
    }) => void
  ) => {
    const listener = (_event: unknown, status: unknown) => {
      callback(
        status as {
          isProcessing: boolean;
          currentChunk: number;
          totalChunks: number;
          pendingChunks: number;
          visiblePendingChunks: number;
          activeRecordingChunk: boolean;
          trigger: "idle" | "manual" | "live" | null;
        }
      );
    };
    ipcRenderer.on("processing-status", listener);
    return () => {
      ipcRenderer.removeListener("processing-status", listener);
    };
  },
  getChunkDurationMs: () => ipcRenderer.invoke("get-chunk-duration-ms"),
  getChunkSettings: () => ipcRenderer.invoke("get-chunk-settings"),
  updateChunkSettings: (settings: { chunkDurationMinutes?: number }) =>
    ipcRenderer.invoke("update-chunk-settings", settings),
  getExclusions: () => ipcRenderer.invoke("get-exclusions"),
  updateExclusions: (settings: {
    requires_restart?: boolean;
    bundle_ids?: Array<{
      bundle_id: string;
      name: string;
      is_default: boolean;
      enabled: boolean;
    }>;
  }) => ipcRenderer.invoke("update-exclusions", settings),
  scanInstalledApps: (opts?: { forceRefresh?: boolean }) => ipcRenderer.invoke("scan-installed-apps", opts || {}),
  getInitializedExclusionBundleIds: () => ipcRenderer.invoke("get-initialized-exclusion-bundle-ids"),
  getSckitExclusionsInitState: () => ipcRenderer.invoke("get-sckit-exclusions-init-state"),
  restartApp: () => ipcRenderer.invoke("restart-app"),
  getDesktopSources: (opts: { types: ("screen" | "window")[] }) =>
    ipcRenderer.invoke("get-desktop-sources", opts),
  // MCP scope grants
  getLocalGrant: () => ipcRenderer.invoke("get-local-grant"),
  setLocalScopes: (scopes: ContextScope[]) => ipcRenderer.invoke("set-local-scopes", scopes),
  revokeLocalGrant: () => ipcRenderer.invoke("revoke-local-grant"),
  getMcpServerPath: () => ipcRenderer.invoke("get-mcp-server-path"),
  // AI settings
  getAISettings: () => ipcRenderer.invoke("get-ai-settings"),
  updateAISettings: (settings: Partial<AISettings>) => ipcRenderer.invoke("update-ai-settings", settings),

  // Credentials
  hasCredentials: () => ipcRenderer.invoke("has-credentials"),
  getCredentials: () => ipcRenderer.invoke("get-credentials"),
  saveCredentials: (creds: { authToken: string; accountEmail?: string; tunnelId?: string }) =>
    ipcRenderer.invoke("save-credentials", creds),

  // MCP Registration
  detectMcpApps: () => ipcRenderer.invoke("detect-mcp-apps"),
  registerMcpApps: (appNames: string[]) => ipcRenderer.invoke("register-mcp-apps", appNames),
  isMcpRegistered: (appName: string) => ipcRenderer.invoke("is-mcp-registered", appName),

  // Tunnel
  getTunnelState: () => ipcRenderer.invoke("get-tunnel-state"),
  provisionTunnel: () => ipcRenderer.invoke("provision-tunnel"),
  startTunnel: () => ipcRenderer.invoke("start-tunnel"),
  stopTunnel: () => ipcRenderer.invoke("stop-tunnel"),
  onTunnelState: (callback: (state: { enabled: boolean; status: string; publicUrl: string | null; error: string | null }) => void) => {
    const listener = (_event: unknown, state: unknown) => {
      callback(state as { enabled: boolean; status: string; publicUrl: string | null; error: string | null });
    };
    ipcRenderer.on("tunnel-state", listener);
    return () => {
      ipcRenderer.removeListener("tunnel-state", listener);
    };
  },
});
