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

// ── Chunk Analysis (structured tagger output) ───────────────────────────────

export type ActivityType = "coding" | "browsing" | "communication" | "reading" | "design" | "terminal" | "other";

export type Activity = {
  type: ActivityType;
  description: string;
  app: string;
  topics: string[];
  duration_pct: number;
};

export type AppContext = {
  name: string;
  window_titles: string[];
  duration_pct: number;
};

export type ChunkMetadata = {
  activities: Activity[];
  entities: string[];
  apps: AppContext[];
  primary_intent: string;
  context_switches: number;
};

export type ChunkAnalysis = ChunkMetadata & {
  summary: string;
};

// ── Catalog (per-day chunk index) ────────────────────────────────────────────

export type CatalogEntry = {
  time: string;
  chunk_key: string;
  primary_intent: string;
  activities: string[];
  apps: string[];
  topics: string[];
  entities: string[];
  context_switches: number;
  summary_preview: string;
};

export type DayCatalog = {
  date: string;
  chunks: CatalogEntry[];
};

// ── Sessions ─────────────────────────────────────────────────────────────────

export type Session = {
  id: string;
  date: string;
  start_time: string;
  end_time: string;
  chunk_keys: string[];
  duration_minutes: number;
  primary_intent: string;
  topics: string[];
  apps: string[];
  activity_types: ActivityType[];
  summary: string;
};

export type DaySessions = {
  date: string;
  sessions: Session[];
};

// ── Profile (precomputed agent context) ──────────────────────────────────────

export type ActiveProject = {
  name: string;
  last_seen: string;
  topics: string[];
  recent_files: string[];
  sessions_this_week: number;
};

export type ActiveThread = {
  description: string;
  started: string;
  last_active: string;
  status: "in_progress" | "stale" | "completed";
  related_sessions: string[];
};

export type UserProfile = {
  updated_at: string;
  active_projects: ActiveProject[];
  active_threads: ActiveThread[];
  daily_pattern: {
    typical_start: string;
    typical_end: string;
    most_used_apps: string[];
  };
  week_summary: string;
};

// ── Rolling Context (agent-facing L0/L1) ─────────────────────────────────────

export type RollingContext = {
  updated_at: string;
  active_projects: Array<{
    name: string;
    last_seen: string;
    topics: string[];
    sessions_this_week: number;
  }>;
  recent_threads: Array<{
    description: string;
    last_active: string;
    status: "active" | "stale";
  }>;
  last_session: {
    date: string;
    time: string;
    primary_intent: string;
    topics: string[];
    apps: string[];
  } | null;
  daily_pattern: {
    typical_start: string;
    typical_end: string;
    most_used_apps: string[];
  };
  week_summary: string;
};

// ── Searcher ─────────────────────────────────────────────────────────────────

export type DaySummary = {
  date: string;
  chunkCount: number;
  firstChunkTime: string | null;
  lastChunkTime: string | null;
  hasIndex: boolean;
};

export type DayIndex = DaySummary & {
  chunkKeys: string[];
  indexText: string;
};

export type ChunkFrame = {
  name: string;
  path: string;
  mimeType: string;
  data: string;
};

export type ChunkContext = {
  chunkKey: string;
  date: string;
  time: string;
  summaryText: string;
  meta: Record<string, unknown> | null;
  frames: ChunkFrame[];
};

// ── Approvals ────────────────────────────────────────────────────────────────

export type ApprovalStatus = "approved" | "rejected" | "timeout";
export type ApprovalResolution = "approved" | "rejected";
export type ApprovalKind = "day_list" | "day_index" | "chunk_context" | "live_context" | "live_frame" | "live_snapshots";

export type DayListApprovalDay = {
  date: string;
  chunkCount: number;
  firstChunkTime: string | null;
  lastChunkTime: string | null;
  hasIndex: boolean;
};

export type DayListApprovalPayload = {
  kind: "day_list";
  days: DayListApprovalDay[];
};

export type DayIndexApprovalPayload = {
  kind: "day_index";
  date: string;
  chunkCount: number;
  chunkKeys: string[];
  indexText: string;
};

export type ApprovalFrame = {
  name: string;
  mimeType: string;
  data: string;
};

export type ChunkContextApprovalPayload = {
  kind: "chunk_context";
  chunkKey: string;
  date: string;
  time: string;
  summaryText: string;
  metaText: string;
  frames: ApprovalFrame[];
};

export type LiveContextApprovalPayload = {
  kind: "live_context";
  timelineText: string;
};

export type LiveFrameApprovalPayload = {
  kind: "live_frame";
  timestamp: number;
  mimeType: string;
  data: string;
};

export type LiveSnapshotItem = {
  timestamp: number;
  app: string;
  windowTitle: string;
  ocrText: string;
  frame: ApprovalFrame;
};

export type LiveSnapshotsApprovalPayload = {
  kind: "live_snapshots";
  items: LiveSnapshotItem[];
};

export type ApprovalPayload =
  | DayListApprovalPayload
  | DayIndexApprovalPayload
  | ChunkContextApprovalPayload
  | LiveContextApprovalPayload
  | LiveFrameApprovalPayload
  | LiveSnapshotsApprovalPayload;

export type ApprovalRequest = {
  id: string;
  createdAt: string;
  query: string;
  title: string;
  kind: ApprovalKind;
  resultPreview: string;
  fullResult: string;
  payload: ApprovalPayload;
};

// ── Scopes & Grants ──────────────────────────────────────────────────────────

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

export type EscalationDecision = "allow-once" | "allow-session" | "always-allow" | "deny";

export type EscalationRequest = {
  id: string;
  toolName: string;
  scopeNeeded: ContextScope;
  clientId: string;
  clientName: string;
  createdAt: string;
};

export type EscalationResponse = {
  requestId: string;
  decision: EscalationDecision;
};

export type ApprovalSettings = {
  timeoutMs: number;
};

export type ApprovalState = {
  pending: ApprovalRequest[];
  settings: ApprovalSettings;
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
