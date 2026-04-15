export interface Env {
  AUTH_SERVICE_URL: string;
  TUNNEL_DOMAIN: string;
  CF_ACCOUNT_ID: string;
  CF_TUNNEL_API_TOKEN: string;
  VIZLOG_TUNNEL_SECRET: string;
}

const ALLOWED_ORIGINS = [
  "https://vizlog.ai",
  "https://www.vizlog.ai",
  "http://localhost:3000",
  "http://localhost:5173",
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
    const resp = await fetch(`${env.AUTH_SERVICE_URL}/auth/me`, {
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
    const resp = await fetch(`${env.AUTH_SERVICE_URL}/oauth/me`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!resp.ok) return null;
    return (await resp.json()) as OAuthUser;
  } catch {
    return null;
  }
}

function tunnelUrl(tunnelId: string, tunnelDomain: string, pathWithQuery: string): string {
  return `https://${tunnelId}.${tunnelDomain}${pathWithQuery}`;
}

async function proxyToTunnel(
  request: Request,
  user: { email: string; tunnelId: string },
  env: Env,
  targetPathWithQuery: string,
): Promise<Response> {
  const url = tunnelUrl(user.tunnelId, env.TUNNEL_DOMAIN, targetPathWithQuery);

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

  if (userId !== "me" && userId !== oauthUser.tunnelId) {
    return errorResponse(request, "Forbidden user resource", 403);
  }

  return proxyToTunnel(request, oauthUser, env, `/mcp${url.search}`);
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

  let cfTunnelResp: Response;
  try {
    cfTunnelResp = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/tunnels`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.CF_TUNNEL_API_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: user.tunnelId,
        tunnel_secret: tunnelSecretB64,
      }),
    });
  } catch {
    return errorResponse(request, "Failed to connect to Cloudflare API", 502);
  }

  if (!cfTunnelResp.ok) {
    const errBody = await cfTunnelResp.text();
    if (cfTunnelResp.status === 409) {
      return errorResponse(request, "Tunnel already exists for this account", 409);
    }
    console.error("Cloudflare tunnel creation failed:", cfTunnelResp.status, errBody);
    return errorResponse(request, "Failed to provision tunnel", 502);
  }

  const cfResult = (await cfTunnelResp.json()) as {
    success: boolean;
    result: {
      id: string;
      credentials_file: {
        AccountTag: string;
        TunnelID: string;
        TunnelSecret: string;
      };
    };
  };

  if (!cfResult.success) {
    return errorResponse(request, "Cloudflare API returned an error", 502);
  }

  const tunnel = cfResult.result;
  const hostname = `${user.tunnelId}.${env.TUNNEL_DOMAIN}`;

  try {
    await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/tunnels/${tunnel.id}/configurations`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${env.CF_TUNNEL_API_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          config: {
            ingress: [
              { hostname, service: "http://localhost:3847" },
              { service: "http_status:404" },
            ],
          },
        }),
      },
    );
  } catch {
    console.error("Failed to configure tunnel DNS route");
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
    },
    201,
  );
}

async function passthroughToAuth(request: Request, env: Env, authPath: string): Promise<Response> {
  const incomingUrl = new URL(request.url);
  const upstreamUrl = `${env.AUTH_SERVICE_URL}${authPath}${incomingUrl.search}`;

  const headers = new Headers(request.headers);
  headers.delete("host");

  const upstream = await fetch(upstreamUrl, {
    method: request.method,
    headers,
    body: request.method === "GET" ? undefined : request.body,
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
    upstream_authorization_server: env.AUTH_SERVICE_URL,
  });
}

function protectedResourceMetadata(request: Request, env: Env): Response {
  const origin = new URL(request.url).origin;
  return jsonResponse(request, {
    resource: origin,
    authorization_servers: [env.AUTH_SERVICE_URL],
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
      if (path === "/authorize" && request.method === "GET") {
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
