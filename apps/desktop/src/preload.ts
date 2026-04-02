import { contextBridge, ipcRenderer } from "electron";
import type { ApprovalPayload, ApprovalState } from "./approvalTypes";

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
  getDesktopSources: (opts: { types: ("screen" | "window")[] }) =>
    ipcRenderer.invoke("get-desktop-sources", opts),
  getApprovalState: () => ipcRenderer.invoke("get-approval-state"),
  resolveApproval: (
    requestId: string,
    resolution: "approved" | "rejected",
    approvedPayload?: ApprovalPayload
  ) => ipcRenderer.invoke("resolve-approval", { requestId, resolution, approvedPayload }),
  approveAllRequests: () => ipcRenderer.invoke("approve-all-requests"),
  updateApprovalSettings: (settings: { autoApproveAllRequests?: boolean; timeoutMs?: number }) =>
    ipcRenderer.invoke("update-approval-settings", settings),
  getRemoteAccessState: () => ipcRenderer.invoke("get-remote-access-state"),
  getAISettings: () => ipcRenderer.invoke("get-ai-settings"),
  updateAISettings: (settings: {
    provider?: "fireworks" | "local";
    localBaseUrl?: string;
    localTaggingModel?: string;
    fireworksApiKey?: string;
  }) => ipcRenderer.invoke("update-ai-settings", settings),
  setRemoteAccessEnabled: (enabled: boolean) => ipcRenderer.invoke("set-remote-access-enabled", enabled),
  onRemoteAccessState: (
    callback: (state: {
      enabled: boolean;
      status: "disabled" | "starting" | "connected" | "reconnecting" | "error";
      publicUrl: string | null;
      authToken: string | null;
      error: string | null;
    }) => void
  ) => {
    const listener = (_event: unknown, state: unknown) => {
      callback(
        state as {
          enabled: boolean;
          status: "disabled" | "starting" | "connected" | "reconnecting" | "error";
          publicUrl: string | null;
          authToken: string | null;
          error: string | null;
        }
      );
    };
    ipcRenderer.on("remote-access-state", listener);
    return () => {
      ipcRenderer.removeListener("remote-access-state", listener);
    };
  },
  onApprovalState: (
    callback: (state: ApprovalState) => void
  ) => {
    const listener = (_event: unknown, state: unknown) => {
      callback(state as ApprovalState);
    };
    ipcRenderer.on("approval-state", listener);
    return () => {
      ipcRenderer.removeListener("approval-state", listener);
    };
  },
});
