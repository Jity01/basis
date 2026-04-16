import { spawn, ChildProcess } from "child_process";
import * as path from "path";
import * as fs from "fs";
import { app } from "electron";
import * as net from "net";
import * as dns from "dns";
import {
  BASIS_ROOT,
  readCredentials,
  writeCredentials,
} from "@context-manager/config";
import type { RemoteAccessState } from "@context-manager/config";

let tunnelProcess: ChildProcess | null = null;
let mcpHttpProcess: ChildProcess | null = null;
let mcpHttpManaged = false;
let quickStartAttemptCount = 0;
let suppressExitStateForProcess: ChildProcess | null = null;
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

const DEFAULT_MCP_PROXY_URL = "https://vizlog-mcp-proxy.vizlog.workers.dev";
const DEFAULT_AUTH_API_URL = "https://vizlog-auth.vizlog.workers.dev";
const DEFAULT_TUNNEL_DOMAIN = "vizlog.ai";
const MCP_HTTP_PORT = 3847;

type TunnelMode = "quick" | "named";

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

function resolveMcpServerScriptPath(): string {
  const packaged = Boolean((app as unknown as { isPackaged?: boolean })?.isPackaged);
  if (packaged) {
    return path.join(process.resourcesPath, "mcp-server", "dist", "server.js");
  }
  return path.join(__dirname, "..", "..", "mcp_server", "dist", "server.js");
}

function normalizeTunnelLabel(tunnelId: string): string {
  const label = tunnelId
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  if (!label) {
    throw new Error("Invalid tunnel ID for DNS hostname.");
  }
  return label;
}

function getTunnelHostname(tunnelId: string): string {
  return `${normalizeTunnelLabel(tunnelId)}.${getTunnelDomain()}`;
}

function doesHostnameResolve(hostname: string): Promise<boolean> {
  return new Promise((resolve) => {
    dns.lookup(hostname, (err) => {
      resolve(!err);
    });
  });
}

function isPortListening(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    socket.setTimeout(500);
    socket.on("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.on("timeout", () => {
      socket.destroy();
      resolve(false);
    });
    socket.on("error", () => {
      resolve(false);
    });
  });
}

async function waitForPort(host: string, port: number, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await isPortListening(host, port)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return false;
}

async function ensureLocalMcpHttpServer(): Promise<void> {
  if (await isPortListening("127.0.0.1", MCP_HTTP_PORT)) {
    return;
  }

  const scriptPath = resolveMcpServerScriptPath();
  const proc = spawn("node", [scriptPath, "--http", "--port", String(MCP_HTTP_PORT)], {
    stdio: ["ignore", "pipe", "pipe"],
  });

  mcpHttpProcess = proc;
  mcpHttpManaged = true;

  proc.stdout?.on("data", (data: Buffer) => {
    process.stdout.write(`[mcp-http] ${data.toString("utf8")}`);
  });

  proc.stderr?.on("data", (data: Buffer) => {
    process.stderr.write(`[mcp-http] ${data.toString("utf8")}`);
  });

  const started = await waitForPort("127.0.0.1", MCP_HTTP_PORT, 7000);
  if (started) {
    return;
  }

  const exitCode = await new Promise<number | null>((resolve) => {
    proc.once("exit", (code) => resolve(code));
    setTimeout(() => resolve(null), 500);
  });

  if (proc && !proc.killed) {
    proc.kill("SIGTERM");
  }
  mcpHttpProcess = null;
  mcpHttpManaged = false;
  throw new Error(`Failed to start local MCP HTTP service on port ${MCP_HTTP_PORT}${exitCode !== null ? ` (exit ${exitCode})` : ""}.`);
}

async function stopLocalMcpHttpServer(): Promise<void> {
  const proc = mcpHttpProcess;
  if (!proc || !mcpHttpManaged) {
    mcpHttpProcess = null;
    mcpHttpManaged = false;
    return;
  }

  mcpHttpProcess = null;
  mcpHttpManaged = false;
  proc.kill("SIGTERM");

  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      if (!proc.killed) {
        proc.kill("SIGKILL");
      }
      resolve();
    }, 3_000);

    proc.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

async function terminateProcess(proc: ChildProcess, timeoutMs = 5_000): Promise<void> {
  if (proc.killed) {
    return;
  }

  proc.kill("SIGTERM");

  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      if (!proc.killed) {
        proc.kill("SIGKILL");
      }
      resolve();
    }, timeoutMs);

    proc.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

function getMcpProxyUrl(): string {
  return process.env.VIZLOG_MCP_PROXY_URL?.trim() || DEFAULT_MCP_PROXY_URL;
}

function getAuthApiUrl(): string {
  return process.env.VIZLOG_AUTH_API_URL?.trim() || DEFAULT_AUTH_API_URL;
}

function getTunnelDomain(): string {
  return process.env.VIZLOG_TUNNEL_DOMAIN?.trim() || DEFAULT_TUNNEL_DOMAIN;
}

function getTunnelMode(): TunnelMode {
  return process.env.VIZLOG_TUNNEL_MODE?.trim().toLowerCase() === "quick" ? "quick" : "named";
}

async function waitForQuickTunnelReady(endpointUrl: string, timeoutMs: number): Promise<boolean> {
  const started = Date.now();
  const probeUrl = `${endpointUrl.replace(/\/+$/, "")}/mcp`;

  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(probeUrl, {
        method: "GET",
        redirect: "manual",
      });
      if (response.status === 400 || response.status === 401) {
        return true;
      }
    } catch {
      // ignore transient DNS/bootstrap errors while tunnel endpoint propagates
    }

    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  return false;
}

async function registerTunnelEndpoint(
  authToken: string,
  endpointUrl: string | null,
): Promise<{ success: boolean; error?: string }> {
  let response: Response;
  try {
    response = await fetch(`${getAuthApiUrl()}/auth/tunnel-endpoint`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${authToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ endpointUrl }),
    });
  } catch {
    return { success: false, error: "Failed to register tunnel endpoint with auth service." };
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    return {
      success: false,
      error: `Tunnel endpoint registration failed (${response.status})${text ? `: ${text.slice(0, 200)}` : ""}`,
    };
  }

  return { success: true };
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
  if (getTunnelMode() === "quick") {
    return { success: true };
  }

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
  const hostname = getTunnelHostname(tunnelId);

  const yaml = [
    `tunnel: ${tunnelId}`,
    `credentials-file: ${credentialsPath}`,
    `ingress:`,
    `  - hostname: ${hostname}`,
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

  const tunnelMode = getTunnelMode();
  if (tunnelMode === "quick") {
    quickStartAttemptCount += 1;
  } else {
    quickStartAttemptCount = 0;
  }

  const maybeRetryQuickStart = async (reason: string, proc?: ChildProcess): Promise<RemoteAccessState | null> => {
    if (tunnelMode !== "quick") {
      return null;
    }

    if (proc) {
      suppressExitStateForProcess = proc;
      if (tunnelProcess === proc) {
        tunnelProcess = null;
      }
      await terminateProcess(proc);
    }

    if (quickStartAttemptCount < 4) {
      console.warn(`[tunnel] quick tunnel attempt ${quickStartAttemptCount} failed: ${reason}. Retrying...`);
      return startTunnel();
    }

    quickStartAttemptCount = 0;
    updateState({
      enabled: false,
      status: "error",
      error: reason,
    });
    return getTunnelState();
  };

  // 1. Read credentials
  const creds = readCredentials();
  if (!creds) {
    quickStartAttemptCount = 0;
    updateState({
      enabled: false,
      status: "error",
      error: "No credentials found. Sign in to vizlog.ai first.",
    });
    return getTunnelState();
  }

  const { authToken, tunnelId } = creds;
  if (tunnelMode === "named" && !tunnelId) {
    quickStartAttemptCount = 0;
    updateState({
      enabled: false,
      status: "error",
      error: "No tunnel ID in credentials. Re-authenticate with vizlog.ai.",
    });
    return getTunnelState();
  }

  // 2. Ensure named tunnel credentials are provisioned when required.
  if (tunnelMode === "named") {
    const tunnelCredsPath = getTunnelCredentialsPath();
    const tunnelHostname = getTunnelHostname(tunnelId!);
    const hostResolves = await doesHostnameResolve(tunnelHostname);
    if (!hasLocalTunnelCredentialsFile() || !hostResolves) {
      console.warn("[tunnel] Tunnel credentials file missing, provisioning:", tunnelCredsPath);
      const provision = await provisionTunnelCredentials();
      if (!provision.success) {
        quickStartAttemptCount = 0;
        updateState({
          enabled: false,
          status: "error",
          error: provision.error || "Tunnel credentials file not found. Provisioning failed.",
        });
        return getTunnelState();
      }
    }
  }

  // 3. Ensure local MCP HTTP service is online.
  try {
    await ensureLocalMcpHttpServer();
  } catch (err) {
    quickStartAttemptCount = 0;
    updateState({
      enabled: false,
      status: "error",
      error: err instanceof Error ? err.message : "Failed to start local MCP service.",
    });
    return getTunnelState();
  }

  const cloudflaredBin = resolveCloudflaredBin();
  const tunnelPublicUrl = tunnelMode === "named" && tunnelId ? `https://${getTunnelHostname(tunnelId)}` : null;

  updateState({
    enabled: true,
    status: "starting",
    publicUrl: tunnelPublicUrl,
    authToken,
    error: null,
  });

  // 4. Spawn cloudflared in named or quick mode.
  const args =
    tunnelMode === "named"
      ? ["tunnel", "--no-autoupdate", "--config", writeTunnelConfig(tunnelId!), "run"]
      : ["tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${MCP_HTTP_PORT}`];
  console.log("[tunnel] Starting:", cloudflaredBin, args.join(" "));

  const proc = spawn(cloudflaredBin, args, {
    stdio: ["ignore", "pipe", "pipe"],
  });

  tunnelProcess = proc;

  let quickTunnelResolve: ((url: string) => void) | null = null;
  let quickTunnelReject: ((err: Error) => void) | null = null;
  let namedTunnelResolve: (() => void) | null = null;
  let namedTunnelReject: ((err: Error) => void) | null = null;
  const namedTunnelReadyPromise =
    tunnelMode === "named"
      ? new Promise<void>((resolve, reject) => {
          namedTunnelResolve = resolve;
          namedTunnelReject = reject;
        })
      : null;

  const quickTunnelUrlPromise =
    tunnelMode === "quick"
      ? new Promise<string>((resolve, reject) => {
          quickTunnelResolve = resolve;
          quickTunnelReject = reject;
        })
      : null;

  let quickTunnelUrl: string | null = null;
  const maybeCaptureQuickUrl = (chunk: string) => {
    if (tunnelMode !== "quick" || quickTunnelUrl) {
      return;
    }
    const match = chunk.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
    if (!match) {
      return;
    }
    quickTunnelUrl = match[0].replace(/\/+$/, "");
    quickTunnelResolve?.(quickTunnelUrl);
    quickTunnelResolve = null;
    quickTunnelReject = null;
  };

  const handleCloudflaredOutput = (chunk: string, source: "stdout" | "stderr") => {
    const line = chunk.toString();
    if (source === "stderr") {
      process.stderr.write(`[cloudflared] ${line}`);
    } else {
      process.stdout.write(`[cloudflared] ${line}`);
    }

    maybeCaptureQuickUrl(line);

    if (/registered tunnel connection|connection.*registered/i.test(line)) {
      if (tunnelMode !== "quick") {
        updateState({ status: "connected", error: null });
        namedTunnelResolve?.();
        namedTunnelResolve = null;
        namedTunnelReject = null;
      }
    } else if (/retrying|reconnect/i.test(line)) {
      updateState({ status: "reconnecting", error: null });
    }
  };

  proc.stderr?.on("data", (data: Buffer) => {
    handleCloudflaredOutput(data.toString("utf8"), "stderr");
  });

  proc.stdout?.on("data", (data: Buffer) => {
    handleCloudflaredOutput(data.toString("utf8"), "stdout");
  });

  proc.on("error", (err) => {
    console.error("[tunnel] Failed to start cloudflared:", err.message);
    quickTunnelReject?.(new Error(err.message));
    quickTunnelResolve = null;
    quickTunnelReject = null;

    if (tunnelMode === "quick") {
      void maybeRetryQuickStart(`Failed to start cloudflared: ${err.message}`, proc);
      return;
    }

    namedTunnelReject?.(new Error(`Failed to start cloudflared: ${err.message}`));
    namedTunnelResolve = null;
    namedTunnelReject = null;

    quickStartAttemptCount = 0;
    tunnelProcess = null;
    void stopLocalMcpHttpServer();
    updateState({
      enabled: false,
      status: "error",
      error: `Failed to start cloudflared: ${err.message}`,
    });
  });

  proc.on("exit", (code, signal) => {
    if (suppressExitStateForProcess === proc) {
      suppressExitStateForProcess = null;
      return;
    }

    console.log("[tunnel] cloudflared exited:", { code, signal });
    quickTunnelReject?.(new Error(`cloudflared exited with code ${code}`));
    quickTunnelResolve = null;
    quickTunnelReject = null;
    namedTunnelReject?.(new Error(`cloudflared exited with code ${code}`));
    namedTunnelResolve = null;
    namedTunnelReject = null;
    quickStartAttemptCount = 0;
    tunnelProcess = null;
    if (tunnelMode === "quick" && authToken) {
      void registerTunnelEndpoint(authToken, null);
    }

    // Don't overwrite state if we already set it to disabled (intentional stop)
    if (currentState.status !== "disabled") {
      void stopLocalMcpHttpServer();
      updateState({
        enabled: false,
        status: code === 0 ? "disabled" : "error",
        error: code !== 0 ? `cloudflared exited with code ${code}` : null,
      });
    }
  });

  if (tunnelMode === "quick" && quickTunnelUrlPromise) {
    let discoveredUrl: string;
    try {
      discoveredUrl = await Promise.race([
        quickTunnelUrlPromise,
        new Promise<string>((_, reject) =>
          setTimeout(() => reject(new Error("Timed out waiting for cloudflared quick tunnel URL.")), 20_000),
        ),
      ]);
    } catch (err) {
      const reason = err instanceof Error ? err.message : "Failed to establish quick tunnel.";
      const retryState = await maybeRetryQuickStart(reason, proc);
      if (retryState) {
        return retryState;
      }
      quickStartAttemptCount = 0;
      updateState({ enabled: false, status: "error", error: reason });
      return getTunnelState();
    }

    const ready = await waitForQuickTunnelReady(discoveredUrl, 45_000);
    if (!ready) {
      const retryState = await maybeRetryQuickStart("Quick tunnel URL did not become reachable in time.", proc);
      if (retryState) {
        return retryState;
      }
      quickStartAttemptCount = 0;
      updateState({ enabled: false, status: "error", error: "Quick tunnel URL did not become reachable in time." });
      return getTunnelState();
    }

    const registration = await registerTunnelEndpoint(authToken, discoveredUrl);
    if (!registration.success) {
      suppressExitStateForProcess = proc;
      if (tunnelProcess === proc) {
        tunnelProcess = null;
      }
      await terminateProcess(proc);
      quickStartAttemptCount = 0;
      updateState({
        enabled: false,
        status: "error",
        error: registration.error || "Failed to register quick tunnel endpoint.",
      });
      return getTunnelState();
    }

    updateState({
      enabled: true,
      status: "connected",
      publicUrl: discoveredUrl,
      authToken,
      error: null,
    });
    quickStartAttemptCount = 0;
  }

  if (tunnelMode === "named" && namedTunnelReadyPromise) {
    try {
      await Promise.race([
        namedTunnelReadyPromise,
        new Promise<void>((_, reject) =>
          setTimeout(() => reject(new Error("Timed out waiting for cloudflared tunnel connection.")), 20_000),
        ),
      ]);
    } catch (err) {
      if (tunnelProcess) {
        suppressExitStateForProcess = tunnelProcess;
        const procToStop = tunnelProcess;
        tunnelProcess = null;
        await terminateProcess(procToStop);
      }
      updateState({
        enabled: false,
        status: "error",
        error: err instanceof Error ? err.message : "Tunnel failed to connect.",
      });
      return getTunnelState();
    }
  }

  return getTunnelState();
}

export async function stopTunnel(): Promise<void> {
  quickStartAttemptCount = 0;
  const authToken = currentState.authToken;
  const tunnelMode = getTunnelMode();
  const proc = tunnelProcess;
  if (!proc) {
    updateState({
      enabled: false,
      status: "disabled",
      publicUrl: null,
      authToken: null,
      error: null,
    });
    if (tunnelMode === "quick" && authToken) {
      await registerTunnelEndpoint(authToken, null);
    }
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

  await stopLocalMcpHttpServer();

  if (tunnelMode === "quick" && authToken) {
    await registerTunnelEndpoint(authToken, null);
  }
}

export function isTunnelRunning(): boolean {
  return tunnelProcess !== null && !tunnelProcess.killed;
}
