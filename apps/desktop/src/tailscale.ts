import { execFileSync, execSync } from "child_process";

export type TailscalePeer = {
  hostname: string;
  tailscaleIp: string;
  os: string;
  online: boolean;
};

export type TailscaleStatus = {
  installed: boolean;
  running: boolean;
  hostname: string | null;
  tailscaleIp: string | null;
  peers: TailscalePeer[];
};

const NOT_INSTALLED: TailscaleStatus = {
  installed: false,
  running: false,
  hostname: null,
  tailscaleIp: null,
  peers: [],
};

const INSTALLED_NOT_RUNNING: TailscaleStatus = {
  installed: true,
  running: false,
  hostname: null,
  tailscaleIp: null,
  peers: [],
};

const EXEC_TIMEOUT_MS = 3_000;
const POLL_INTERVAL_MS = 10_000;
const POLL_INTERVAL_NOT_INSTALLED_MS = 60_000;

const MACOS_APP_STORE_PATH = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";

let resolvedBinary: string | null | undefined;

function resolveTailscaleBinary(): string | null {
  if (resolvedBinary !== undefined) {
    return resolvedBinary;
  }

  // Try PATH first
  try {
    const result = execSync("which tailscale", {
      encoding: "utf8",
      timeout: EXEC_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (result) {
      resolvedBinary = result;
      return resolvedBinary;
    }
  } catch {
    // not on PATH
  }

  // macOS App Store version
  try {
    const fs = require("fs") as typeof import("fs");
    if (fs.existsSync(MACOS_APP_STORE_PATH)) {
      resolvedBinary = MACOS_APP_STORE_PATH;
      return resolvedBinary;
    }
  } catch {
    // ignore
  }

  resolvedBinary = null;
  return null;
}

/**
 * Invalidate cached binary path so next call re-resolves.
 * Used when polling detects "not installed" so it can pick up a new install.
 */
function clearBinaryCache(): void {
  resolvedBinary = undefined;
}

type TailscaleJsonSelf = {
  HostName?: string;
  TailscaleIPs?: string[];
  OS?: string;
  Online?: boolean;
};

type TailscaleJsonPeer = {
  HostName?: string;
  TailscaleIPs?: string[];
  OS?: string;
  Online?: boolean;
};

type TailscaleJsonOutput = {
  Self?: TailscaleJsonSelf;
  Peer?: Record<string, TailscaleJsonPeer>;
};

export function getTailscaleStatus(): TailscaleStatus {
  const binary = resolveTailscaleBinary();
  if (!binary) {
    return NOT_INSTALLED;
  }

  let rawJson: string;
  try {
    rawJson = execFileSync(binary, ["status", "--json"], {
      encoding: "utf8",
      timeout: EXEC_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return INSTALLED_NOT_RUNNING;
  }

  let parsed: TailscaleJsonOutput;
  try {
    parsed = JSON.parse(rawJson) as TailscaleJsonOutput;
  } catch {
    return INSTALLED_NOT_RUNNING;
  }

  const self = parsed.Self;
  const hostname = self?.HostName || null;
  const tailscaleIp = self?.TailscaleIPs?.[0] || null;

  const peers: TailscalePeer[] = [];
  const peerMap = parsed.Peer;
  if (peerMap && typeof peerMap === "object") {
    for (const peer of Object.values(peerMap)) {
      const peerIp = peer.TailscaleIPs?.[0];
      if (!peerIp) continue;
      peers.push({
        hostname: peer.HostName || "unknown",
        tailscaleIp: peerIp,
        os: peer.OS || "unknown",
        online: peer.Online === true,
      });
    }
  }

  return {
    installed: true,
    running: true,
    hostname,
    tailscaleIp,
    peers,
  };
}

export function startTailscaleMonitor(
  onChange: (status: TailscaleStatus) => void
): () => void {
  let lastSnapshot = "";
  let currentInterval = POLL_INTERVAL_MS;

  const poll = (): void => {
    const status = getTailscaleStatus();
    const snapshot = JSON.stringify(status);
    if (snapshot !== lastSnapshot) {
      lastSnapshot = snapshot;
      onChange(status);
    }

    // If not installed, poll slower and re-check binary on next tick
    const nextInterval = status.installed
      ? POLL_INTERVAL_MS
      : POLL_INTERVAL_NOT_INSTALLED_MS;

    if (!status.installed) {
      clearBinaryCache();
    }

    if (nextInterval !== currentInterval) {
      currentInterval = nextInterval;
      clearInterval(timer);
      timer = setInterval(poll, currentInterval);
    }
  };

  let timer = setInterval(poll, currentInterval);

  // Run immediately
  poll();

  return () => {
    clearInterval(timer);
  };
}
