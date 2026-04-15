export interface Env {
  DB: D1Database;
}

const ALLOWED_ORIGINS = [
  "https://vizlog.ai",
  "https://www.vizlog.ai",
  "http://localhost:3000",
  "http://localhost:5173",
  "http://127.0.0.1:5173",
];

const AUTH_CODE_TTL_SECONDS = 300;
const ACCESS_TOKEN_TTL_SECONDS = 86_400;

function nowIso(): string {
  return new Date().toISOString();
}

function expiresIso(secondsFromNow: number): string {
  return new Date(Date.now() + secondsFromNow * 1000).toISOString();
}

function corsHeaders(request: Request): Record<string, string> {
  const origin = request.headers.get("Origin") || "";
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
  };
}

function jsonResponse(request: Request, body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      ...corsHeaders(request),
    },
  });
}

function errorResponse(request: Request, error: string, status: number): Response {
  return jsonResponse(request, { error }, status);
}

function oauthErrorResponse(
  request: Request,
  error: string,
  status: number,
  description?: string,
): Response {
  return jsonResponse(
    request,
    description ? { error, error_description: description } : { error },
    status,
  );
}

function toHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function toBase64(buffer: ArrayBuffer | Uint8Array): string {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  return btoa(String.fromCharCode(...bytes));
}

function fromBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function base64UrlEncode(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function sha256Hex(value: string): Promise<string> {
  const encoder = new TextEncoder();
  const hash = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return toHex(hash);
}

async function sha256Base64Url(value: string): Promise<string> {
  const encoder = new TextEncoder();
  const hash = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return base64UrlEncode(new Uint8Array(hash));
}

async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(32));
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const hash = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: 100_000, hash: "SHA-256" },
    keyMaterial,
    256,
  );
  return `${toBase64(salt)}:${toBase64(hash)}`;
}

async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [saltB64, hashB64] = stored.split(":");
  const salt = fromBase64(saltB64);
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const hash = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: 100_000, hash: "SHA-256" },
    keyMaterial,
    256,
  );
  const storedHash = fromBase64(hashB64);
  const computed = new Uint8Array(hash);
  if (computed.length !== storedHash.length) return false;
  let diff = 0;
  for (let i = 0; i < computed.length; i++) diff |= computed[i] ^ storedHash[i];
  return diff === 0;
}

function generateAuthToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return "jr_" + toHex(bytes.buffer);
}

function generateTunnelId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return "tun_" + toHex(bytes.buffer);
}

function generateAuthorizationCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return "ac_" + base64UrlEncode(bytes);
}

function generateAccessToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return "oa_" + base64UrlEncode(bytes);
}

function extractBearerToken(request: Request, expectedPrefix?: string): string | null {
  const auth = request.headers.get("Authorization");
  if (!auth || !auth.startsWith("Bearer ")) return null;
  const token = auth.slice(7).trim();
  if (!token) return null;
  if (expectedPrefix && !token.startsWith(expectedPrefix)) return null;
  return token;
}

type SessionUser = {
  id: number;
  email: string;
  tunnel_id: string;
  created_at: string;
  tunnel_endpoint: string | null;
};

async function getSessionUserFromAuthToken(request: Request, env: Env): Promise<SessionUser | null> {
  const token = extractBearerToken(request, "jr_");
  if (!token) return null;
  const tokenHash = await sha256Hex(token);
  return env.DB.prepare(
    "SELECT u.id, u.email, u.tunnel_id, u.created_at, te.endpoint_url AS tunnel_endpoint FROM users u LEFT JOIN tunnel_endpoints te ON te.user_id = u.id WHERE u.auth_token_hash = ?",
  )
    .bind(tokenHash)
    .first<SessionUser>();
}

type OauthClient = {
  client_id: string;
  client_name: string | null;
  redirect_uris_json: string;
  grant_types_json: string;
  response_types_json: string;
  token_endpoint_auth_method: string;
};

async function getOauthClient(env: Env, clientId: string): Promise<OauthClient | null> {
  return env.DB.prepare(
    "SELECT client_id, client_name, redirect_uris_json, grant_types_json, response_types_json, token_endpoint_auth_method FROM oauth_clients WHERE client_id = ?",
  )
    .bind(clientId)
    .first<OauthClient>();
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function safeJsonArray(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

function getAuthServerOrigin(request: Request): string {
  return new URL(request.url).origin;
}

function normalizeTunnelEndpointUrl(value: unknown): string | null {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) return null;

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }

  if (parsed.protocol !== "https:") {
    return null;
  }

  return `${parsed.origin}`;
}

async function handleSignup(request: Request, env: Env): Promise<Response> {
  let body: { email?: string; password?: string };
  try {
    body = await request.json();
  } catch {
    return errorResponse(request, "Invalid JSON body", 400);
  }

  const { email, password } = body;
  if (!email || !password) return errorResponse(request, "Email and password are required", 400);
  if (typeof email !== "string" || typeof password !== "string") {
    return errorResponse(request, "Email and password must be strings", 400);
  }

  const normalizedEmail = email.toLowerCase().trim();
  if (!normalizedEmail.includes("@")) return errorResponse(request, "Invalid email address", 400);
  if (password.length < 8) return errorResponse(request, "Password must be at least 8 characters", 400);

  const existing = await env.DB.prepare("SELECT id FROM users WHERE email = ?").bind(normalizedEmail).first();
  if (existing) return errorResponse(request, "Email already registered", 409);

  const passwordHash = await hashPassword(password);
  const authToken = generateAuthToken();
  const tokenHash = await sha256Hex(authToken);
  const tunnelId = generateTunnelId();

  await env.DB.prepare("INSERT INTO users (email, password_hash, auth_token_hash, tunnel_id) VALUES (?, ?, ?, ?)")
    .bind(normalizedEmail, passwordHash, tokenHash, tunnelId)
    .run();

  return jsonResponse(request, { authToken, email: normalizedEmail, tunnelId }, 201);
}

async function handleLogin(request: Request, env: Env): Promise<Response> {
  let body: { email?: string; password?: string };
  try {
    body = await request.json();
  } catch {
    return errorResponse(request, "Invalid JSON body", 400);
  }

  const { email, password } = body;
  if (!email || !password) return errorResponse(request, "Email and password are required", 400);
  if (typeof email !== "string" || typeof password !== "string") {
    return errorResponse(request, "Email and password must be strings", 400);
  }

  const normalizedEmail = email.toLowerCase().trim();
  const user = await env.DB.prepare("SELECT id, password_hash, tunnel_id FROM users WHERE email = ?")
    .bind(normalizedEmail)
    .first<{ id: number; password_hash: string; tunnel_id: string }>();

  if (!user) return errorResponse(request, "Invalid email or password", 401);
  const valid = await verifyPassword(password, user.password_hash);
  if (!valid) return errorResponse(request, "Invalid email or password", 401);

  const authToken = generateAuthToken();
  const tokenHash = await sha256Hex(authToken);
  await env.DB.prepare("UPDATE users SET auth_token_hash = ?, updated_at = datetime('now') WHERE id = ?")
    .bind(tokenHash, user.id)
    .run();

  return jsonResponse(request, { authToken, email: normalizedEmail, tunnelId: user.tunnel_id });
}

async function handleMe(request: Request, env: Env): Promise<Response> {
  const user = await getSessionUserFromAuthToken(request, env);
  if (!user) return errorResponse(request, "Missing or invalid authorization token", 401);

  return jsonResponse(request, {
    email: user.email,
    tunnelId: user.tunnel_id,
    tunnelEndpoint: user.tunnel_endpoint,
    createdAt: user.created_at,
  });
}

async function handleTokenRefresh(request: Request, env: Env): Promise<Response> {
  const user = await getSessionUserFromAuthToken(request, env);
  if (!user) return errorResponse(request, "Missing or invalid authorization token", 401);

  const newToken = generateAuthToken();
  const newTokenHash = await sha256Hex(newToken);
  await env.DB.prepare("UPDATE users SET auth_token_hash = ?, updated_at = datetime('now') WHERE id = ?")
    .bind(newTokenHash, user.id)
    .run();

  return jsonResponse(request, { authToken: newToken });
}

async function handleRevoke(request: Request, env: Env): Promise<Response> {
  const user = await getSessionUserFromAuthToken(request, env);
  if (!user) return errorResponse(request, "Missing or invalid authorization token", 401);

  const deadHash = await sha256Hex(generateAuthToken());
  await env.DB.prepare("UPDATE users SET auth_token_hash = ?, updated_at = datetime('now') WHERE id = ?")
    .bind(deadHash, user.id)
    .run();

  return jsonResponse(request, { success: true });
}

async function handleTunnelEndpointUpdate(request: Request, env: Env): Promise<Response> {
  const user = await getSessionUserFromAuthToken(request, env);
  if (!user) return errorResponse(request, "Missing or invalid authorization token", 401);

  let body: { endpointUrl?: string | null };
  try {
    body = await request.json();
  } catch {
    return errorResponse(request, "Invalid JSON body", 400);
  }

  const endpointUrl = normalizeTunnelEndpointUrl(body.endpointUrl);
  if (body.endpointUrl && !endpointUrl) {
    return errorResponse(request, "endpointUrl must be a valid HTTPS URL", 400);
  }

  if (!endpointUrl) {
    await env.DB.prepare("DELETE FROM tunnel_endpoints WHERE user_id = ?").bind(user.id).run();
    return jsonResponse(request, { success: true, tunnelEndpoint: null });
  }

  await env.DB.prepare(
    "INSERT INTO tunnel_endpoints (user_id, endpoint_url, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(user_id) DO UPDATE SET endpoint_url = excluded.endpoint_url, updated_at = datetime('now')",
  )
    .bind(user.id, endpointUrl)
    .run();

  return jsonResponse(request, { success: true, tunnelEndpoint: endpointUrl });
}

async function handleOAuthServerMetadata(request: Request): Promise<Response> {
  const origin = getAuthServerOrigin(request);
  return jsonResponse(request, {
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    registration_endpoint: `${origin}/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    token_endpoint_auth_methods_supported: ["none"],
    code_challenge_methods_supported: ["S256"],
  });
}

async function handleOAuthRegister(request: Request, env: Env): Promise<Response> {
  let body: {
    client_name?: string;
    redirect_uris?: string[];
    grant_types?: string[];
    response_types?: string[];
    token_endpoint_auth_method?: string;
  };
  try {
    body = await request.json();
  } catch {
    return oauthErrorResponse(request, "invalid_client_metadata", 400, "Invalid JSON body");
  }

  const redirectUris = Array.isArray(body.redirect_uris)
    ? body.redirect_uris.filter((v): v is string => typeof v === "string" && v.length > 0)
    : [];
  if (!redirectUris.length) {
    return oauthErrorResponse(request, "invalid_redirect_uri", 400, "redirect_uris is required");
  }

  const grantTypes = body.grant_types?.length ? body.grant_types : ["authorization_code"];
  const responseTypes = body.response_types?.length ? body.response_types : ["code"];
  const tokenEndpointAuthMethod = body.token_endpoint_auth_method || "none";

  if (tokenEndpointAuthMethod !== "none") {
    return oauthErrorResponse(request, "invalid_client_metadata", 400, "Only token_endpoint_auth_method=none is supported");
  }

  const clientId = `cli_${crypto.randomUUID().replace(/-/g, "")}`;
  await env.DB.prepare(
    "INSERT INTO oauth_clients (client_id, client_name, redirect_uris_json, grant_types_json, response_types_json, token_endpoint_auth_method) VALUES (?, ?, ?, ?, ?, ?)",
  )
    .bind(
      clientId,
      body.client_name || null,
      JSON.stringify(redirectUris),
      JSON.stringify(grantTypes),
      JSON.stringify(responseTypes),
      tokenEndpointAuthMethod,
    )
    .run();

  return jsonResponse(
    request,
    {
      client_id: clientId,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      client_name: body.client_name || null,
      redirect_uris: redirectUris,
      grant_types: grantTypes,
      response_types: responseTypes,
      token_endpoint_auth_method: tokenEndpointAuthMethod,
    },
    201,
  );
}

type OAuthParams = {
  responseType: string;
  clientId: string;
  redirectUri: string;
  state?: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  scope?: string;
  resource?: string;
};

function renderOAuthLoginPage(
  request: Request,
  params: OAuthParams,
  opts?: { error?: string; email?: string; clientName?: string },
): Response {
  const e = escapeHtml;
  const errorHtml = opts?.error
    ? `<div class="error-msg visible">${e(opts.error)}</div>`
    : `<div class="error-msg"></div>`;
  const emailVal = opts?.email ? e(opts.email) : "";
  const clientLabel = opts?.clientName ? e(opts.clientName) : e(params.clientId);

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Vizlog - Sign In to Authorize</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #0f0f1a; color: #e0e0e0; min-height: 100vh;
      display: flex; align-items: center; justify-content: center; padding: 20px;
    }
    .container { width: 100%; max-width: 400px; }
    .logo { text-align: center; margin-bottom: 40px; font-size: 28px; font-weight: 700; color: #fff; letter-spacing: -0.5px; }
    .card { background: #1a1a2e; border-radius: 12px; padding: 32px; border: 1px solid #2a2a3e; }
    .card h2 { font-size: 20px; font-weight: 600; color: #fff; margin-bottom: 8px; }
    .client-info { font-size: 13px; color: #a0a0b0; margin-bottom: 24px; }
    .form-group { margin-bottom: 16px; }
    .form-group label { display: block; font-size: 14px; color: #a0a0b0; margin-bottom: 6px; }
    .form-group input[type="email"],
    .form-group input[type="password"] {
      width: 100%; padding: 10px 14px; background: #12121e; border: 1px solid #2a2a3e;
      border-radius: 8px; color: #e0e0e0; font-size: 15px; outline: none; transition: border-color 0.2s;
    }
    .form-group input:focus { border-color: #6c63ff; }
    .btn {
      width: 100%; padding: 12px; background: #6c63ff; color: #fff; border: none;
      border-radius: 8px; font-size: 15px; font-weight: 600; cursor: pointer; transition: background 0.2s; margin-top: 8px;
    }
    .btn:hover { background: #5a52d5; }
    .error-msg {
      background: #2e1a1a; border: 1px solid #5a2a2a; color: #ff6b6b;
      padding: 10px 14px; border-radius: 8px; font-size: 14px; margin-bottom: 16px; display: none;
    }
    .error-msg.visible { display: block; }
  </style>
</head>
<body>
  <div class="container">
    <div class="logo">Vizlog</div>
    <div class="card">
      <h2>Sign in to authorize</h2>
      <div class="client-info">${clientLabel} is requesting access to your Vizlog context.</div>
      ${errorHtml}
      <form method="POST" action="">
        <input type="hidden" name="response_type" value="${e(params.responseType)}">
        <input type="hidden" name="client_id" value="${e(params.clientId)}">
        <input type="hidden" name="redirect_uri" value="${e(params.redirectUri)}">
        <input type="hidden" name="code_challenge" value="${e(params.codeChallenge)}">
        <input type="hidden" name="code_challenge_method" value="${e(params.codeChallengeMethod)}">
        ${params.state ? `<input type="hidden" name="state" value="${e(params.state)}">` : ""}
        ${params.scope ? `<input type="hidden" name="scope" value="${e(params.scope)}">` : ""}
        ${params.resource ? `<input type="hidden" name="resource" value="${e(params.resource)}">` : ""}
        <div class="form-group">
          <label for="email">Email</label>
          <input type="email" id="email" name="email" autocomplete="email" required value="${emailVal}">
        </div>
        <div class="form-group">
          <label for="password">Password</label>
          <input type="password" id="password" name="password" autocomplete="current-password" minlength="8" required>
        </div>
        <button type="submit" class="btn">Sign In</button>
      </form>
    </div>
  </div>
</body>
</html>`;

  return new Response(html, {
    status: opts?.error ? 200 : 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store, no-cache",
      ...corsHeaders(request),
    },
  });
}

function parseOAuthParamsFromQuery(url: URL): OAuthParams {
  return {
    responseType: url.searchParams.get("response_type") || "",
    clientId: url.searchParams.get("client_id") || "",
    redirectUri: url.searchParams.get("redirect_uri") || "",
    state: url.searchParams.get("state") || undefined,
    codeChallenge: url.searchParams.get("code_challenge") || "",
    codeChallengeMethod: url.searchParams.get("code_challenge_method") || "",
    scope: url.searchParams.get("scope") || undefined,
    resource: url.searchParams.get("resource") || undefined,
  };
}

function parseOAuthParamsFromForm(form: URLSearchParams): OAuthParams {
  return {
    responseType: form.get("response_type") || "",
    clientId: form.get("client_id") || "",
    redirectUri: form.get("redirect_uri") || "",
    state: form.get("state") || undefined,
    codeChallenge: form.get("code_challenge") || "",
    codeChallengeMethod: form.get("code_challenge_method") || "",
    scope: form.get("scope") || undefined,
    resource: form.get("resource") || undefined,
  };
}

function validateOAuthParams(
  request: Request,
  params: OAuthParams,
): Response | null {
  if (params.responseType !== "code") {
    return oauthErrorResponse(request, "unsupported_response_type", 400, "response_type must be code");
  }
  if (!params.clientId || !params.redirectUri || !params.codeChallenge) {
    return oauthErrorResponse(request, "invalid_request", 400, "client_id, redirect_uri, and code_challenge are required");
  }
  if (params.codeChallengeMethod !== "S256") {
    return oauthErrorResponse(request, "invalid_request", 400, "code_challenge_method must be S256");
  }
  return null;
}

async function generateAuthCodeAndRedirect(
  request: Request,
  env: Env,
  userId: number,
  params: OAuthParams,
): Promise<Response> {
  const client = await getOauthClient(env, params.clientId);
  if (!client) {
    return oauthErrorResponse(request, "unauthorized_client", 400, "Unknown client_id");
  }

  const redirectUris = safeJsonArray(client.redirect_uris_json);
  if (!redirectUris.includes(params.redirectUri)) {
    return oauthErrorResponse(request, "invalid_redirect_uri", 400, "redirect_uri is not registered");
  }

  const code = generateAuthorizationCode();
  const codeHash = await sha256Hex(code);
  await env.DB.prepare(
    "INSERT INTO oauth_authorization_codes (code_hash, user_id, client_id, redirect_uri, code_challenge, code_challenge_method, scope, resource, state, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(
      codeHash,
      userId,
      params.clientId,
      params.redirectUri,
      params.codeChallenge,
      params.codeChallengeMethod,
      params.scope || null,
      params.resource || null,
      params.state || null,
      expiresIso(AUTH_CODE_TTL_SECONDS),
    )
    .run();

  const redirect = new URL(params.redirectUri);
  redirect.searchParams.set("code", code);
  if (params.state) redirect.searchParams.set("state", params.state);
  return new Response(null, {
    status: 302,
    headers: {
      Location: redirect.toString(),
      ...corsHeaders(request),
    },
  });
}

async function handleOAuthAuthorize(request: Request, env: Env): Promise<Response> {
  // Case A: GET with valid Bearer token (backward-compatible programmatic flow)
  if (request.method === "GET") {
    const user = await getSessionUserFromAuthToken(request, env);
    if (user) {
      const params = parseOAuthParamsFromQuery(new URL(request.url));
      const validationError = validateOAuthParams(request, params);
      if (validationError) return validationError;
      return generateAuthCodeAndRedirect(request, env, user.id, params);
    }

    // Case B: GET without Bearer token (browser flow — show login page)
    const params = parseOAuthParamsFromQuery(new URL(request.url));
    const validationError = validateOAuthParams(request, params);
    if (validationError) return validationError;

    const client = await getOauthClient(env, params.clientId);
    if (!client) {
      return oauthErrorResponse(request, "unauthorized_client", 400, "Unknown client_id");
    }
    const redirectUris = safeJsonArray(client.redirect_uris_json);
    if (!redirectUris.includes(params.redirectUri)) {
      return oauthErrorResponse(request, "invalid_redirect_uri", 400, "redirect_uri is not registered");
    }

    return renderOAuthLoginPage(request, params, {
      clientName: client.client_name || undefined,
    });
  }

  // Case C: POST (login form submission)
  if (request.method === "POST") {
    const contentType = request.headers.get("Content-Type") || "";
    if (!contentType.includes("application/x-www-form-urlencoded")) {
      return oauthErrorResponse(request, "invalid_request", 400, "Expected form submission");
    }

    const form = new URLSearchParams(await request.text());
    const email = (form.get("email") || "").toLowerCase().trim();
    const password = form.get("password") || "";
    const params = parseOAuthParamsFromForm(form);

    const validationError = validateOAuthParams(request, params);
    if (validationError) return validationError;

    if (!email || !password) {
      return renderOAuthLoginPage(request, params, {
        error: "Email and password are required.",
        email,
      });
    }

    const dbUser = await env.DB.prepare("SELECT id, password_hash FROM users WHERE email = ?")
      .bind(email)
      .first<{ id: number; password_hash: string }>();

    if (!dbUser || !(await verifyPassword(password, dbUser.password_hash))) {
      const client = await getOauthClient(env, params.clientId);
      return renderOAuthLoginPage(request, params, {
        error: "Invalid email or password.",
        email,
        clientName: client?.client_name || undefined,
      });
    }

    return generateAuthCodeAndRedirect(request, env, dbUser.id, params);
  }

  return oauthErrorResponse(request, "invalid_request", 405, "Method not allowed");
}

async function parseTokenRequestBody(request: Request): Promise<URLSearchParams | null> {
  const contentType = request.headers.get("Content-Type") || "";
  if (contentType.includes("application/x-www-form-urlencoded")) {
    return new URLSearchParams(await request.text());
  }
  if (contentType.includes("application/json")) {
    const json = (await request.json()) as Record<string, string>;
    return new URLSearchParams(json);
  }
  return null;
}

async function handleOAuthToken(request: Request, env: Env): Promise<Response> {
  const body = await parseTokenRequestBody(request);
  if (!body) return oauthErrorResponse(request, "invalid_request", 415, "Unsupported Content-Type");

  const grantType = body.get("grant_type") || "";
  const code = body.get("code") || "";
  const clientId = body.get("client_id") || "";
  const redirectUri = body.get("redirect_uri") || "";
  const codeVerifier = body.get("code_verifier") || "";

  if (grantType !== "authorization_code") {
    return oauthErrorResponse(request, "unsupported_grant_type", 400, "grant_type must be authorization_code");
  }
  if (!code || !clientId || !redirectUri || !codeVerifier) {
    return oauthErrorResponse(request, "invalid_request", 400, "code, client_id, redirect_uri, and code_verifier are required");
  }

  const client = await getOauthClient(env, clientId);
  if (!client) return oauthErrorResponse(request, "invalid_client", 400, "Unknown client_id");
  if (client.token_endpoint_auth_method !== "none") {
    return oauthErrorResponse(request, "invalid_client", 400, "Unsupported client auth method");
  }

  const redirectUris = safeJsonArray(client.redirect_uris_json);
  if (!redirectUris.includes(redirectUri)) {
    return oauthErrorResponse(request, "invalid_grant", 400, "redirect_uri is not valid for this client");
  }

  const codeHash = await sha256Hex(code);
  const authCode = await env.DB.prepare(
    "SELECT code_hash, user_id, client_id, redirect_uri, code_challenge, code_challenge_method, scope, expires_at, consumed_at FROM oauth_authorization_codes WHERE code_hash = ?",
  )
    .bind(codeHash)
    .first<{
      code_hash: string;
      user_id: number;
      client_id: string;
      redirect_uri: string;
      code_challenge: string;
      code_challenge_method: string;
      scope: string | null;
      expires_at: string;
      consumed_at: string | null;
    }>();

  if (!authCode) return oauthErrorResponse(request, "invalid_grant", 400, "Unknown authorization code");
  if (authCode.client_id !== clientId || authCode.redirect_uri !== redirectUri) {
    return oauthErrorResponse(request, "invalid_grant", 400, "Authorization code binding mismatch");
  }
  if (authCode.consumed_at) {
    return oauthErrorResponse(request, "invalid_grant", 400, "Authorization code already used");
  }
  if (new Date(authCode.expires_at).getTime() <= Date.now()) {
    return oauthErrorResponse(request, "invalid_grant", 400, "Authorization code expired");
  }

  const computedChallenge = await sha256Base64Url(codeVerifier);
  if (computedChallenge !== authCode.code_challenge || authCode.code_challenge_method !== "S256") {
    return oauthErrorResponse(request, "invalid_grant", 400, "PKCE verification failed");
  }

  const accessToken = generateAccessToken();
  const accessTokenHash = await sha256Hex(accessToken);
  const accessExpiresAt = expiresIso(ACCESS_TOKEN_TTL_SECONDS);

  await env.DB.batch([
    env.DB.prepare("UPDATE oauth_authorization_codes SET consumed_at = ? WHERE code_hash = ?")
      .bind(nowIso(), authCode.code_hash),
    env.DB.prepare(
      "INSERT INTO oauth_access_tokens (token_hash, user_id, client_id, scope, expires_at) VALUES (?, ?, ?, ?, ?)",
    )
      .bind(accessTokenHash, authCode.user_id, clientId, authCode.scope, accessExpiresAt),
  ]);

  return jsonResponse(request, {
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: ACCESS_TOKEN_TTL_SECONDS,
    scope: authCode.scope || undefined,
  });
}

async function handleOauthAccessMe(request: Request, env: Env): Promise<Response> {
  const token = extractBearerToken(request, "oa_");
  if (!token) return oauthErrorResponse(request, "invalid_token", 401, "Missing OAuth access token");

  const tokenHash = await sha256Hex(token);
  const row = await env.DB.prepare(
    "SELECT t.client_id, t.scope, t.expires_at, t.revoked_at, u.id AS user_id, u.email, u.tunnel_id, u.created_at, te.endpoint_url AS tunnel_endpoint FROM oauth_access_tokens t JOIN users u ON u.id = t.user_id LEFT JOIN tunnel_endpoints te ON te.user_id = u.id WHERE t.token_hash = ?",
  )
    .bind(tokenHash)
    .first<{
      client_id: string;
      scope: string | null;
      expires_at: string;
      revoked_at: string | null;
      user_id: number;
      email: string;
      tunnel_id: string;
      created_at: string;
      tunnel_endpoint: string | null;
    }>();

  if (!row || row.revoked_at || new Date(row.expires_at).getTime() <= Date.now()) {
    return oauthErrorResponse(request, "invalid_token", 401, "Token is invalid or expired");
  }

  return jsonResponse(request, {
    userId: row.user_id,
    email: row.email,
    tunnelId: row.tunnel_id,
    tunnelEndpoint: row.tunnel_endpoint,
    createdAt: row.created_at,
    clientId: row.client_id,
    scope: row.scope,
  });
}

async function handleProtectedResourceMetadata(request: Request): Promise<Response> {
  const origin = new URL(request.url).origin;
  return jsonResponse(request, {
    resource: origin,
    bearer_methods_supported: ["header"],
    authorization_servers: [origin],
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (path === "/auth/signup" && request.method === "POST") return await handleSignup(request, env);
      if (path === "/auth/login" && request.method === "POST") return await handleLogin(request, env);
      if (path === "/auth/me" && request.method === "GET") return await handleMe(request, env);
      if (path === "/auth/tunnel-endpoint" && request.method === "POST") {
        return await handleTunnelEndpointUpdate(request, env);
      }
      if (path === "/auth/token/refresh" && request.method === "POST") return await handleTokenRefresh(request, env);
      if (path === "/auth/revoke" && request.method === "POST") return await handleRevoke(request, env);

      if (path === "/.well-known/oauth-authorization-server" && request.method === "GET") {
        return await handleOAuthServerMetadata(request);
      }
      if (path === "/.well-known/oauth-protected-resource" && request.method === "GET") {
        return await handleProtectedResourceMetadata(request);
      }
      if (path === "/oauth/register" && request.method === "POST") return await handleOAuthRegister(request, env);
      if (path === "/oauth/authorize" && (request.method === "GET" || request.method === "POST")) return await handleOAuthAuthorize(request, env);
      if (path === "/oauth/token" && request.method === "POST") return await handleOAuthToken(request, env);
      if (path === "/oauth/me" && request.method === "GET") return await handleOauthAccessMe(request, env);

      return errorResponse(request, "Not found", 404);
    } catch (err) {
      console.error("Unhandled error:", err);
      return errorResponse(request, "Internal server error", 500);
    }
  },
} satisfies ExportedHandler<Env>;
