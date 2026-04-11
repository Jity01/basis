import type {
  ContextScope,
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
import { scopeCovers, requiredScope } from "./scopes";
import { grantedScopes, touchGrant } from "./grants";

// Re-export types for server.ts
export type {
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

// ── Tool access check ────────────────────────────────────────────────────────

export type ToolGateResult =
  | { allowed: true }
  | { allowed: false; error: string };

/**
 * Check if a tool call is allowed by the client's persisted scope grants.
 * Reads ~/.basis/mcp-grants.json. No real-time escalation, no IPC.
 *
 * If the user wants to grant a higher scope, they do it in the desktop app
 * (which writes to mcp-grants.json), then retry the tool call.
 */
export async function checkToolAccess(
  toolName: string,
  clientId: string,
  _clientName: string
): Promise<ToolGateResult> {
  const needed = requiredScope(toolName);
  const granted = grantedScopes(clientId);

  if (scopeCovers(granted, needed)) {
    touchGrant(clientId);
    return { allowed: true };
  }

  return {
    allowed: false,
    error: `This tool requires the "${needed}" scope, which is not granted to the local client. Open Basis Settings → MCP Access and enable "${needed}", then retry.`,
  };
}

// ── Payload formatting (used by server.ts) ───────────────────────────────────

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

function formatDayListPayload(payload: DayListApprovalPayload): string {
  if (payload.days.length === 0) return "No stored context days found.";
  return [
    "Days:",
    ...payload.days.map((day) => {
      const range = day.firstChunkTime && day.lastChunkTime
        ? `${day.firstChunkTime} - ${day.lastChunkTime}` : "no chunk times";
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
  return [`Live frame timestamp: ${payload.timestamp}`, `MIME: ${payload.mimeType}`].join("\n");
}

function formatLiveSnapshotsPayload(payload: LiveSnapshotsApprovalPayload): string {
  if (payload.items.length === 0) return "No live snapshots.";
  return payload.items
    .map((item, i) =>
      `[${i + 1}] ${item.app} — ${item.windowTitle} @ ${item.timestamp}\nOCR: ${item.ocrText.slice(0, 200)}${item.ocrText.length > 200 ? "..." : ""}`
    )
    .join("\n\n");
}
