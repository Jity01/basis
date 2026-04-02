export type ApprovalKind = "day_list" | "day_index" | "chunk_context";

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

export type ApprovalPayload =
  | DayListApprovalPayload
  | DayIndexApprovalPayload
  | ChunkContextApprovalPayload;

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
