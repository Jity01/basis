import * as dotenv from "dotenv";
import * as path from "path";
import * as fs from "fs";
import { createHash, randomBytes, timingSafeEqual } from "crypto";
import type { IncomingMessage } from "http";
import { CONTEXT_ROOT } from "@context-manager/config";

dotenv.config({ path: path.join(__dirname, "../../../.env") });

type AuthConfig = {
  authToken: string;
};

type OAuthCodeRecord = {
  clientId: string;
  redirectUri: string;
  codeChallenge: string | null;
  codeChallengeMethod: "plain" | "S256" | null;
  createdAtMs: number;
};

const AUTH_CONFIG_PATH = path.join(CONTEXT_ROOT, "mcp-auth.json");
const OAUTH_CODE_TTL_MS = 5 * 60_000;
const oauthCodes = new Map<string, OAuthCodeRecord>();

function normalizeAddress(input: string | undefined): string {
  return (input || "").trim().toLowerCase();
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function createAuthToken(): string {
  return randomBytes(24).toString("hex");
}

function readAuthConfig(): AuthConfig | null {
  try {
    if (!fs.existsSync(AUTH_CONFIG_PATH)) {
      return null;
    }
    const raw = fs.readFileSync(AUTH_CONFIG_PATH, "utf8");
    const parsed = JSON.parse(raw) as Partial<AuthConfig>;
    if (!isNonEmptyString(parsed.authToken)) {
      return null;
    }
    return { authToken: parsed.authToken.trim() };
  } catch (err) {
    console.warn("[mcp-auth] Failed reading auth config:", err);
    return null;
  }
}

function writeAuthConfig(config: AuthConfig): void {
  fs.mkdirSync(path.dirname(AUTH_CONFIG_PATH), { recursive: true });
  fs.writeFileSync(AUTH_CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

function getOrCreateAuthConfig(): AuthConfig {
  const existing = readAuthConfig();
  if (existing) {
    return existing;
  }
  const created: AuthConfig = { authToken: createAuthToken() };
  writeAuthConfig(created);
  return created;
}

const authConfig = getOrCreateAuthConfig();

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

function getBearerToken(req: IncomingMessage): string | null {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    return null;
  }
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    return null;
  }
  const token = match[1]?.trim();
  return token || null;
}

/**
 * All MCP calls require bearer auth.
 */
export function validateRequestAuth(
  req: IncomingMessage
): { ok: true } | { ok: false; statusCode: number; error: string } {
  const expectedToken = authConfig.authToken;

  const incomingToken = getBearerToken(req);
  if (!incomingToken) {
    return {
      ok: false,
      statusCode: 401,
      error: "Missing bearer token.",
    };
  }

  if (!safeTokenEqual(incomingToken, expectedToken)) {
    return {
      ok: false,
      statusCode: 403,
      error: "Invalid bearer token.",
    };
  }

  return { ok: true };
}

export function getServerAuthToken(): string {
  return authConfig.authToken;
}

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
  return { ok: true, authToken: authConfig.authToken };
}

function pruneExpiredOAuthCodes(nowMs = Date.now()): void {
  for (const [code, record] of oauthCodes.entries()) {
    if (nowMs - record.createdAtMs > OAUTH_CODE_TTL_MS) {
      oauthCodes.delete(code);
    }
  }
}

export function buildOAuthMetadata(baseUrl: string): Record<string, unknown> {
  return {
    issuer: baseUrl,
    authorization_endpoint: `${baseUrl}/oauth/authorize`,
    token_endpoint: `${baseUrl}/oauth/token`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["plain", "S256"],
    token_endpoint_auth_methods_supported: ["none"],
  };
}

export function beginOAuthAuthorization(input: {
  clientId: string;
  redirectUri: string;
  responseType: string;
  state: string;
  codeChallenge: string | null;
  codeChallengeMethod: "plain" | "S256" | null;
}): { ok: true; redirectTo: string } | { ok: false; statusCode: number; error: string } {
  const clientId = input.clientId.trim();
  const redirectUri = input.redirectUri.trim();
  if (!clientId || !redirectUri) {
    return { ok: false, statusCode: 400, error: "Missing client_id or redirect_uri." };
  }
  if (input.responseType !== "code") {
    return { ok: false, statusCode: 400, error: "Unsupported response_type." };
  }

  const code = randomBytes(18).toString("base64url");
  pruneExpiredOAuthCodes();
  oauthCodes.set(code, {
    clientId,
    redirectUri,
    codeChallenge: input.codeChallenge,
    codeChallengeMethod: input.codeChallengeMethod,
    createdAtMs: Date.now(),
  });

  let redirect: URL;
  try {
    redirect = new URL(redirectUri);
  } catch {
    return { ok: false, statusCode: 400, error: "Invalid redirect_uri." };
  }
  redirect.searchParams.set("code", code);
  if (input.state) {
    redirect.searchParams.set("state", input.state);
  }
  return { ok: true, redirectTo: redirect.toString() };
}

function toS256Challenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

export function exchangeOAuthToken(input: {
  grantType: string;
  code: string;
  redirectUri: string;
  clientId: string;
  codeVerifier: string | null;
  refreshToken: string | null;
}):
  | { ok: true; payload: Record<string, unknown> }
  | { ok: false; statusCode: number; error: string } {
  const grantType = input.grantType.trim();
  if (grantType === "refresh_token") {
    if (!input.refreshToken || !safeTokenEqual(input.refreshToken, authConfig.authToken)) {
      return { ok: false, statusCode: 400, error: "Invalid refresh_token." };
    }
    return {
      ok: true,
      payload: {
        access_token: authConfig.authToken,
        token_type: "Bearer",
        expires_in: 31_536_000,
        refresh_token: authConfig.authToken,
      },
    };
  }

  if (grantType !== "authorization_code") {
    return { ok: false, statusCode: 400, error: "Unsupported grant_type." };
  }

  pruneExpiredOAuthCodes();
  const code = input.code.trim();
  const record = oauthCodes.get(code);
  oauthCodes.delete(code);
  if (!record) {
    return { ok: false, statusCode: 400, error: "Invalid or expired authorization code." };
  }

  if (record.clientId !== input.clientId.trim() || record.redirectUri !== input.redirectUri.trim()) {
    return { ok: false, statusCode: 400, error: "Authorization code does not match client details." };
  }

  if (record.codeChallenge && record.codeChallengeMethod) {
    const verifier = (input.codeVerifier || "").trim();
    if (!verifier) {
      return { ok: false, statusCode: 400, error: "Missing code_verifier." };
    }
    const expected =
      record.codeChallengeMethod === "S256" ? toS256Challenge(verifier) : verifier;
    if (!safeTokenEqual(expected, record.codeChallenge)) {
      return { ok: false, statusCode: 400, error: "Invalid code_verifier." };
    }
  }

  return {
    ok: true,
    payload: {
      access_token: authConfig.authToken,
      token_type: "Bearer",
      expires_in: 31_536_000,
      refresh_token: authConfig.authToken,
    },
  };
}
