import * as fs from "fs";
import * as path from "path";
import { BASIS_ROOT } from "./paths";

// ── Types ───────────────────────────────────────────────────────────────────

export type VizlogCredentials = {
  authToken: string;
  accountEmail?: string;
  tunnelId?: string;
};

export type TunnelCredentialsFile = {
  AccountTag: string;
  TunnelID: string;
  TunnelSecret: string;
};

// ── Paths ───────────────────────────────────────────────────────────────────

const CREDENTIALS_PATH = path.join(BASIS_ROOT, "credentials.json");
const TUNNEL_CREDENTIALS_PATH = path.join(BASIS_ROOT, "tunnel-credentials.json");

// ── Helpers ─────────────────────────────────────────────────────────────────

function isValidCredentials(obj: unknown): obj is VizlogCredentials {
  if (typeof obj !== "object" || obj === null) return false;
  const rec = obj as Record<string, unknown>;
  return typeof rec.authToken === "string" && rec.authToken.length > 0;
}

// ── Public API ──────────────────────────────────────────────────────────────

/** Read credentials from `~/.basis/credentials.json`. Returns `null` if the file is missing or invalid. */
export function readCredentials(): VizlogCredentials | null {
  try {
    const raw = fs.readFileSync(CREDENTIALS_PATH, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (isValidCredentials(parsed)) return parsed;
    return null;
  } catch {
    return null;
  }
}

/** Write credentials to `~/.basis/credentials.json` with `0o600` permissions. */
export function writeCredentials(creds: VizlogCredentials): void {
  fs.mkdirSync(path.dirname(CREDENTIALS_PATH), { recursive: true });
  fs.writeFileSync(CREDENTIALS_PATH, JSON.stringify(creds, null, 2) + "\n", {
    encoding: "utf8",
    mode: 0o600,
  });
}

/** Delete `credentials.json` if it exists. */
export function clearCredentials(): void {
  try {
    fs.unlinkSync(CREDENTIALS_PATH);
  } catch {
    // File doesn't exist — nothing to clear.
  }
}

/** Return `true` if credentials.json exists and contains a valid authToken. */
export function hasCredentials(): boolean {
  return readCredentials() !== null;
}

function isValidTunnelCredentials(obj: unknown): obj is TunnelCredentialsFile {
  if (typeof obj !== "object" || obj === null) return false;
  const rec = obj as Record<string, unknown>;
  return (
    typeof rec.AccountTag === "string" &&
    rec.AccountTag.length > 0 &&
    typeof rec.TunnelID === "string" &&
    rec.TunnelID.length > 0 &&
    typeof rec.TunnelSecret === "string" &&
    rec.TunnelSecret.length > 0
  );
}

export function getTunnelCredentialsPath(): string {
  return TUNNEL_CREDENTIALS_PATH;
}

/** Read Cloudflare tunnel credentials from `~/.basis/tunnel-credentials.json`. */
export function readTunnelCredentials(): TunnelCredentialsFile | null {
  try {
    const raw = fs.readFileSync(TUNNEL_CREDENTIALS_PATH, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (isValidTunnelCredentials(parsed)) return parsed;
    return null;
  } catch {
    return null;
  }
}

/** Write Cloudflare tunnel credentials with `0o600` permissions. */
export function writeTunnelCredentials(creds: TunnelCredentialsFile): void {
  fs.mkdirSync(path.dirname(TUNNEL_CREDENTIALS_PATH), { recursive: true });
  fs.writeFileSync(TUNNEL_CREDENTIALS_PATH, JSON.stringify(creds, null, 2) + "\n", {
    encoding: "utf8",
    mode: 0o600,
  });
}
