// ── AI Settings ──────────────────────────────────────────────────────────────

export type AIProvider = "fireworks" | "local";

export type AISettings = {
  provider: AIProvider;
  localBaseUrl: string;
  localTaggingModel: string;
  /** Used when `FIREWORKS_API_KEY` is not set in the environment. */
  fireworksApiKey?: string;
};

// ── Chunk Settings ───────────────────────────────────────────────────────────

export type ChunkSettings = {
  chunkDurationMinutes: number;
};

// ── Exclusions ───────────────────────────────────────────────────────────────

export type ExclusionEntry = {
  bundle_id: string;
  name: string;
  is_default: boolean;
  enabled: boolean;
};

export type ExclusionsConfig = {
  requires_restart: boolean;
  bundle_ids: ExclusionEntry[];
};

// ── Hot Buffer ───────────────────────────────────────────────────────────────

export interface HotBufferConfig {
  captureIntervalMs: number;
  maxAgeMs: number;
  purgeIntervalMs: number;
  resolution: { width: number; height: number };
  jpegQuality: number;
  hotbufferDir: string;
  /** macOS: path to Vision OCR CLI (JPEG path as argv[1], UTF-8 text on stdout). */
  ocrBinaryPath?: string;
  excludedBundleIds?: string[];
}

export interface HotBufferEntry {
  timestamp: number;
  timestampISO: string;
  app: string;
  windowTitle: string;
  ocrText: string;
}

export interface HotBufferSnapshot extends HotBufferEntry {
  frameBuffer: Buffer;
}

// ── Pipeline ─────────────────────────────────────────────────────────────────

export type ProcessBacklogProgress =
  | { phase: "start"; total: number; completed: number }
  | { phase: "chunk-start"; total: number; completed: number; filePath: string }
  | { phase: "chunk-complete"; total: number; completed: number; filePath: string }
  | { phase: "paused"; total: number; completed: number }
  | { phase: "done"; total: number; completed: number };

export type ProcessBacklogOptions = {
  onProgress?: (progress: ProcessBacklogProgress) => void;
  aiSettings?: AISettings;
};

// ── Scopes & Grants (used by desktop app for MCP access control) ────────────

export type ContextScope = "context:metadata" | "context:ocr" | "context:frames";

export type ScopeGrant = {
  clientName: string;
  scopes: ContextScope[];
  grantedAt: string;
  lastUsed: string;
};

export type GrantsFile = {
  grants: Record<string, ScopeGrant>;
};

// ── Desktop IPC ──────────────────────────────────────────────────────────────

export type ProcessingTrigger = "idle" | "manual" | "live" | null;

export type ProcessingStatus = {
  isProcessing: boolean;
  currentChunk: number;
  totalChunks: number;
  pendingChunks: number;
  visiblePendingChunks: number;
  activeRecordingChunk: boolean;
  trigger: ProcessingTrigger;
};

export type RemoteAccessStatus = "disabled" | "starting" | "connected" | "reconnecting" | "error";

export type RemoteAccessState = {
  enabled: boolean;
  status: RemoteAccessStatus;
  publicUrl: string | null;
  authToken: string | null;
  error: string | null;
};

export type InstalledApp = {
  bundleId: string;
  name: string;
  iconPath: string | null;
};

export type SckitExclusionsInitState = {
  initialized: boolean;
  bundleIds: string[];
  error: string | null;
};
