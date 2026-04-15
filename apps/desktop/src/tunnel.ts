import { spawn, ChildProcess } from "child_process";
import * as path from "path";
import * as fs from "fs";
import {
  BASIS_ROOT,
  readCredentials,
  writeCredentials,
} from "@context-manager/config";
import type { RemoteAccessState } from "@context-manager/config";

let tunnelProcess: ChildProcess | null = null;
let currentState: RemoteAccessState = {
  enabled: false,
  status: "disabled",
  publicUrl: null,
  authToken: null,
  error: null,
};

// Callback for state changes (wired by ipcHandlers)
let onStateChange: ((state: RemoteAccessState) => void) | null = null;

// ── Internal helpers ──────────────────────────────────────────────────────────

const DEFAULT_MCP_PROXY_URL = "https://mcp.vizlog.ai";

function updateState(patch: Partial<RemoteAccessState>): void {
  currentState = { ...currentState, ...patch };
  if (onStateChange) {
    onStateChange(currentState);
  }
}

function resolveCloudflaredBin(): string {
  const envPath = process.env.CONTEXT_MANAGER_CLOUDFLARED_BIN;
  if (envPath && fs.existsSync(envPath)) {
    return envPath;
  }
  // Fall back to cloudflared on PATH
  return "cloudflared";
}

function getMcpProxyUrl(): string {
  return process.env.VIZLOG_MCP_PROXY_URL?.trim() || DEFAULT_MCP_PROXY_URL;
}

function hasLocalTunnelCredentialsFile(): boolean {
  try {
    const raw = fs.readFileSync(getTunnelCredentialsPath(), "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return (
      typeof parsed.AccountTag === "string" &&
      typeof parsed.TunnelID === "string" &&
      typeof parsed.TunnelSecret === "string"
    );
  } catch {
    return false;
  }
}

function getTunnelCredentialsPath(): string {
  return path.join(BASIS_ROOT, "tunnel-credentials.json");
}

function writeTunnelCredentialsFile(credentials: {
  AccountTag: string;
  TunnelID: string;
  TunnelSecret: string;
}): void {
  fs.mkdirSync(BASIS_ROOT, { recursive: true });
  fs.writeFileSync(getTunnelCredentialsPath(), `${JSON.stringify(credentials, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

type TunnelProvisionResponse = {
  tunnelId: string;
  credentials: {
    AccountTag: string;
    TunnelID: string;
    TunnelSecret: string;
  };
  hostname: string;
};

export async function provisionTunnelCredentials(): Promise<{ success: boolean; error?: string }> {
  const creds = readCredentials();
  if (!creds?.authToken) {
    return { success: false, error: "No credentials found. Sign in to vizlog.ai first." };
  }

  let response: Response;
  try {
    response = await fetch(`${getMcpProxyUrl()}/tunnel/provision`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${creds.authToken}`,
      },
    });
  } catch {
    return { success: false, error: "Failed to reach tunnel provisioning service." };
  }

  if (!response.ok) {
    let message = `Tunnel provisioning failed (${response.status}).`;
    try {
      const body = (await response.json()) as { error?: string };
      if (body?.error) message = body.error;
    } catch {
      // Keep default message.
    }
    return { success: false, error: message };
  }

  const body = (await response.json()) as TunnelProvisionResponse;
  if (!body?.credentials?.TunnelID || !body?.credentials?.TunnelSecret || !body?.credentials?.AccountTag) {
    return { success: false, error: "Provisioning response was missing tunnel credentials." };
  }

  try {
    writeTunnelCredentialsFile(body.credentials);
    if (body.tunnelId && body.tunnelId !== creds.tunnelId) {
      writeCredentials({ ...creds, tunnelId: body.tunnelId });
    }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : "Failed to persist tunnel credentials.",
    };
  }

  return { success: true };
}

function writeTunnelConfig(tunnelId: string): string {
  const configPath = path.join(BASIS_ROOT, "tunnel-config.yml");
  const credentialsPath = path.join(BASIS_ROOT, "tunnel-credentials.json");

  const yaml = [
    `tunnel: ${tunnelId}`,
    `credentials-file: ${credentialsPath}`,
    `ingress:`,
    `  - hostname: ${tunnelId}.tunnels.vizlog.ai`,
    `    service: http://127.0.0.1:3847`,
    `  - service: http_status:404`,
    "",
  ].join("\n");

  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, yaml, "utf8");
  return configPath;
}

// ── Public API ────────────────────────────────────────────────────────────────

export function setTunnelStateListener(listener: (state: RemoteAccessState) => void): void {
  onStateChange = listener;
}

export function getTunnelState(): RemoteAccessState {
  return { ...currentState };
}

export async function startTunnel(): Promise<RemoteAccessState> {
  if (tunnelProcess) {
    return getTunnelState();
  }

  // 1. Read credentials
  const creds = readCredentials();
  if (!creds) {
    updateState({
      enabled: false,
      status: "error",
      error: "No credentials found. Sign in to vizlog.ai first.",
    });
    return getTunnelState();
  }

  const { authToken, tunnelId } = creds;
  if (!tunnelId) {
    updateState({
      enabled: false,
      status: "error",
      error: "No tunnel ID in credentials. Re-authenticate with vizlog.ai.",
    });
    return getTunnelState();
  }

  // 2. Ensure tunnel credentials file exists (auto-provision when missing)
  const tunnelCredsPath = getTunnelCredentialsPath();
  if (!hasLocalTunnelCredentialsFile()) {
    console.warn("[tunnel] Tunnel credentials file missing, provisioning:", tunnelCredsPath);
    const provision = await provisionTunnelCredentials();
    if (!provision.success) {
      updateState({
        enabled: false,
        status: "error",
        error: provision.error || "Tunnel credentials file not found. Provisioning failed.",
      });
      return getTunnelState();
    }
  }

  // 3. Write tunnel config
  const configPath = writeTunnelConfig(tunnelId);
  const cloudflaredBin = resolveCloudflaredBin();

  updateState({
    enabled: true,
    status: "starting",
    publicUrl: `https://${tunnelId}.tunnels.vizlog.ai`,
    authToken,
    error: null,
  });

  // 4. Spawn cloudflared
  const args = ["tunnel", "--no-autoupdate", "--config", configPath, "run"];
  console.log("[tunnel] Starting:", cloudflaredBin, args.join(" "));

  const proc = spawn(cloudflaredBin, args, {
    stdio: ["ignore", "pipe", "pipe"],
  });

  tunnelProcess = proc;

  // 5. Monitor stderr for connection status
  proc.stderr?.on("data", (data: Buffer) => {
    const line = data.toString("utf8");
    process.stderr.write(`[cloudflared] ${line}`);

    if (/connection.*registered/i.test(line)) {
      updateState({ status: "connected", error: null });
    } else if (/retrying|reconnect/i.test(line)) {
      updateState({ status: "reconnecting", error: null });
    }
  });

  proc.stdout?.on("data", (data: Buffer) => {
    process.stdout.write(`[cloudflared] ${data.toString("utf8")}`);
  });

  proc.on("error", (err) => {
    console.error("[tunnel] Failed to start cloudflared:", err.message);
    tunnelProcess = null;
    updateState({
      enabled: false,
      status: "error",
      error: `Failed to start cloudflared: ${err.message}`,
    });
  });

  proc.on("exit", (code, signal) => {
    console.log("[tunnel] cloudflared exited:", { code, signal });
    tunnelProcess = null;

    // Don't overwrite state if we already set it to disabled (intentional stop)
    if (currentState.status !== "disabled") {
      updateState({
        enabled: false,
        status: code === 0 ? "disabled" : "error",
        error: code !== 0 ? `cloudflared exited with code ${code}` : null,
      });
    }
  });

  return getTunnelState();
}

export async function stopTunnel(): Promise<void> {
  const proc = tunnelProcess;
  if (!proc) {
    updateState({
      enabled: false,
      status: "disabled",
      publicUrl: null,
      authToken: null,
      error: null,
    });
    return;
  }

  updateState({
    enabled: false,
    status: "disabled",
    publicUrl: null,
    authToken: null,
    error: null,
  });

  tunnelProcess = null;
  proc.kill("SIGTERM");

  // Give it a moment to exit gracefully, then force-kill
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      if (!proc.killed) {
        proc.kill("SIGKILL");
      }
      resolve();
    }, 5_000);

    proc.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

export function isTunnelRunning(): boolean {
  return tunnelProcess !== null && !tunnelProcess.killed;
}
