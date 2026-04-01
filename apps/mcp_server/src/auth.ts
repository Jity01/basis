import * as dotenv from "dotenv";
import * as path from "path";
import * as fs from "fs";
import { randomBytes, timingSafeEqual } from "crypto";
import type { IncomingMessage } from "http";
import type { Response } from "express";
import { CONTEXT_ROOT } from "@context-manager/config";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import {
  InvalidGrantError,
  InvalidRequestError,
  InvalidScopeError,
  InvalidTokenError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { OAuthServerProvider, AuthorizationParams } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { OAuthClientInformationFull, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";

dotenv.config({ path: path.join(__dirname, "../../../.env") });

type LocalDebugConfig = {
  authToken: string;
};

type PersistedRegisteredClients = {
  clients: Record<string, OAuthClientInformationFull>;
};

type AuthorizationCodeRecord = {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scopes: string[];
  resource: string | null;
  createdAtMs: number;
};

type AccessTokenRecord = {
  accessToken: string;
  clientId: string;
  scopes: string[];
  resource: string | null;
  expiresAt: number;
};

type RefreshTokenRecord = {
  refreshToken: string;
  clientId: string;
  scopes: string[];
  resource: string | null;
  expiresAt: number;
};

const LOCAL_DEBUG_AUTH_PATH = path.join(CONTEXT_ROOT, "mcp-auth.json");
const OAUTH_CLIENTS_PATH = path.join(CONTEXT_ROOT, "mcp-oauth-clients.json");
const AUTHORIZATION_CODE_TTL_MS = 5 * 60_000;
const ACCESS_TOKEN_TTL_S = 24 * 60 * 60;
const REFRESH_TOKEN_TTL_S = 30 * 24 * 60 * 60;
const LOCAL_DEBUG_TOKEN_TTL_S = 10 * 365 * 24 * 60 * 60;
const SUPPORTED_SCOPES = ["mcp:tools"];
const CLAUDE_REDIRECT_URIS = [
  "https://claude.ai/api/mcp/auth_callback",
  "https://claude.com/api/mcp/auth_callback",
];
const LOOPBACK_DEBUG_REDIRECT_URIS = [
  "http://127.0.0.1/callback",
  "http://localhost/callback",
];
const OAUTH_ALLOWED_REDIRECT_URIS = String(process.env.MCP_OAUTH_ALLOWED_REDIRECT_URIS || "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const FIXED_OAUTH_CLIENT_ID = String(process.env.MCP_OAUTH_CLIENT_ID || "").trim();
const FIXED_OAUTH_CLIENT_SECRET = String(process.env.MCP_OAUTH_CLIENT_SECRET || "").trim();

const authorizationCodes = new Map<string, AuthorizationCodeRecord>();
const accessTokens = new Map<string, AccessTokenRecord>();
const refreshTokens = new Map<string, RefreshTokenRecord>();
const registeredClients = readRegisteredClients();
const localDebugConfig = getOrCreateLocalDebugConfig();

function normalizeAddress(input: string | undefined): string {
  return (input || "").trim().toLowerCase();
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function createOpaqueToken(): string {
  return randomBytes(32).toString("hex");
}

function readJsonFile<T>(filePath: string): T | null {
  try {
    if (!fs.existsSync(filePath)) {
      return null;
    }
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
  } catch (err) {
    console.warn(`[mcp-auth] Failed reading ${path.basename(filePath)}:`, err);
    return null;
  }
}

function writeJsonFile(filePath: string, payload: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function readLocalDebugConfig(): LocalDebugConfig | null {
  const parsed = readJsonFile<Partial<LocalDebugConfig>>(LOCAL_DEBUG_AUTH_PATH);
  if (!parsed || !isNonEmptyString(parsed.authToken)) {
    return null;
  }
  return { authToken: parsed.authToken.trim() };
}

function getOrCreateLocalDebugConfig(): LocalDebugConfig {
  const existing = readLocalDebugConfig();
  if (existing) {
    return existing;
  }
  const created = { authToken: createOpaqueToken() };
  writeJsonFile(LOCAL_DEBUG_AUTH_PATH, created);
  return created;
}

function readRegisteredClients(): Record<string, OAuthClientInformationFull> {
  const parsed = readJsonFile<PersistedRegisteredClients>(OAUTH_CLIENTS_PATH);
  return parsed?.clients || {};
}

function persistRegisteredClients(): void {
  writeJsonFile(OAUTH_CLIENTS_PATH, { clients: registeredClients });
}

function safeTokenEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  if (leftBytes.length !== rightBytes.length) {
    return false;
  }
  return timingSafeEqual(leftBytes, rightBytes);
}

export function isLoopbackAddress(address: string | undefined): boolean {
  const normalized = normalizeAddress(address);
  return (
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized === "::ffff:127.0.0.1" ||
    normalized === "localhost"
  );
}

function getFixedClient(): OAuthClientInformationFull | null {
  if (!FIXED_OAUTH_CLIENT_ID) {
    return null;
  }
  const redirectUris = Array.from(
    new Set([...CLAUDE_REDIRECT_URIS, ...LOOPBACK_DEBUG_REDIRECT_URIS, ...OAUTH_ALLOWED_REDIRECT_URIS])
  );
  return {
    client_id: FIXED_OAUTH_CLIENT_ID,
    client_secret: FIXED_OAUTH_CLIENT_SECRET || undefined,
    client_id_issued_at: undefined,
    client_secret_expires_at: FIXED_OAUTH_CLIENT_SECRET ? 0 : undefined,
    redirect_uris: redirectUris,
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: FIXED_OAUTH_CLIENT_SECRET ? "client_secret_post" : "none",
    scope: SUPPORTED_SCOPES.join(" "),
    client_name: "Configured MCP Client",
  };
}

function normalizeScopes(scopes: string[] | undefined): string[] {
  const normalized = Array.from(
    new Set((scopes || []).map((scope) => scope.trim()).filter(Boolean))
  );
  if (normalized.length === 0) {
    return [...SUPPORTED_SCOPES];
  }
  for (const scope of normalized) {
    if (!SUPPORTED_SCOPES.includes(scope)) {
      throw new InvalidScopeError(`Unsupported scope: ${scope}`);
    }
  }
  return normalized;
}

function toAuthInfo(record: AccessTokenRecord): AuthInfo {
  return {
    token: record.accessToken,
    clientId: record.clientId,
    scopes: record.scopes,
    expiresAt: record.expiresAt,
    resource: record.resource ? new URL(record.resource) : undefined,
  };
}

function issueTokens(clientId: string, scopes: string[], resource: string | null): OAuthTokens {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const accessToken = createOpaqueToken();
  const refreshToken = createOpaqueToken();
  const accessRecord: AccessTokenRecord = {
    accessToken,
    clientId,
    scopes,
    resource,
    expiresAt: nowSeconds + ACCESS_TOKEN_TTL_S,
  };
  const refreshRecord: RefreshTokenRecord = {
    refreshToken,
    clientId,
    scopes,
    resource,
    expiresAt: nowSeconds + REFRESH_TOKEN_TTL_S,
  };
  accessTokens.set(accessToken, accessRecord);
  refreshTokens.set(refreshToken, refreshRecord);
  return {
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: ACCESS_TOKEN_TTL_S,
    refresh_token: refreshToken,
    scope: scopes.join(" "),
  };
}

function issueLocalDebugToken(): string {
  const existing = accessTokens.get(localDebugConfig.authToken);
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (existing && existing.expiresAt > nowSeconds) {
    return existing.accessToken;
  }
  accessTokens.set(localDebugConfig.authToken, {
    accessToken: localDebugConfig.authToken,
    clientId: "local-debug",
    scopes: [...SUPPORTED_SCOPES],
    resource: null,
    expiresAt: nowSeconds + LOCAL_DEBUG_TOKEN_TTL_S,
  });
  return localDebugConfig.authToken;
}

function pruneExpiredState(nowMs = Date.now()): void {
  for (const [code, record] of authorizationCodes.entries()) {
    if (nowMs - record.createdAtMs > AUTHORIZATION_CODE_TTL_MS) {
      authorizationCodes.delete(code);
    }
  }
  const nowSeconds = Math.floor(nowMs / 1000);
  for (const [token, record] of accessTokens.entries()) {
    if (record.expiresAt <= nowSeconds) {
      accessTokens.delete(token);
    }
  }
  for (const [token, record] of refreshTokens.entries()) {
    if (record.expiresAt <= nowSeconds) {
      refreshTokens.delete(token);
    }
  }
}

function logAuthFailure(message: string): void {
  console.warn(`[mcp-auth] ${message}`);
}

const clientsStore: OAuthRegisteredClientsStore = {
  async getClient(clientId) {
    const fixedClient = getFixedClient();
    if (fixedClient && clientId === fixedClient.client_id) {
      return fixedClient;
    }
    return registeredClients[clientId];
  },
  async registerClient(client) {
    const normalized = {
      ...client,
      grant_types: client.grant_types || ["authorization_code", "refresh_token"],
      response_types: client.response_types || ["code"],
      scope: normalizeScopes(String(client.scope || "").split(" ").filter(Boolean)).join(" "),
    } as OAuthClientInformationFull;
    registeredClients[normalized.client_id] = normalized;
    persistRegisteredClients();
    console.log(
      `[mcp-auth] registered client id=${normalized.client_id} name="${normalized.client_name || ""}"`
    );
    return normalized;
  },
};

export const oauthProvider: OAuthServerProvider = {
  get clientsStore() {
    return clientsStore;
  },

  async authorize(client, params, res: Response): Promise<void> {
    const scopes = normalizeScopes(params.scopes);
    const code = createOpaqueToken();
    authorizationCodes.set(code, {
      clientId: client.client_id,
      redirectUri: params.redirectUri,
      codeChallenge: params.codeChallenge,
      scopes,
      resource: params.resource?.href || null,
      createdAtMs: Date.now(),
    });
    console.log(
      `[mcp-auth] authorize client=${client.client_id} redirect=${params.redirectUri} scopes=${scopes.join(
        ","
      )}`
    );
    const redirect = new URL(params.redirectUri);
    redirect.searchParams.set("code", code);
    if (params.state) {
      redirect.searchParams.set("state", params.state);
    }
    res.redirect(302, redirect.toString());
  },

  async challengeForAuthorizationCode(client, authorizationCode): Promise<string> {
    pruneExpiredState();
    const record = authorizationCodes.get(authorizationCode);
    if (!record || record.clientId !== client.client_id) {
      logAuthFailure(`invalid authorization code for client=${client.client_id}`);
      throw new InvalidGrantError("Invalid or expired authorization code.");
    }
    return record.codeChallenge;
  },

  async exchangeAuthorizationCode(
    client,
    authorizationCode,
    _codeVerifier,
    redirectUri,
    resource
  ): Promise<OAuthTokens> {
    pruneExpiredState();
    const record = authorizationCodes.get(authorizationCode);
    authorizationCodes.delete(authorizationCode);
    if (!record || record.clientId !== client.client_id) {
      logAuthFailure(`authorization_code exchange failed for client=${client.client_id}: invalid code`);
      throw new InvalidGrantError("Invalid or expired authorization code.");
    }
    if (redirectUri && record.redirectUri !== redirectUri) {
      logAuthFailure(
        `authorization_code exchange failed for client=${client.client_id}: redirect mismatch`
      );
      throw new InvalidGrantError("Authorization code does not match redirect_uri.");
    }
    if (resource && record.resource && resource.href !== record.resource) {
      logAuthFailure(`authorization_code exchange failed for client=${client.client_id}: resource mismatch`);
      throw new InvalidRequestError("Authorization code does not match resource.");
    }
    console.log(`[mcp-auth] token exchange client=${client.client_id} grant=authorization_code`);
    return issueTokens(client.client_id, record.scopes, resource?.href || record.resource);
  },

  async exchangeRefreshToken(client, refreshToken, scopes, resource): Promise<OAuthTokens> {
    pruneExpiredState();
    const record = refreshTokens.get(refreshToken);
    if (!record || record.clientId !== client.client_id) {
      logAuthFailure(`refresh_token exchange failed for client=${client.client_id}: invalid token`);
      throw new InvalidGrantError("Invalid refresh token.");
    }
    const nextScopes = scopes && scopes.length > 0 ? normalizeScopes(scopes) : record.scopes;
    for (const scope of nextScopes) {
      if (!record.scopes.includes(scope)) {
        logAuthFailure(`refresh_token exchange failed for client=${client.client_id}: scope escalation`);
        throw new InvalidScopeError("Refresh token cannot elevate scopes.");
      }
    }
    refreshTokens.delete(refreshToken);
    console.log(`[mcp-auth] token exchange client=${client.client_id} grant=refresh_token`);
    return issueTokens(client.client_id, nextScopes, resource?.href || record.resource);
  },

  async verifyAccessToken(token): Promise<AuthInfo> {
    pruneExpiredState();
    if (safeTokenEqual(token, localDebugConfig.authToken)) {
      issueLocalDebugToken();
    }
    const record = accessTokens.get(token);
    if (!record) {
      logAuthFailure("access token verification failed");
      throw new InvalidTokenError("Invalid access token.");
    }
    return toAuthInfo(record);
  },
};

export function getAuthInfoForLocalRequest(
  req: IncomingMessage
): { ok: true; authToken: string } | { ok: false; statusCode: number; error: string } {
  if (!isLoopbackAddress(req.socket.remoteAddress)) {
    return {
      ok: false,
      statusCode: 403,
      error: "Auth info is only available from loopback requests.",
    };
  }
  return { ok: true, authToken: issueLocalDebugToken() };
}
