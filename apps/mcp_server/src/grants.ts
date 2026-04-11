import * as fs from "fs";
import * as path from "path";
import { BASIS_ROOT } from "@context-manager/config";
import type { ContextScope, ScopeGrant, GrantsFile } from "@context-manager/config";

const GRANTS_PATH = path.join(BASIS_ROOT, "mcp-grants.json");

function readGrantsFile(): GrantsFile {
  try {
    const raw = fs.readFileSync(GRANTS_PATH, "utf8");
    const parsed = JSON.parse(raw) as Partial<GrantsFile>;
    return { grants: parsed.grants && typeof parsed.grants === "object" ? parsed.grants : {} };
  } catch {
    return { grants: {} };
  }
}

function writeGrantsFile(data: GrantsFile): void {
  fs.mkdirSync(path.dirname(GRANTS_PATH), { recursive: true });
  fs.writeFileSync(GRANTS_PATH, JSON.stringify(data, null, 2) + "\n", "utf8");
}

/** Get all grants. */
export function listGrants(): Record<string, ScopeGrant> {
  return readGrantsFile().grants;
}

/** Get grant for a specific client. */
export function getGrant(clientId: string): ScopeGrant | null {
  return readGrantsFile().grants[clientId] || null;
}

/** Get the scopes granted to a client (empty array if no grant). */
export function grantedScopes(clientId: string): ContextScope[] {
  const grant = getGrant(clientId);
  return grant ? grant.scopes : [];
}

/** Add or upgrade scopes for a client. Merges with existing. */
export function upsertGrant(clientId: string, clientName: string, scopes: ContextScope[]): ScopeGrant {
  const file = readGrantsFile();
  const existing = file.grants[clientId];
  const now = new Date().toISOString();

  const mergedScopes = Array.from(new Set([
    ...(existing?.scopes || []),
    ...scopes,
  ])) as ContextScope[];

  const grant: ScopeGrant = {
    clientName: clientName || existing?.clientName || "Unknown",
    scopes: mergedScopes,
    grantedAt: existing?.grantedAt || now,
    lastUsed: now,
  };

  file.grants[clientId] = grant;
  writeGrantsFile(file);
  return grant;
}

/** Update lastUsed timestamp for a client. */
export function touchGrant(clientId: string): void {
  const file = readGrantsFile();
  if (file.grants[clientId]) {
    file.grants[clientId]!.lastUsed = new Date().toISOString();
    writeGrantsFile(file);
  }
}

/** Revoke all grants for a client. */
export function revokeGrant(clientId: string): boolean {
  const file = readGrantsFile();
  if (!file.grants[clientId]) return false;
  delete file.grants[clientId];
  writeGrantsFile(file);
  return true;
}
