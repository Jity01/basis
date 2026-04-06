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
  getChunkDurationMs,
  processBacklog,
  type ProcessBacklogProgress,
  readAISettings,
  writeAISettings,
  type AISettings,
  readChunkSettings,
  writeChunkSettings,
  writeChunkDurationMsForFile,
  type ChunkSettings,
  startHotBuffer,
  stopHotBuffer,
} from "@context-manager/core";
import { startIdleMonitor } from "./idle";
import type { ApprovalPayload, ApprovalSettings, ApprovalState, ApprovalRequest } from "./approvalTypes";
import { CONTEXT_ROOT, HOT_BUFFER_CONFIG, hotBufferDir } from "@context-manager/config";


function resolveOcrBinaryPath(): string | undefined {
  if (process.platform !== "darwin") {
    return undefined;
  }
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "ocr-bin", "ocr-helper");
  }
  return path.join(__dirname, "..", "resources", "ocr-bin", "ocr-helper");
}

let mainWindow: BrowserWindow | null = null;
let writeStream: fs.WriteStream | null = null;
let pendingWriteChain: Promise<void> = Promise.resolve();
let stopIdleMonitor: (() => void) | null = null;
let approvalPollTimer: ReturnType<typeof setInterval> | null = null;
let lastApprovalSnapshot = "";

const MCP_SERVER_HOST = process.env.MCP_SERVER_HOST?.trim() || "127.0.0.1";
const MCP_SERVER_PORT = Number(process.env.MCP_SERVER_PORT || 4821);
const APPROVAL_POLL_INTERVAL_MS = 2_000;
const TUNNEL_RESTART_DELAY_MS = 2_000;
const SETTINGS_FILE_NAME = "settings.json";
const CLOUDFLARED_URL_RE = /(https:\/\/[a-z0-9-]+\.trycloudflare\.com)/i;

function cloudflaredBinary(): string {
  return process.env.CONTEXT_MANAGER_CLOUDFLARED_BIN?.trim() || "cloudflared";
}

type ApprovalResolution = "approved" | "rejected";

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

type AISettingsUpdate = Partial<AISettings>;
type ChunkSettingsUpdate = Partial<ChunkSettings>;

type ProcessingTrigger = "idle" | "manual" | "live" | null;
type ProcessingStatus = {
  isProcessing: boolean;
  currentChunk: number;
  totalChunks: number;
  pendingChunks: number;
  visiblePendingChunks: number;
  activeRecordingChunk: boolean;
  trigger: ProcessingTrigger;
};

const processingState: ProcessingStatus = {
  isProcessing: false,
  currentChunk: 0,
  totalChunks: 0,
  pendingChunks: 0,
  visiblePendingChunks: 0,
  activeRecordingChunk: false,
  trigger: null,
};

let remoteAccessEnabled = false;
let remoteAccessStatus: RemoteAccessStatus = "disabled";
let remoteAccessPublicUrl: string | null = null;
let remoteAccessAuthToken: string | null = null;
let remoteAccessError: string | null = null;
let cloudflaredProcess: ChildProcess | null = null;
let cloudflaredRestartTimer: ReturnType<typeof setTimeout> | null = null;
let activeRecordingChunkDurationMs: number | null = null;

export function setMainWindow(win: BrowserWindow): void {
  mainWindow = win;
  ensureApprovalPolling();
  emitRemoteAccessState();
}

function countPendingChunks(): number {
  return getUnprocessedFiles().length;
}

function getActiveRecordingChunk(): boolean {
  return getCurrentFile() !== null;
}

function countVisiblePendingChunks(): number {
  return countPendingChunks() + (getActiveRecordingChunk() ? 1 : 0);
}

function emitProcessingStatus(): void {
  processingState.pendingChunks = countPendingChunks();
  processingState.visiblePendingChunks = countVisiblePendingChunks();
  processingState.activeRecordingChunk = getActiveRecordingChunk();
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
    const aiSettings = readAISettings();
    await processBacklog(getCurrentFile, shouldContinue, {
      onProgress: (progress) => {
        updateProgress(progress);
      },
      aiSettings,
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

function maybeStartLiveProcessing(): void {
  const aiSettings = readAISettings();
  if (aiSettings.provider !== "fireworks" || processingState.isProcessing || countPendingChunks() === 0) {
    return;
  }

  void runBacklog("live", () => true).catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[processing] live backlog failed: ${message}`);
  });
}

function waitForStreamFinish(stream: fs.WriteStream): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;

    const cleanup = () => {
      stream.removeListener("finish", onFinish);
      stream.removeListener("close", onClose);
      stream.removeListener("error", onError);
    };

    const settle = (callback: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };

    const onFinish = () => {
      settle(resolve);
    };

    const onClose = () => {
      settle(resolve);
    };

    const onError = (err: Error) => {
      settle(() => reject(err));
    };

    stream.once("finish", onFinish);
    stream.once("close", onClose);
    stream.once("error", onError);
  });
}

function writeChunkToStream(stream: fs.WriteStream, chunk: Buffer): Promise<void> {
  if (stream.destroyed || stream.writableEnded) {
    return Promise.reject(new Error("Recording file is already closing"));
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    let callbackDone = false;
    let drainDone = false;
    let needsDrain = false;

    const cleanup = () => {
      stream.removeListener("error", onError);
      stream.removeListener("drain", onDrain);
    };

    const settle = (callback: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };

    const maybeResolve = () => {
      if (!callbackDone) return;
      if (!needsDrain || drainDone) {
        settle(resolve);
      }
    };

    const onError = (err: Error) => {
      settle(() => reject(err));
    };

    const onDrain = () => {
      drainDone = true;
      maybeResolve();
    };

    stream.once("error", onError);
    needsDrain = !stream.write(chunk, (err?: Error | null) => {
      if (err) {
        settle(() => reject(err));
        return;
      }
      callbackDone = true;
      maybeResolve();
    });

    if (needsDrain) {
      stream.once("drain", onDrain);
      return;
    }

    drainDone = true;
  });
}

function enqueueChunkWrite(chunk: Buffer): Promise<void> {
  const priorWrites = pendingWriteChain.catch(() => {});
  const nextWrite = priorWrites.then(() => {
    if (!writeStream) {
      throw new Error("No active recording file");
    }
    return writeChunkToStream(writeStream, chunk);
  });
  pendingWriteChain = nextWrite;
  return nextWrite;
}

async function closeCurrentFile(): Promise<void> {
  const stream = writeStream;
  await pendingWriteChain.catch(() => {});
  if (!stream) {
    setCurrentFile(null);
    emitProcessingStatus();
    return;
  }

  writeStream = null;
  stream.end();
  await waitForStreamFinish(stream);
  setCurrentFile(null);
  emitProcessingStatus();
}

async function openNewFile(chunkDurationMs: number): Promise<string> {
  await closeCurrentFile();
  ensureTmpDir();
  const filePath = getNextRecordingPath();
  writeChunkDurationMsForFile(filePath, chunkDurationMs);
  writeStream = fs.createWriteStream(filePath);
  pendingWriteChain = Promise.resolve();
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
  const child = spawn(cloudflaredBinary(), ["tunnel", "--url", targetUrl, "--no-autoupdate"], {
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
    stopHotBuffer();
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
    const chunkDurationMs = getChunkDurationMs();
    activeRecordingChunkDurationMs = chunkDurationMs;
    const filePath = await openNewFile(chunkDurationMs);
    startHotBuffer({
      captureIntervalMs: HOT_BUFFER_CONFIG.captureIntervalMs,
      maxAgeMs: HOT_BUFFER_CONFIG.maxAgeMs,
      purgeIntervalMs: HOT_BUFFER_CONFIG.purgeIntervalMs,
      resolution: { ...HOT_BUFFER_CONFIG.resolution },
      jpegQuality: HOT_BUFFER_CONFIG.jpegQuality,
      hotbufferDir: hotBufferDir(CONTEXT_ROOT),
      ocrBinaryPath: resolveOcrBinaryPath(),
    });
    return { success: true, filePath };
  });

  ipcMain.handle("recording-chunk", async (_event, chunkPayload: unknown) => {
    const chunk = coerceChunkToBuffer(chunkPayload);
    if (!chunk) {
      throw new Error("Invalid recording chunk payload");
    }
    await enqueueChunkWrite(chunk);
  });

  ipcMain.handle("rotate-recording", async () => {
    const filePath = await openNewFile(activeRecordingChunkDurationMs ?? getChunkDurationMs());
    maybeStartLiveProcessing();
    emitProcessingStatus();
    return { filePath };
  });

  ipcMain.handle("stop-recording", async () => {
    activeRecordingChunkDurationMs = null;
    stopHotBuffer();
    await closeCurrentFile();
    maybeStartLiveProcessing();
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
    processingState.visiblePendingChunks = countVisiblePendingChunks();
    processingState.activeRecordingChunk = getActiveRecordingChunk();
    return { ...processingState };
  });

  ipcMain.handle("process-now", async () => {
    const started = await runBacklog("manual", () => true);
    return { started };
  });

  ipcMain.handle("get-chunk-duration-ms", () => {
    return getChunkDurationMs();
  });

  ipcMain.handle("get-chunk-settings", () => {
    return readChunkSettings();
  });

  ipcMain.handle("update-chunk-settings", (_event, payload: ChunkSettingsUpdate) => {
    return writeChunkSettings(payload || {});
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
    async (
      _event,
      payload: {
        requestId: string;
        resolution: ApprovalResolution;
        approvedPayload?: ApprovalPayload;
      }
    ) => {
      return await postApprovalResolution(payload.requestId, payload.resolution, payload.approvedPayload);
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

  ipcMain.handle("get-ai-settings", () => {
    return readAISettings();
  });

  ipcMain.handle("update-ai-settings", (_event, payload: AISettingsUpdate) => {
    return writeAISettings(payload || {});
  });

  ipcMain.handle("set-remote-access-enabled", async (_event, enabled: boolean) => {
    return await setRemoteAccessEnabled(Boolean(enabled));
  });
}