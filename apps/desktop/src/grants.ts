import * as fs from "fs";
import * as path from "path";
import { BASIS_ROOT } from "@context-manager/config";
import type { ContextScope, ScopeGrant, GrantsFile } from "@context-manager/config";

const GRANTS_PATH = path.join(BASIS_ROOT, "mcp-grants.json");
const LOCAL_CLIENT_ID = "local";
const LOCAL_CLIENT_NAME = "Local Client";

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

export function listGrants(): Record<string, ScopeGrant> {
  return readGrantsFile().grants;
}

export function getLocalGrant(): ScopeGrant | null {
  return readGrantsFile().grants[LOCAL_CLIENT_ID] || null;
}

/** Set the local client's scopes (replaces existing). */
export function setLocalScopes(scopes: ContextScope[]): ScopeGrant {
  const file = readGrantsFile();
  const now = new Date().toISOString();
  const existing = file.grants[LOCAL_CLIENT_ID];

  const grant: ScopeGrant = {
    clientName: LOCAL_CLIENT_NAME,
    scopes: Array.from(new Set(scopes)),
    grantedAt: existing?.grantedAt || now,
    lastUsed: existing?.lastUsed || now,
  };

  file.grants[LOCAL_CLIENT_ID] = grant;
  writeGrantsFile(file);
  return grant;
}

export function revokeLocalGrant(): boolean {
  const file = readGrantsFile();
  if (!file.grants[LOCAL_CLIENT_ID]) return false;
  delete file.grants[LOCAL_CLIENT_ID];
  writeGrantsFile(file);
  return true;
}
