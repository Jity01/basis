export interface Env {
  AUTH_SERVICE?: Fetcher;
  FIREWORKS_API_KEY: string;  // Secret — set via: wrangler secret put FIREWORKS_API_KEY
  ANTHROPIC_API_KEY: string;  // Secret — set via: wrangler secret put ANTHROPIC_API_KEY
  AUTH_SERVICE_URL: string;
  FIREWORKS_BASE_URL: string;
  ANTHROPIC_BASE_URL: string;
}

const ALLOWED_ORIGINS = [
  "https://vizlog.ai",
  "https://www.vizlog.ai",
  "http://localhost:3000",
  "http://localhost:5173",
  "http://127.0.0.1:5173",
];

function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

function fetchAuth(env: Env, path: string, init?: RequestInit): Promise<Response> {
  if (env.AUTH_SERVICE) {
    return env.AUTH_SERVICE.fetch(`https://auth.internal${path}`, init);
  }
  return fetch(`${normalizeBaseUrl(env.AUTH_SERVICE_URL)}${path}`, init);
}

function getCorsHeaders(request: Request): Record<string, string> {
  const origin = request.headers.get("Origin") || "";
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, x-api-key, anthropic-version",
    "Access-Control-Max-Age": "86400",
  };
}

function corsResponse(status: number, body: string, request: Request): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": "application/json", ...getCorsHeaders(request) },
  });
}

/**
 * Validate the caller's jr_ token against the auth service.
 * Returns the user info on success, or null on failure.
 */
async function validateToken(
  token: string,
  env: Env
): Promise<{ email: string; tunnelId?: string } | null> {
  try {
    const res = await fetchAuth(env, "/auth/me", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { email: string; tunnelId?: string };
    return data;
  } catch {
    return null;
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Handle CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: getCorsHeaders(request) });
    }

    // --- 1. Extract and validate auth token ---
    // Accept token from Authorization: Bearer or x-api-key (Anthropic SDK sends x-api-key by default)
    const authHeader = request.headers.get("Authorization");
    const xApiKey = request.headers.get("x-api-key");
    let token: string | null = null;
    if (authHeader?.startsWith("Bearer ")) {
      token = authHeader.slice("Bearer ".length);
    } else if (xApiKey) {
      token = xApiKey;
    }
    if (!token) {
      return corsResponse(401, JSON.stringify({ error: "Missing authorization token" }), request);
    }
    const authResult = await validateToken(token, env);
    if (!authResult) {
      return corsResponse(401, JSON.stringify({ error: "Invalid or expired token" }), request);
    }

    // --- 2. Determine upstream target (Fireworks or Anthropic) ---
    const url = new URL(request.url);
    const isAnthropicRoute = url.pathname.startsWith("/v1/messages");
    const anthropicBaseUrl = env.ANTHROPIC_BASE_URL || "https://api.anthropic.com";
    const pathWithQuery = `${url.pathname}${url.search}`;

    const upstreamUrl = isAnthropicRoute
      ? `${anthropicBaseUrl}${pathWithQuery}`
      : `${env.FIREWORKS_BASE_URL}${pathWithQuery}`;

    // Forward all headers except auth/host
    const upstreamHeaders = new Headers();
    for (const [key, value] of request.headers.entries()) {
      if (key.toLowerCase() === "authorization") continue;
      if (key.toLowerCase() === "x-api-key") continue;
      if (key.toLowerCase() === "host") continue;
      upstreamHeaders.set(key, value);
    }

    if (isAnthropicRoute) {
      // Anthropic uses x-api-key header
      upstreamHeaders.set("x-api-key", env.ANTHROPIC_API_KEY);
      // Ensure anthropic-version is set
      if (!upstreamHeaders.has("anthropic-version")) {
        upstreamHeaders.set("anthropic-version", "2023-06-01");
      }
    } else {
      // Fireworks uses Bearer token
      upstreamHeaders.set("Authorization", `Bearer ${env.FIREWORKS_API_KEY}`);
    }

    // --- 3. Forward request to upstream (stream the body through) ---
    let requestBody: ReadableStream<Uint8Array> | null = null;
    let requestClone: Request | null = null;

    if (request.body) {
      // Tee the body: one for forwarding, one for extracting model info for logging
      const [forwardStream, logStream] = request.body.tee();
      requestBody = forwardStream;
      requestClone = new Request(request.url, {
        method: request.method,
        headers: request.headers,
        body: logStream,
      });
    }

    let upstreamResponse: Response;
    try {
      upstreamResponse = await fetch(upstreamUrl, {
        method: request.method,
        headers: upstreamHeaders,
        body: requestBody,
      });
    } catch (err) {
      return corsResponse(502, JSON.stringify({ error: "Failed to reach inference provider" }), request);
    }

    // --- 4. Stream the response back to the client ---
    const responseHeaders = new Headers(upstreamResponse.headers);
    for (const [key, value] of Object.entries(getCorsHeaders(request))) {
      responseHeaders.set(key, value);
    }

    // --- 5. Log usage (best-effort, non-blocking) ---
    // Extract model from the request body for logging
    let model: string | undefined;
    if (requestClone) {
      try {
        const body = (await requestClone.json()) as { model?: string };
        model = body.model;
      } catch {
        // Body may not be JSON or may be too large — skip
      }
    }

    console.log(
      JSON.stringify({
        type: "usage",
        userId: authResult.email,
        tunnelId: authResult.tunnelId,
        model,
        timestamp: new Date().toISOString(),
      })
    );

    return new Response(upstreamResponse.body, {
      status: upstreamResponse.status,
      headers: responseHeaders,
    });
  },
};
