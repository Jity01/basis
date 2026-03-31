import { randomUUID } from "crypto";

export type ApprovalStatus = "approved" | "rejected" | "timeout";
export type ApprovalResolution = "approved" | "rejected";

export type ApprovalRequest = {
  id: string;
  createdAt: string;
  query: string;
  resultPreview: string;
  fullResult: string;
};

type PendingApproval = {
  request: ApprovalRequest;
  resolve: (status: ApprovalStatus) => void;
  timeout: NodeJS.Timeout;
};

type ApprovalListener = (request: ApprovalRequest) => void;
type ElectronIpcSender = (channel: string, payload: unknown) => void;

const pendingRequests = new Map<string, PendingApproval>();
const listeners = new Set<ApprovalListener>();
let electronIpcSender: ElectronIpcSender | null = null;

export type ApprovalSettings = {
  autoApproveAllRequests: boolean;
  timeoutMs: number;
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

export function resolveApproval(id: string, resolution: ApprovalResolution): boolean {
  const pending = pendingRequests.get(id);
  if (!pending) {
    return false;
  }
  clearTimeout(pending.timeout);
  pendingRequests.delete(id);
  pending.resolve(resolution);
  return true;
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

export async function requestApproval(
  query: string,
  fullResult: string
): Promise<{ status: ApprovalStatus; requestId: string }> {
  const requestId = randomUUID();

  // for the lucky ones
  if (approvalSettings.autoApproveAllRequests) {
    return { status: "approved", requestId };
  }

  const preview =
    fullResult.length > 500 ? `${fullResult.slice(0, 500)}\n...(truncated preview)` : fullResult;

  const request: ApprovalRequest = {
    id: requestId,
    createdAt: new Date().toISOString(),
    query,
    fullResult,
    resultPreview: preview,
  };

  return await new Promise<{ status: ApprovalStatus; requestId: string }>((resolve) => {
    const timeout = setTimeout(() => {
      pendingRequests.delete(requestId);
      resolve({ status: "timeout", requestId });
    }, approvalSettings.timeoutMs);

    pendingRequests.set(requestId, {
      request,
      timeout,
      resolve: (status) => {
        resolve({ status, requestId });
      },
    });

    notifyListeners(request);
  });
}
