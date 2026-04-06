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

export type ApprovalSettings = {
  autoApproveAllRequests: boolean;
  timeoutMs: number;
};

export type ApprovalState = {
  pending: ApprovalRequest[];
  settings: ApprovalSettings;
};
