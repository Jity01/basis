import { app, ipcMain, desktopCapturer } from "electron";
import * as fs from "fs";
import * as path from "path";
import { spawn, type ChildProcess } from "child_process";
import type { BrowserWindow } from "electron";
import {
  ensureTmpDir,
  getNextRecordingPath,
  getUnprocessedFiles,
  getCurrentFile,
  setCurrentFile,
  CHUNK_DURATION_MS,
  processBacklog,
  type ProcessBacklogProgress,
} from "@context-manager/core";
import { startIdleMonitor } from "./idle";

let mainWindow: BrowserWindow | null = null;
let writeStream: fs.WriteStream | null = null;
let stopIdleMonitor: (() => void) | null = null;
let approvalPollTimer: ReturnType<typeof setInterval> | null = null;
let lastApprovalSnapshot = "";

const MCP_SERVER_HOST = process.env.MCP_SERVER_HOST?.trim() || "127.0.0.1";
const MCP_SERVER_PORT = Number(process.env.MCP_SERVER_PORT || 4821);
const APPROVAL_POLL_INTERVAL_MS = 2_000;
const TUNNEL_RESTART_DELAY_MS = 2_000;
const SETTINGS_FILE_NAME = "settings.json";
const CLOUDFLARED_URL_RE = /(https:\/\/[a-z0-9-]+\.trycloudflare\.com)/i;

type ApprovalResolution = "approved" | "rejected";
type ApprovalRequest = {
  id: string;
  createdAt: string;
  query: string;
  resultPreview: string;
  fullResult: string;
};
type ApprovalSettings = {
  autoApproveAllRequests: boolean;
  timeoutMs: number;
};
type ApprovalState = {
  pending: ApprovalRequest[];
  settings: ApprovalSettings;
};

type RemoteAccessStatus = "disabled" | "starting" | "connected" | "reconnecting" | "error";
type RemoteAccessSettings = {
  enableRemoteAccess: boolean;
};
type RemoteAccessState = {
  enabled: boolean;
  status: RemoteAccessStatus;
  publicUrl: string | null;
  authToken: string | null;
  error: string | null;
};

type ProcessingTrigger = "idle" | "manual" | null;
type ProcessingStatus = {
  isProcessing: boolean;
  currentChunk: number;
  totalChunks: number;
  pendingChunks: number;
  trigger: ProcessingTrigger;
};

const processingState: ProcessingStatus = {
  isProcessing: false,
  currentChunk: 0,
  totalChunks: 0,
  pendingChunks: 0,
  trigger: null,
};

let remoteAccessEnabled = false;
let remoteAccessStatus: RemoteAccessStatus = "disabled";
let remoteAccessPublicUrl: string | null = null;
let remoteAccessAuthToken: string | null = null;
let remoteAccessError: string | null = null;
let cloudflaredProcess: ChildProcess | null = null;
let cloudflaredRestartTimer: ReturnType<typeof setTimeout> | null = null;

export function setMainWindow(win: BrowserWindow): void {
  mainWindow = win;
  ensureApprovalPolling();
  emitRemoteAccessState();
}

function countPendingChunks(): number {
  return getUnprocessedFiles().length;
}

function emitProcessingStatus(): void {
  processingState.pendingChunks = countPendingChunks();
  if (mainWindow) {
    mainWindow.webContents.send("processing-status", { ...processingState });
  }
}

function updateProgress(progress: ProcessBacklogProgress): void {
  switch (progress.phase) {
    case "start":
      processingState.currentChunk = 0;
      processingState.totalChunks = progress.total;
      break;
    case "chunk-start":
      processingState.currentChunk = progress.completed + 1;
      processingState.totalChunks = progress.total;
      break;
    case "chunk-complete":
      processingState.currentChunk = progress.completed;
      processingState.totalChunks = progress.total;
      break;
    case "paused":
    case "done":
      processingState.currentChunk = progress.completed;
      processingState.totalChunks = progress.total;
      break;
  }
  emitProcessingStatus();
}

async function runBacklog(trigger: ProcessingTrigger, shouldContinue: () => boolean): Promise<boolean> {
  if (processingState.isProcessing) {
    return false;
  }

  const pending = countPendingChunks();
  if (pending === 0) {
    processingState.currentChunk = 0;
    processingState.totalChunks = 0;
    processingState.trigger = null;
    emitProcessingStatus();
    return false;
  }

  processingState.isProcessing = true;
  processingState.trigger = trigger;
  processingState.currentChunk = 0;
  processingState.totalChunks = pending;
  emitProcessingStatus();

  try {
    await processBacklog(getCurrentFile, shouldContinue, {
      onProgress: (progress) => {
        updateProgress(progress);
      },
    });
  } finally {
    processingState.isProcessing = false;
    processingState.trigger = null;
    processingState.currentChunk = 0;
    processingState.totalChunks = 0;
    emitProcessingStatus();
  }

  return true;
}

function closeCurrentFile(): void {
  if (writeStream) {
    writeStream.end();
    writeStream = null;
  }
  setCurrentFile(null);
  emitProcessingStatus();
}

function openNewFile(): string {
  closeCurrentFile();
  ensureTmpDir();
  const filePath = getNextRecordingPath();
  writeStream = fs.createWriteStream(filePath);
  setCurrentFile(filePath);
  emitProcessingStatus();
  return filePath;
}

function coerceChunkToBuffer(input: unknown): Buffer | null {
  if (Buffer.isBuffer(input)) {
    return input;
  }
  if (input instanceof Uint8Array) {
    return Buffer.from(input);
  }
  if (input instanceof ArrayBuffer) {
    return Buffer.from(new Uint8Array(input));
  }
  return null;
}

function mcpBaseUrl(): string {
  return `http://${MCP_SERVER_HOST}:${MCP_SERVER_PORT}`;
}

function getSettingsPath(): string {
  return path.join(app.getPath("userData"), SETTINGS_FILE_NAME);
}

function readRemoteAccessSettings(): RemoteAccessSettings {
  try {
    const raw = fs.readFileSync(getSettingsPath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<RemoteAccessSettings>;
    return {
      enableRemoteAccess: parsed.enableRemoteAccess === true,
    };
  } catch {
    return { enableRemoteAccess: false };
  }
}

function writeRemoteAccessSettings(settings: RemoteAccessSettings): void {
  const settingsPath = getSettingsPath();
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
}

function getRemoteAccessState(): RemoteAccessState {
  return {
    enabled: remoteAccessEnabled,
    status: remoteAccessStatus,
    publicUrl: remoteAccessPublicUrl,
    authToken: remoteAccessAuthToken,
    error: remoteAccessError,
  };
}

function emitRemoteAccessState(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }
  mainWindow.webContents.send("remote-access-state", getRemoteAccessState());
}

async function refreshRemoteAuthToken(): Promise<string | null> {
  try {
    const response = await fetch(`${mcpBaseUrl()}/auth/info`);
    if (!response.ok) {
      return null;
    }
    const body = (await response.json()) as { authToken?: unknown };
    remoteAccessAuthToken = typeof body.authToken === "string" ? body.authToken : null;
    emitRemoteAccessState();
    return remoteAccessAuthToken;
  } catch {
    return null;
  }
}

function applyRemoteAccessPatch(
  patch: Partial<Pick<RemoteAccessState, "status" | "publicUrl" | "error" | "enabled">>
): void {
  if (typeof patch.enabled === "boolean") {
    remoteAccessEnabled = patch.enabled;
  }
  if (patch.status) {
    remoteAccessStatus = patch.status;
  }
  if (patch.publicUrl !== undefined) {
    remoteAccessPublicUrl = patch.publicUrl;
  }
  if (patch.error !== undefined) {
    remoteAccessError = patch.error;
  }
  emitRemoteAccessState();
}

function parseCloudflaredUrl(output: string): string | null {
  const match = output.match(CLOUDFLARED_URL_RE);
  return match?.[1] || null;
}

function clearCloudflaredRestartTimer(): void {
  if (!cloudflaredRestartTimer) {
    return;
  }
  clearTimeout(cloudflaredRestartTimer);
  cloudflaredRestartTimer = null;
}

function stopCloudflaredTunnel(): void {
  clearCloudflaredRestartTimer();
  if (!cloudflaredProcess) {
    applyRemoteAccessPatch({
      status: "disabled",
      publicUrl: null,
      error: null,
    });
    return;
  }
  const proc = cloudflaredProcess;
  cloudflaredProcess = null;
  proc.removeAllListeners();
  proc.stdout?.removeAllListeners();
  proc.stderr?.removeAllListeners();
  proc.kill("SIGTERM");
  applyRemoteAccessPatch({
    status: "disabled",
    publicUrl: null,
    error: null,
  });
}

function startCloudflaredTunnel(): void {
  if (!remoteAccessEnabled || cloudflaredProcess) {
    return;
  }

  const restarting = remoteAccessStatus === "connected" || remoteAccessStatus === "reconnecting";
  applyRemoteAccessPatch({
    status: restarting ? "reconnecting" : "starting",
    publicUrl: null,
    error: null,
  });

  const targetUrl = `http://${MCP_SERVER_HOST}:${MCP_SERVER_PORT}`;
  const child = spawn("cloudflared", ["tunnel", "--url", targetUrl, "--no-autoupdate"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  cloudflaredProcess = child;

  const handleOutput = (chunk: Buffer): void => {
    const text = String(chunk);
    const url = parseCloudflaredUrl(text);
    if (!url) {
      return;
    }
    applyRemoteAccessPatch({
      status: "connected",
      publicUrl: url,
      error: null,
    });
  };

  child.stdout?.on("data", handleOutput);
  child.stderr?.on("data", handleOutput);

  child.on("error", (err) => {
    cloudflaredProcess = null;
    applyRemoteAccessPatch({
      status: "error",
      publicUrl: null,
      error: err.message || "Failed to start cloudflared.",
    });
  });

  child.on("exit", () => {
    cloudflaredProcess = null;
    if (!remoteAccessEnabled) {
      applyRemoteAccessPatch({
        status: "disabled",
        publicUrl: null,
        error: null,
      });
      return;
    }
    applyRemoteAccessPatch({
      status: "reconnecting",
      publicUrl: null,
      error: "Tunnel disconnected. Restarting...",
    });
    clearCloudflaredRestartTimer();
    cloudflaredRestartTimer = setTimeout(() => {
      cloudflaredRestartTimer = null;
      startCloudflaredTunnel();
    }, TUNNEL_RESTART_DELAY_MS);
  });
}

async function setRemoteAccessEnabled(nextEnabled: boolean): Promise<RemoteAccessState> {
  remoteAccessEnabled = nextEnabled;
  writeRemoteAccessSettings({ enableRemoteAccess: nextEnabled });
  await refreshRemoteAuthToken();
  emitRemoteAccessState();
  if (nextEnabled) {
    startCloudflaredTunnel();
  } else {
    stopCloudflaredTunnel();
  }
  return getRemoteAccessState();
}

async function fetchApprovalState(): Promise<ApprovalState> {
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

async function postApprovalResolution(
  requestId: string,
  resolution: ApprovalResolution
): Promise<{ ok: boolean }> {
  const response = await fetch(`${mcpBaseUrl()}/approvals/${encodeURIComponent(requestId)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ resolution }),
  });
  if (!response.ok) {
    throw new Error(`Failed resolving approval (${response.status}).`);
  }
  return (await response.json()) as { ok: boolean };
}

async function postApproveAll(): Promise<{ ok: boolean; resolvedCount: number }> {
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

async function postApprovalSettings(settings: Partial<ApprovalSettings>): Promise<ApprovalSettings> {
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

function ensureApprovalPolling(): void {
  if (approvalPollTimer) {
    return;
  }
  approvalPollTimer = setInterval(() => {
    void pollApprovalUpdates();
  }, APPROVAL_POLL_INTERVAL_MS);
  void pollApprovalUpdates();
}

async function pollApprovalUpdates(): Promise<void> {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }
  try {
    const state = await fetchApprovalState();
    const nextSnapshot = JSON.stringify(state);
    if (nextSnapshot === lastApprovalSnapshot) {
      return;
    }
    lastApprovalSnapshot = nextSnapshot;
    mainWindow.webContents.send("approval-state", state);
  } catch {
    // MCP server may be unavailable during startup; ignore and retry.
  }
}

export function setupIpc(): void {
  app.once("before-quit", () => {
    remoteAccessEnabled = false;
    stopCloudflaredTunnel();
  });

  const settings = readRemoteAccessSettings();
  remoteAccessEnabled = settings.enableRemoteAccess;
  remoteAccessStatus = remoteAccessEnabled ? "starting" : "disabled";
  remoteAccessPublicUrl = null;
  remoteAccessError = null;
  void refreshRemoteAuthToken().finally(() => {
    emitRemoteAccessState();
    if (remoteAccessEnabled) {
      startCloudflaredTunnel();
    }
  });

  if (!stopIdleMonitor) {
    stopIdleMonitor = startIdleMonitor({
      hasUnprocessedFiles: () => countPendingChunks() > 0,
      isProcessing: () => processingState.isProcessing,
      processWhileIdle: async (shouldContinue) => {
        await runBacklog("idle", shouldContinue);
      },
    });
  }

  ipcMain.handle("start-recording", async () => {
    const filePath = openNewFile();
    return { success: true, filePath };
  });

  ipcMain.on("recording-chunk", (_event, chunkPayload: unknown) => {
    const chunk = coerceChunkToBuffer(chunkPayload);
    if (!chunk || !writeStream) {
      return;
    }
    writeStream.write(chunk);
  });

  ipcMain.handle("rotate-recording", async () => {
    const filePath = openNewFile();
    emitProcessingStatus();
    return { filePath };
  });

  ipcMain.handle("stop-recording", async () => {
    closeCurrentFile();
    return { success: true };
  });

  ipcMain.handle("get-current-file", () => {
    return getCurrentFile();
  });

  ipcMain.handle("get-unprocessed-files", () => {
    return getUnprocessedFiles();
  });

  ipcMain.handle("get-processing-status", () => {
    processingState.pendingChunks = countPendingChunks();
    return { ...processingState };
  });

  ipcMain.handle("process-now", async () => {
    const started = await runBacklog("manual", () => true);
    return { started };
  });

  ipcMain.handle("get-chunk-duration-ms", () => {
    return CHUNK_DURATION_MS;
  });

  ipcMain.handle(
    "get-desktop-sources",
    (_event, opts: { types: ("screen" | "window")[] }) =>
      desktopCapturer.getSources(opts)
  );

  ipcMain.handle("get-approval-state", async () => {
    return await fetchApprovalState();
  });

  ipcMain.handle(
    "resolve-approval",
    async (_event, payload: { requestId: string; resolution: ApprovalResolution }) => {
      return await postApprovalResolution(payload.requestId, payload.resolution);
    }
  );

  ipcMain.handle("approve-all-requests", async () => {
    return await postApproveAll();
  });

  ipcMain.handle(
    "update-approval-settings",
    async (_event, payload: Partial<ApprovalSettings>) => await postApprovalSettings(payload)
  );

  ipcMain.handle("get-remote-access-state", async () => {
    await refreshRemoteAuthToken();
    return getRemoteAccessState();
  });

  ipcMain.handle("set-remote-access-enabled", async (_event, enabled: boolean) => {
    return await setRemoteAccessEnabled(Boolean(enabled));
  });
}