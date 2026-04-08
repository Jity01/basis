/// <reference types="vite/client" />

import type {
  ApprovalPayload,
  ApprovalState,
  AISettings,
  ChunkSettings,
  ExclusionEntry,
  ExclusionsConfig,
  InstalledApp,
  ProcessingStatus,
  RemoteAccessState,
  SckitExclusionsInitState,
} from "@context-manager/config";

interface ContextManagerAPI {
  startRecording: () => Promise<{ success: boolean; filePath: string }>;
  stopRecording: () => Promise<{ success: boolean }>;
  rotateRecording: () => Promise<{ filePath: string }>;
  processNow: () => Promise<{ started: boolean }>;
  sendRecordingChunk: (chunk: ArrayBuffer) => Promise<void>;
  getCurrentFile: () => Promise<string | null>;
  getUnprocessedFiles: () => Promise<string[]>;
  getProcessingStatus: () => Promise<ProcessingStatus>;
  onProcessingStatus: (callback: (status: ProcessingStatus) => void) => () => void;
  getChunkDurationMs: () => Promise<number>;
  getChunkSettings: () => Promise<ChunkSettings>;
  updateChunkSettings: (settings: Partial<ChunkSettings>) => Promise<ChunkSettings>;
  getExclusions: () => Promise<ExclusionsConfig>;
  updateExclusions: (settings: Partial<ExclusionsConfig>) => Promise<ExclusionsConfig>;
  scanInstalledApps: (opts?: { forceRefresh?: boolean }) => Promise<InstalledApp[]>;
  scanInstalledAppFromPath: (appPath: string) => Promise<InstalledApp | null>;
  getInitializedExclusionBundleIds: () => Promise<string[]>;
  getSckitExclusionsInitState: () => Promise<SckitExclusionsInitState>;
  restartApp: () => Promise<void>;
  getDesktopSources: (opts: { types: ("screen" | "window")[] }) => Promise<
    Array<{ id: string; name: string }>
  >;
  getApprovalState: () => Promise<ApprovalState>;
  resolveApproval: (
    requestId: string,
    resolution: "approved" | "rejected",
    approvedPayload?: ApprovalPayload
  ) => Promise<{ ok: boolean }>;
  approveAllRequests: () => Promise<{ ok: boolean; resolvedCount: number }>;
  updateApprovalSettings: (settings: Partial<import("@context-manager/config").ApprovalSettings>) => Promise<import("@context-manager/config").ApprovalSettings>;
  getAISettings: () => Promise<AISettings>;
  updateAISettings: (settings: Partial<AISettings>) => Promise<AISettings>;
  getRemoteAccessState: () => Promise<RemoteAccessState>;
  setRemoteAccessEnabled: (enabled: boolean) => Promise<RemoteAccessState>;
  onRemoteAccessState: (callback: (state: RemoteAccessState) => void) => () => void;
  onApprovalState: (callback: (state: ApprovalState) => void) => () => void;
}

declare global {
  interface Window {
    contextManager: ContextManagerAPI;
  }
}

export {};
