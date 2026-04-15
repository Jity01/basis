export interface Env {
  AUTH_SERVICE?: Fetcher;
  AUTH_SERVICE_URL: string;
  TUNNEL_DOMAIN: string;
  CF_ZONE_NAME?: string;
  CF_ZONE_ID?: string;
  CF_ACCOUNT_ID: string;
  CF_TUNNEL_API_TOKEN: string;
  VIZLOG_TUNNEL_SECRET: string;
}

const ALLOWED_ORIGINS = [
  "https://vizlog.ai",
  "https://www.vizlog.ai",
  "http://localhost:3000",
  "http://localhost:5173",
  "http://127.0.0.1:5173",
];

type SessionUser = {
  email: string;
  tunnelId: string;
  createdAt: string;
};

type OAuthUser = {
  userId: number;
  email: string;
  tunnelId: string;
  createdAt: string;
  clientId: string;
  scope?: string;
};

function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

function normalizeTunnelLabel(tunnelId: string): string {
  const label = tunnelId
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  if (!label) {
    throw new Error("Invalid tunnel ID label.");
  }
  return label;
}

function getUserTunnelHostname(tunnelId: string, tunnelDomain: string): string {
  return `${normalizeTunnelLabel(tunnelId)}.${tunnelDomain}`;
}

function cloudflareHeaders(env: Env): Record<string, string> {
  return {
    Authorization: `Bearer ${env.CF_TUNNEL_API_TOKEN}`,
    "Content-Type": "application/json",
  };
}

function fetchAuth(env: Env, pathWithQuery: string, init?: RequestInit): Promise<Response> {
  if (env.AUTH_SERVICE) {
    return env.AUTH_SERVICE.fetch(`https://auth.internal${pathWithQuery}`, init);
  }
  return fetch(`${normalizeBaseUrl(env.AUTH_SERVICE_URL)}${pathWithQuery}`, init);
}

function corsHeaders(request: Request): Record<string, string> {
  const origin = request.headers.get("Origin") || "";
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
  };
}

function jsonResponse(request: Request, body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...corsHeaders(request) },
  });
}

function errorResponse(request: Request, error: string, status: number): Response {
  return jsonResponse(request, { error }, status);
}

function extractBearerToken(request: Request): string | null {
  const auth = request.headers.get("Authorization");
  if (!auth || !auth.startsWith("Bearer ")) return null;
  return auth.slice(7).trim() || null;
}

async function validateSessionToken(token: string, env: Env): Promise<SessionUser | null> {
  try {
    const resp = await fetchAuth(env, "/auth/me", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!resp.ok) return null;
    return (await resp.json()) as SessionUser;
  } catch {
    return null;
  }
}

async function validateOAuthToken(token: string, env: Env): Promise<OAuthUser | null> {
  try {
    const resp = await fetchAuth(env, "/oauth/me", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!resp.ok) return null;
    return (await resp.json()) as OAuthUser;
  } catch {
    return null;
  }
}

async function proxyToTunnel(
  request: Request,
  user: { email: string; tunnelHostname: string },
  env: Env,
  targetPathWithQuery: string,
): Promise<Response> {
  const url = `https://${user.tunnelHostname}${targetPathWithQuery}`;

  const headers = new Headers(request.headers);
  headers.set("X-Vizlog-Tunnel-Secret", env.VIZLOG_TUNNEL_SECRET);
  headers.set("X-Vizlog-User-Email", user.email);
  headers.delete("Authorization");

  try {
    const tunnelResp = await fetch(url, {
      method: request.method,
      headers,
      body: request.body,
      // @ts-expect-error Cloudflare Workers supports duplex on streamed requests.
      duplex: "half",
    });

    const responseHeaders = new Headers(tunnelResp.headers);
    for (const [k, v] of Object.entries(corsHeaders(request))) {
      responseHeaders.set(k, v);
    }

    return new Response(tunnelResp.body, {
      status: tunnelResp.status,
      headers: responseHeaders,
    });
  } catch {
    return errorResponse(request, "User's Vizlog is offline", 503);
  }
}

async function handleMcpRequest(request: Request, userId: string, env: Env): Promise<Response> {
  const url = new URL(request.url);

  let token = extractBearerToken(request);
  if (!token && request.method === "GET") {
    token = url.searchParams.get("token");
  }
  if (!token) {
    return errorResponse(request, "Missing or invalid authorization token", 401);
  }

  const oauthUser = await validateOAuthToken(token, env);
  if (!oauthUser) {
    return errorResponse(request, "Invalid OAuth access token", 401);
  }

  const tunnelHostname = getUserTunnelHostname(oauthUser.tunnelId, env.TUNNEL_DOMAIN);

  if (userId !== "me" && userId !== oauthUser.tunnelId) {
    return errorResponse(request, "Forbidden user resource", 403);
  }

  return proxyToTunnel(request, { email: oauthUser.email, tunnelHostname }, env, `/mcp${url.search}`);
}

type CloudflareTunnelResult = {
  id: string;
  credentials_file: {
    AccountTag: string;
    TunnelID: string;
    TunnelSecret: string;
  };
};

async function createTunnel(env: Env, tunnelName: string, tunnelSecretB64: string): Promise<Response> {
  return fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/tunnels`, {
    method: "POST",
    headers: cloudflareHeaders(env),
    body: JSON.stringify({
      name: tunnelName,
      tunnel_secret: tunnelSecretB64,
    }),
  });
}

async function deleteExistingTunnelByName(env: Env, tunnelName: string): Promise<void> {
  const listResp = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/tunnels?name=${encodeURIComponent(tunnelName)}`,
    {
      headers: {
        Authorization: `Bearer ${env.CF_TUNNEL_API_TOKEN}`,
      },
    },
  );
  if (!listResp.ok) {
    return;
  }

  const listBody = (await listResp.json()) as {
    success?: boolean;
    result?: Array<{ id: string; name: string }>;
  };
  const matches = (listBody.result || []).filter((item) => item.name === tunnelName);
  await Promise.all(
    matches.map((item) =>
      fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/tunnels/${item.id}`, {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${env.CF_TUNNEL_API_TOKEN}`,
        },
      }),
    ),
  );
}

type CloudflareApiResponse<T> = {
  success: boolean;
  errors?: Array<{ code?: number; message?: string }>;
  result?: T;
};

async function getZoneId(env: Env): Promise<string> {
  if (env.CF_ZONE_ID?.trim()) {
    return env.CF_ZONE_ID.trim();
  }

  const zoneName = (env.CF_ZONE_NAME || env.TUNNEL_DOMAIN || "").trim();
  if (!zoneName) {
    throw new Error("Missing CF_ZONE_ID or CF_ZONE_NAME.");
  }

  const resp = await fetch(`https://api.cloudflare.com/client/v4/zones?name=${encodeURIComponent(zoneName)}`, {
    headers: {
      Authorization: `Bearer ${env.CF_TUNNEL_API_TOKEN}`,
    },
  });
  if (!resp.ok) {
    throw new Error(`Failed to fetch zone ID (${resp.status}).`);
  }

  const body = (await resp.json()) as CloudflareApiResponse<Array<{ id: string }>>;
  const zoneId = body.result?.[0]?.id;
  if (!body.success || !zoneId) {
    throw new Error(`Failed to resolve zone ID for ${zoneName}.`);
  }
  return zoneId;
}

async function upsertTunnelDnsRecord(env: Env, hostname: string, tunnelUuid: string): Promise<void> {
  const zoneId = await getZoneId(env);
  const target = `${tunnelUuid}.cfargotunnel.com`;

  const existingResp = await fetch(
    `https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records?type=CNAME&name=${encodeURIComponent(hostname)}`,
    {
      headers: {
        Authorization: `Bearer ${env.CF_TUNNEL_API_TOKEN}`,
      },
    },
  );
  if (!existingResp.ok) {
    throw new Error(`Failed to query DNS records (${existingResp.status}).`);
  }

  const existingBody = (await existingResp.json()) as CloudflareApiResponse<Array<{ id: string }>>;
  if (!existingBody.success) {
    throw new Error("Cloudflare DNS lookup failed.");
  }

  const existingId = existingBody.result?.[0]?.id;
  const method = existingId ? "PUT" : "POST";
  const endpoint = existingId
    ? `https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records/${existingId}`
    : `https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records`;

  const upsertResp = await fetch(endpoint, {
    method,
    headers: cloudflareHeaders(env),
    body: JSON.stringify({
      type: "CNAME",
      name: hostname,
      content: target,
      proxied: true,
      ttl: 1,
    }),
  });

  if (!upsertResp.ok) {
    throw new Error(`Failed to upsert DNS record (${upsertResp.status}).`);
  }
  const upsertBody = (await upsertResp.json()) as CloudflareApiResponse<{ id: string }>;
  if (!upsertBody.success) {
    const msg = upsertBody.errors?.[0]?.message || "Cloudflare DNS upsert failed.";
    throw new Error(msg);
  }
}

async function createTunnelWithConflictRecovery(
  env: Env,
  tunnelName: string,
  tunnelSecretB64: string,
): Promise<CloudflareTunnelResult> {
  let createResp = await createTunnel(env, tunnelName, tunnelSecretB64);
  if (createResp.status === 409) {
    await deleteExistingTunnelByName(env, tunnelName);
    createResp = await createTunnel(env, tunnelName, tunnelSecretB64);
  }

  if (!createResp.ok) {
    const body = await createResp.text();
    throw new Error(`Cloudflare create tunnel failed (${createResp.status}): ${body.slice(0, 1000)}`);
  }

  const parsed = (await createResp.json()) as {
    success: boolean;
    result?: CloudflareTunnelResult;
  };
  if (!parsed.success || !parsed.result) {
    throw new Error("Cloudflare API returned an invalid tunnel response");
  }
  return parsed.result;
}

async function handleTunnelProvision(request: Request, env: Env): Promise<Response> {
  const token = extractBearerToken(request);
  if (!token || !token.startsWith("jr_")) {
    return errorResponse(request, "Missing or invalid authorization token", 401);
  }

  const user = await validateSessionToken(token, env);
  if (!user) {
    return errorResponse(request, "Invalid token", 401);
  }

  const tunnelSecretBytes = crypto.getRandomValues(new Uint8Array(32));
  const tunnelSecretB64 = btoa(String.fromCharCode(...tunnelSecretBytes));

  let tunnel: CloudflareTunnelResult;
  try {
    tunnel = await createTunnelWithConflictRecovery(env, user.tunnelId, tunnelSecretB64);
  } catch {
    return errorResponse(request, "Failed to provision tunnel", 502);
  }
  const hostname = getUserTunnelHostname(user.tunnelId, env.TUNNEL_DOMAIN);

  try {
    await upsertTunnelDnsRecord(env, hostname, tunnel.id);
  } catch (err) {
    console.error("Failed to configure tunnel DNS route:", err);
    return errorResponse(request, "Failed to configure tunnel DNS", 502);
  }

  return jsonResponse(
    request,
    {
      tunnelId: user.tunnelId,
      credentials: {
        AccountTag: tunnel.credentials_file.AccountTag,
        TunnelID: tunnel.credentials_file.TunnelID,
        TunnelSecret: tunnel.credentials_file.TunnelSecret,
      },
      hostname,
      endpointUrl: `https://${hostname}`,
    },
    201,
  );
}

async function passthroughToAuth(request: Request, env: Env, authPath: string): Promise<Response> {
  const incomingUrl = new URL(request.url);
  const headers = new Headers(request.headers);
  headers.delete("host");

  const upstream = await fetchAuth(env, `${authPath}${incomingUrl.search}`, {
    method: request.method,
    headers,
    body: request.method === "GET" ? undefined : request.body,
    redirect: "manual",
  });

  const responseHeaders = new Headers(upstream.headers);
  for (const [k, v] of Object.entries(corsHeaders(request))) {
    responseHeaders.set(k, v);
  }
  return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
}

function authServerMetadata(request: Request, env: Env): Response {
  const origin = new URL(request.url).origin;
  return jsonResponse(request, {
    issuer: origin,
    authorization_endpoint: `${origin}/authorize`,
    token_endpoint: `${origin}/token`,
    registration_endpoint: `${origin}/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    token_endpoint_auth_methods_supported: ["none"],
    code_challenge_methods_supported: ["S256"],
    upstream_authorization_server: normalizeBaseUrl(env.AUTH_SERVICE_URL),
  });
}

function protectedResourceMetadata(request: Request, env: Env): Response {
  const origin = new URL(request.url).origin;
  return jsonResponse(request, {
    resource: origin,
    authorization_servers: [origin],
    bearer_methods_supported: ["header"],
  });
}

interface RouteMatch {
  params: Record<string, string>;
}

function matchRoute(pattern: string, path: string): RouteMatch | null {
  const patternParts = pattern.split("/");
  const pathParts = path.split("/");
  if (patternParts.length !== pathParts.length) return null;

  const params: Record<string, string> = {};
  for (let i = 0; i < patternParts.length; i++) {
    const pp = patternParts[i];
    if (pp.startsWith(":")) params[pp.slice(1)] = pathParts[i];
    else if (pp !== pathParts[i]) return null;
  }
  return { params };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (path === "/.well-known/oauth-authorization-server" && request.method === "GET") {
        return authServerMetadata(request, env);
      }
      if (path === "/.well-known/oauth-protected-resource" && request.method === "GET") {
        return protectedResourceMetadata(request, env);
      }

      if (path === "/register" && request.method === "POST") {
        return passthroughToAuth(request, env, "/oauth/register");
      }
      if (path === "/authorize" && (request.method === "GET" || request.method === "POST")) {
        return passthroughToAuth(request, env, "/oauth/authorize");
      }
      if (path === "/token" && request.method === "POST") {
        return passthroughToAuth(request, env, "/oauth/token");
      }

      if (path === "/tunnel/provision" && request.method === "POST") {
        return await handleTunnelProvision(request, env);
      }

      const mcpMatch = matchRoute("/v1/:userId/mcp", path);
      if (mcpMatch) {
        if (request.method === "POST" || request.method === "GET" || request.method === "DELETE") {
          return await handleMcpRequest(request, mcpMatch.params.userId, env);
        }
        return errorResponse(request, "Method not allowed", 405);
      }

      return errorResponse(request, "Not found", 404);
    } catch (err) {
      console.error("Unhandled error:", err);
      return errorResponse(request, "Internal server error", 500);
    }
  },
} satisfies ExportedHandler<Env>;
