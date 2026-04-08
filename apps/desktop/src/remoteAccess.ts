import * as fs from "fs";
import * as path from "path";
import { spawn, type ChildProcess } from "child_process";
import { BASIS_ROOT } from "@context-manager/config";
import type { RemoteAccessStatus, RemoteAccessState } from "@context-manager/config";
import { sendToRenderer } from "./mainWindowRef";

type RemoteAccessSettings = {
  enableRemoteAccess: boolean;
};

const MCP_SERVER_HOST = process.env.MCP_SERVER_HOST?.trim() || "127.0.0.1";
const MCP_SERVER_PORT = Number(process.env.MCP_SERVER_PORT || 4821);
const TUNNEL_RESTART_DELAY_MS = 2_000;
const SETTINGS_FILE_NAME = "settings.json";
const CLOUDFLARED_URL_RE = /(https:\/\/[a-z0-9-]+\.trycloudflare\.com)/i;

let remoteAccessEnabled = false;
let remoteAccessStatus: RemoteAccessStatus = "disabled";
let remoteAccessPublicUrl: string | null = null;
let remoteAccessAuthToken: string | null = null;
let remoteAccessError: string | null = null;
let cloudflaredProcess: ChildProcess | null = null;
let cloudflaredRestartTimer: ReturnType<typeof setTimeout> | null = null;

function cloudflaredBinary(): string {
  return process.env.CONTEXT_MANAGER_CLOUDFLARED_BIN?.trim() || "cloudflared";
}

function getSettingsPath(): string {
  return path.join(BASIS_ROOT, SETTINGS_FILE_NAME);
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

export function getRemoteAccessState(): RemoteAccessState {
  return {
    enabled: remoteAccessEnabled,
    status: remoteAccessStatus,
    publicUrl: remoteAccessPublicUrl,
    authToken: remoteAccessAuthToken,
    error: remoteAccessError,
  };
}

export function emitRemoteAccessState(): void {
  sendToRenderer("remote-access-state", getRemoteAccessState());
}

export async function refreshRemoteAuthToken(): Promise<string | null> {
  try {
    const response = await fetch(`http://${MCP_SERVER_HOST}:${MCP_SERVER_PORT}/auth/info`);
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

export function stopCloudflaredTunnel(): void {
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

export async function setRemoteAccessEnabled(nextEnabled: boolean): Promise<RemoteAccessState> {
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

export function initRemoteAccess(): void {
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
}

export function teardownRemoteAccess(): void {
  remoteAccessEnabled = false;
  stopCloudflaredTunnel();
}
