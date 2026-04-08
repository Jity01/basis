import { randomUUID } from "crypto";
import type {
  ApprovalStatus,
  ApprovalResolution,
  ApprovalKind,
  ApprovalPayload,
  ApprovalRequest,
  ApprovalSettings,
  DayListApprovalPayload,
  DayIndexApprovalPayload,
  ChunkContextApprovalPayload,
  LiveContextApprovalPayload,
  LiveFrameApprovalPayload,
  LiveSnapshotsApprovalPayload,
} from "@context-manager/config";

export type {
  ApprovalStatus,
  ApprovalResolution,
  ApprovalKind,
  DayListApprovalDay,
  DayListApprovalPayload,
  DayIndexApprovalPayload,
  ApprovalFrame,
  ChunkContextApprovalPayload,
  LiveContextApprovalPayload,
  LiveFrameApprovalPayload,
  LiveSnapshotItem,
  LiveSnapshotsApprovalPayload,
  ApprovalPayload,
  ApprovalRequest,
  ApprovalSettings,
} from "@context-manager/config";

type PendingApproval = {
  request: ApprovalRequest;
  resolve: (result: { status: ApprovalStatus; approvedPayload?: ApprovalPayload }) => void;
  timeout: NodeJS.Timeout;
};

type ApprovalListener = (request: ApprovalRequest) => void;
type ElectronIpcSender = (channel: string, payload: unknown) => void;

const pendingRequests = new Map<string, PendingApproval>();
const listeners = new Set<ApprovalListener>();
let electronIpcSender: ElectronIpcSender | null = null;

type ApprovalRequestInput = {
  query: string;
  title?: string;
  payload: ApprovalPayload;
  resultPreview?: string;
  fullResult?: string;
};

const DEFAULT_TIMEOUT_MS = 120_000;
const MIN_TIMEOUT_MS = 5_000;
const MAX_TIMEOUT_MS = 10 * 60_000;

const approvalSettings: ApprovalSettings = {
  autoApproveAllRequests: (process.env.MCP_AUTO_APPROVE || "false").toLowerCase() === "true",
  timeoutMs: parseTimeoutMs(process.env.MCP_APPROVAL_TIMEOUT_MS),
};

function parseTimeoutMs(value: string | undefined): number {
  if (!value) {
    return DEFAULT_TIMEOUT_MS;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_TIMEOUT_MS;
  }
  return Math.max(MIN_TIMEOUT_MS, Math.min(MAX_TIMEOUT_MS, Math.trunc(parsed)));
}

function notifyListeners(request: ApprovalRequest): void {
  for (const listener of listeners) {
    try {
      listener(request);
    } catch (err) {
      console.error("[mcp-approval] listener failed:", err);
    }
  }

  if (electronIpcSender) {
    try {
      electronIpcSender("mcp-approval-request", request);
    } catch (err) {
      console.error("[mcp-approval] electron ipc sender failed:", err);
    }
  }
}

export function setElectronIpcSender(sender: ElectronIpcSender | null): void {
  electronIpcSender = sender;
}

export function onApprovalRequest(listener: ApprovalListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function listPendingApprovals(): ApprovalRequest[] {
  return Array.from(pendingRequests.values()).map((entry) => entry.request);
}

export function resolveAllApprovals(resolution: ApprovalResolution): number {
  const pendingIds = Array.from(pendingRequests.keys());
  for (const id of pendingIds) {
    resolveApproval(id, resolution);
  }
  return pendingIds.length;
}

export function getApprovalSettings(): ApprovalSettings {
  return { ...approvalSettings };
}

export function updateApprovalSettings(patch: Partial<ApprovalSettings>): ApprovalSettings {
  if (typeof patch.autoApproveAllRequests === "boolean") {
    approvalSettings.autoApproveAllRequests = patch.autoApproveAllRequests;
  }
  if (typeof patch.timeoutMs === "number" && Number.isFinite(patch.timeoutMs)) {
    const normalized = Math.trunc(patch.timeoutMs);
    approvalSettings.timeoutMs = Math.max(MIN_TIMEOUT_MS, Math.min(MAX_TIMEOUT_MS, normalized));
  }
  return getApprovalSettings();
}

function truncatePreview(text: string): string {
  return text.length > 500 ? `${text.slice(0, 500)}\n...(truncated preview)` : text;
}

function formatDayListPayload(payload: DayListApprovalPayload): string {
  if (payload.days.length === 0) {
    return "No stored context days found.";
  }
  return [
    "Days:",
    ...payload.days.map((day) => {
      const range =
        day.firstChunkTime && day.lastChunkTime
          ? `${day.firstChunkTime} - ${day.lastChunkTime}`
          : "no chunk times";
      return `- ${day.date} | chunks=${day.chunkCount} | range=${range} | index=${day.hasIndex ? "yes" : "no"}`;
    }),
  ].join("\n");
}

function formatDayIndexPayload(payload: DayIndexApprovalPayload): string {
  return [
    `Date: ${payload.date}`,
    `Chunk count: ${payload.chunkCount}`,
    `Chunk keys: ${payload.chunkKeys.length > 0 ? payload.chunkKeys.join(", ") : "(none)"}`,
    "Index:",
    payload.indexText || "(no summaries for this day)",
  ].join("\n");
}

function formatChunkContextPayload(payload: ChunkContextApprovalPayload): string {
  return [
    `Chunk: ${payload.chunkKey}`,
    "Summary:",
    payload.summaryText || "(empty summary)",
    "Meta:",
    payload.metaText || "(missing meta.json)",
    "Frames:",
    payload.frames.length > 0
      ? payload.frames.map((frame) => `- ${frame.name} (${frame.mimeType})`).join("\n")
      : "(none)",
  ].join("\n");
}

function formatLiveContextPayload(payload: LiveContextApprovalPayload): string {
  return payload.timelineText || "(empty live context)";
}

function formatLiveFramePayload(payload: LiveFrameApprovalPayload): string {
  return [
    `Live frame timestamp: ${payload.timestamp}`,
    `MIME: ${payload.mimeType}`,
    "Image: (binary preview omitted)",
  ].join("\n");
}

function formatLiveSnapshotsPayload(payload: LiveSnapshotsApprovalPayload): string {
  if (payload.items.length === 0) {
    return "No live snapshots.";
  }
  return payload.items
    .map(
      (item, i) =>
        `[${i + 1}] ${item.app} — ${item.windowTitle} @ ${item.timestamp}\nOCR: ${item.ocrText.slice(0, 200)}${item.ocrText.length > 200 ? "..." : ""}`
    )
    .join("\n\n");
}

export function formatApprovalPayload(payload: ApprovalPayload): string {
  switch (payload.kind) {
    case "day_list":
      return formatDayListPayload(payload);
    case "day_index":
      return formatDayIndexPayload(payload);
    case "chunk_context":
      return formatChunkContextPayload(payload);
    case "live_context":
      return formatLiveContextPayload(payload);
    case "live_frame":
      return formatLiveFramePayload(payload);
    case "live_snapshots":
      return formatLiveSnapshotsPayload(payload);
  }
}

function isDayListApprovalPayload(value: unknown): value is DayListApprovalPayload {
  return (
    value !== null &&
    typeof value === "object" &&
    (value as { kind?: unknown }).kind === "day_list" &&
    Array.isArray((value as { days?: unknown }).days)
  );
}

function isDayIndexApprovalPayload(value: unknown): value is DayIndexApprovalPayload {
  return (
    value !== null &&
    typeof value === "object" &&
    (value as { kind?: unknown }).kind === "day_index" &&
    typeof (value as { date?: unknown }).date === "string" &&
    Array.isArray((value as { chunkKeys?: unknown }).chunkKeys) &&
    typeof (value as { indexText?: unknown }).indexText === "string"
  );
}

function isChunkContextApprovalPayload(value: unknown): value is ChunkContextApprovalPayload {
  return (
    value !== null &&
    typeof value === "object" &&
    (value as { kind?: unknown }).kind === "chunk_context" &&
    typeof (value as { chunkKey?: unknown }).chunkKey === "string" &&
    typeof (value as { date?: unknown }).date === "string" &&
    typeof (value as { time?: unknown }).time === "string" &&
    typeof (value as { summaryText?: unknown }).summaryText === "string" &&
    typeof (value as { metaText?: unknown }).metaText === "string" &&
    Array.isArray((value as { frames?: unknown }).frames)
  );
}

function isLiveContextApprovalPayload(value: unknown): value is LiveContextApprovalPayload {
  return (
    value !== null &&
    typeof value === "object" &&
    (value as { kind?: unknown }).kind === "live_context" &&
    typeof (value as { timelineText?: unknown }).timelineText === "string"
  );
}

function isLiveFrameApprovalPayload(value: unknown): value is LiveFrameApprovalPayload {
  return (
    value !== null &&
    typeof value === "object" &&
    (value as { kind?: unknown }).kind === "live_frame" &&
    typeof (value as { timestamp?: unknown }).timestamp === "number" &&
    typeof (value as { mimeType?: unknown }).mimeType === "string" &&
    typeof (value as { data?: unknown }).data === "string"
  );
}

function isLiveSnapshotsApprovalPayload(value: unknown): value is LiveSnapshotsApprovalPayload {
  return (
    value !== null &&
    typeof value === "object" &&
    (value as { kind?: unknown }).kind === "live_snapshots" &&
    Array.isArray((value as { items?: unknown }).items)
  );
}

function normalizeApprovedPayload(original: ApprovalPayload, candidate: unknown): ApprovalPayload {
  if (candidate === null || typeof candidate !== "object") {
    return original;
  }

  switch (original.kind) {
    case "day_list":
      if (!isDayListApprovalPayload(candidate)) {
        return original;
      }
      return {
        kind: "day_list",
        days: candidate.days
          .filter((day) => day && typeof day === "object")
          .map((day) => {
            const parsed = day as Record<string, unknown>;
            return {
              date: typeof parsed.date === "string" ? parsed.date : "",
              chunkCount:
                typeof parsed.chunkCount === "number" && Number.isFinite(parsed.chunkCount)
                  ? Math.max(0, Math.trunc(parsed.chunkCount))
                  : 0,
              firstChunkTime: typeof parsed.firstChunkTime === "string" ? parsed.firstChunkTime : null,
              lastChunkTime: typeof parsed.lastChunkTime === "string" ? parsed.lastChunkTime : null,
              hasIndex: parsed.hasIndex === true,
            };
          }),
      };
    case "day_index":
      if (!isDayIndexApprovalPayload(candidate) || candidate.date !== original.date) {
        return original;
      }
      return {
        kind: "day_index",
        date: original.date,
        chunkCount:
          typeof candidate.chunkCount === "number" && Number.isFinite(candidate.chunkCount)
            ? Math.max(0, Math.trunc(candidate.chunkCount))
            : original.chunkCount,
        chunkKeys: Array.isArray(candidate.chunkKeys)
          ? candidate.chunkKeys.filter((value): value is string => typeof value === "string")
          : original.chunkKeys,
        indexText: candidate.indexText,
      };
    case "chunk_context":
      if (!isChunkContextApprovalPayload(candidate) || candidate.chunkKey !== original.chunkKey) {
        return original;
      }
      return {
        kind: "chunk_context",
        chunkKey: original.chunkKey,
        date: original.date,
        time: original.time,
        summaryText: candidate.summaryText,
        metaText: candidate.metaText,
        frames: candidate.frames
          .filter((frame) => frame && typeof frame === "object")
          .map((frame) => {
            const parsed = frame as Record<string, unknown>;
            return {
              name: typeof parsed.name === "string" ? parsed.name : "",
              mimeType: typeof parsed.mimeType === "string" ? parsed.mimeType : "image/jpeg",
              data: typeof parsed.data === "string" ? parsed.data : "",
            };
          })
          .filter((frame) => frame.name && frame.data),
      };
    case "live_context":
      if (!isLiveContextApprovalPayload(candidate)) {
        return original;
      }
      return {
        kind: "live_context",
        timelineText: candidate.timelineText,
      };
    case "live_frame":
      if (!isLiveFrameApprovalPayload(candidate) || candidate.timestamp !== original.timestamp) {
        return original;
      }
      return {
        kind: "live_frame",
        timestamp: original.timestamp,
        mimeType: candidate.mimeType,
        data: candidate.data,
      };
    case "live_snapshots":
      if (!isLiveSnapshotsApprovalPayload(candidate)) {
        return original;
      }
      return {
        kind: "live_snapshots",
        items: candidate.items
          .filter((item) => item && typeof item === "object")
          .map((item) => {
            const parsed = item as Record<string, unknown>;
            const frame = parsed.frame as Record<string, unknown> | undefined;
            return {
              timestamp: typeof parsed.timestamp === "number" ? parsed.timestamp : 0,
              app: typeof parsed.app === "string" ? parsed.app : "",
              windowTitle: typeof parsed.windowTitle === "string" ? parsed.windowTitle : "",
              ocrText: typeof parsed.ocrText === "string" ? parsed.ocrText : "",
              frame: {
                name: typeof frame?.name === "string" ? frame.name : "",
                mimeType: typeof frame?.mimeType === "string" ? frame.mimeType : "image/jpeg",
                data: typeof frame?.data === "string" ? frame.data : "",
              },
            };
          })
          .filter((item) => item.frame.data),
      };
  }
}

export async function requestApproval(
  input: ApprovalRequestInput
): Promise<{ status: ApprovalStatus; requestId: string; approvedPayload?: ApprovalPayload }> {
  const requestId = randomUUID();
  const fullResult = input.fullResult || formatApprovalPayload(input.payload);
  const preview = input.resultPreview || truncatePreview(fullResult);
  const title = input.title?.trim() || input.query;

  // for the lucky ones
  if (approvalSettings.autoApproveAllRequests) {
    return { status: "approved", requestId, approvedPayload: input.payload };
  }

  const request: ApprovalRequest = {
    id: requestId,
    createdAt: new Date().toISOString(),
    query: input.query,
    title,
    kind: input.payload.kind,
    fullResult,
    resultPreview: preview,
    payload: input.payload,
  };

  return await new Promise<{
    status: ApprovalStatus;
    requestId: string;
    approvedPayload?: ApprovalPayload;
  }>((resolve) => {
    const timeout = setTimeout(() => {
      pendingRequests.delete(requestId);
      resolve({ status: "timeout", requestId });
    }, approvalSettings.timeoutMs);

    pendingRequests.set(requestId, {
      request,
      timeout,
      resolve: ({ status, approvedPayload }) => {
        resolve({ status, requestId, approvedPayload });
      },
    });

    notifyListeners(request);
  });
}

export function resolveApproval(
  id: string,
  resolution: ApprovalResolution,
  approvedPayload?: unknown
): boolean {
  const pending = pendingRequests.get(id);
  if (!pending) {
    return false;
  }
  clearTimeout(pending.timeout);
  pendingRequests.delete(id);
  pending.resolve({
    status: resolution,
    approvedPayload:
      resolution === "approved"
        ? normalizeApprovedPayload(pending.request.payload, approvedPayload ?? pending.request.payload)
        : undefined,
  });
  return true;
}
