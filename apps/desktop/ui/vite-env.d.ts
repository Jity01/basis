/// <reference types="vite/client" />

import type { ApprovalPayload, ApprovalState } from "../src/approvalTypes";

interface ContextManagerAPI {
  startRecording: () => Promise<{ success: boolean; filePath: string }>;
  stopRecording: () => Promise<{ success: boolean }>;
  rotateRecording: () => Promise<{ filePath: string }>;
  processNow: () => Promise<{ started: boolean }>;
  sendRecordingChunk: (chunk: ArrayBuffer) => Promise<void>;
  getCurrentFile: () => Promise<string | null>;
  getUnprocessedFiles: () => Promise<string[]>;
  getProcessingStatus: () => Promise<{
    isProcessing: boolean;
    currentChunk: number;
    totalChunks: number;
    pendingChunks: number;
    visiblePendingChunks: number;
    activeRecordingChunk: boolean;
    trigger: "idle" | "manual" | "live" | null;
  }>;
  onProcessingStatus: (callback: (status: {
    isProcessing: boolean;
    currentChunk: number;
    totalChunks: number;
    pendingChunks: number;
    visiblePendingChunks: number;
    activeRecordingChunk: boolean;
    trigger: "idle" | "manual" | "live" | null;
  }) => void) => () => void;
  getChunkDurationMs: () => Promise<number>;
  getChunkSettings: () => Promise<{
    chunkDurationMinutes: number;
  }>;
  updateChunkSettings: (settings: {
    chunkDurationMinutes?: number;
  }) => Promise<{
    chunkDurationMinutes: number;
  }>;
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
  updateApprovalSettings: (settings: {
    autoApproveAllRequests?: boolean;
    timeoutMs?: number;
  }) => Promise<{
    autoApproveAllRequests: boolean;
    timeoutMs: number;
  }>;
  getAISettings: () => Promise<{
    provider: "fireworks" | "local";
    localBaseUrl: string;
    localTaggingModel: string;
    fireworksApiKey?: string;
  }>;
  updateAISettings: (settings: {
    provider?: "fireworks" | "local";
    localBaseUrl?: string;
    localTaggingModel?: string;
    fireworksApiKey?: string;
  }) => Promise<{
    provider: "fireworks" | "local";
    localBaseUrl: string;
    localTaggingModel: string;
    fireworksApiKey?: string;
  }>;
  getRemoteAccessState: () => Promise<{
    enabled: boolean;
    status: "disabled" | "starting" | "connected" | "reconnecting" | "error";
    publicUrl: string | null;
    authToken: string | null;
    error: string | null;
  }>;
  setRemoteAccessEnabled: (enabled: boolean) => Promise<{
    enabled: boolean;
    status: "disabled" | "starting" | "connected" | "reconnecting" | "error";
    publicUrl: string | null;
    authToken: string | null;
    error: string | null;
  }>;
  onRemoteAccessState: (callback: (state: {
    enabled: boolean;
    status: "disabled" | "starting" | "connected" | "reconnecting" | "error";
    publicUrl: string | null;
    authToken: string | null;
    error: string | null;
  }) => void) => () => void;
  onApprovalState: (callback: (state: ApprovalState) => void) => () => void;
}

declare global {
  interface Window {
    contextManager: ContextManagerAPI;
  }
}

export {};
