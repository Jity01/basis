import type { ApprovalPayload, ApprovalSettings, ApprovalState, ApprovalRequest, ApprovalResolution } from "@context-manager/config";
import { sendToRenderer } from "./mainWindowRef";

const MCP_SERVER_HOST = process.env.MCP_SERVER_HOST?.trim() || "127.0.0.1";
const MCP_SERVER_PORT = Number(process.env.MCP_SERVER_PORT || 4821);
const APPROVAL_POLL_INTERVAL_MS = 2_000;

let approvalPollTimer: ReturnType<typeof setInterval> | null = null;
let lastApprovalSnapshot = "";

function mcpBaseUrl(): string {
  return `http://${MCP_SERVER_HOST}:${MCP_SERVER_PORT}`;
}

export async function fetchApprovalState(): Promise<ApprovalState> {
  const response = await fetch(`${mcpBaseUrl()}/approvals/pending`);
  if (!response.ok) {
    throw new Error(`Failed loading approval queue (${response.status}).`);
  }
  const body = (await response.json()) as {
    pending?: ApprovalRequest[];
    settings?: ApprovalSettings;
  };
  return {
    pending: Array.isArray(body.pending) ? body.pending : [],
    settings: body.settings || { autoApproveAllRequests: false, timeoutMs: 120_000 },
  };
}

export async function postApprovalResolution(
  requestId: string,
  resolution: ApprovalResolution,
  approvedPayload?: ApprovalPayload
): Promise<{ ok: boolean }> {
  const response = await fetch(`${mcpBaseUrl()}/approvals/${encodeURIComponent(requestId)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ resolution, approvedPayload }),
  });
  if (!response.ok) {
    throw new Error(`Failed resolving approval (${response.status}).`);
  }
  return (await response.json()) as { ok: boolean };
}

export async function postApproveAll(): Promise<{ ok: boolean; resolvedCount: number }> {
  const response = await fetch(`${mcpBaseUrl()}/approvals/approve-all`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  if (!response.ok) {
    throw new Error(`Failed approving all requests (${response.status}).`);
  }
  return (await response.json()) as { ok: boolean; resolvedCount: number };
}

export async function postApprovalSettings(settings: Partial<ApprovalSettings>): Promise<ApprovalSettings> {
  const response = await fetch(`${mcpBaseUrl()}/approvals/settings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(settings),
  });
  if (!response.ok) {
    throw new Error(`Failed updating approval settings (${response.status}).`);
  }
  return (await response.json()) as ApprovalSettings;
}

async function pollApprovalUpdates(): Promise<void> {
  try {
    const state = await fetchApprovalState();
    const nextSnapshot = JSON.stringify(state);
    if (nextSnapshot === lastApprovalSnapshot) {
      return;
    }
    lastApprovalSnapshot = nextSnapshot;
    sendToRenderer("approval-state", state);
  } catch {
    // MCP server may be unavailable during startup; ignore and retry.
  }
}

export function ensureApprovalPolling(): void {
  if (approvalPollTimer) {
    return;
  }
  approvalPollTimer = setInterval(() => {
    void pollApprovalUpdates();
  }, APPROVAL_POLL_INTERVAL_MS);
  void pollApprovalUpdates();
}

export function stopApprovalPolling(): void {
  if (approvalPollTimer) {
    clearInterval(approvalPollTimer);
    approvalPollTimer = null;
  }
}
