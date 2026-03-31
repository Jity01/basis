import * as dotenv from "dotenv";
import * as http from "http";
import * as path from "path";
import { CONTEXT_ROOT } from "@context-manager/config";
import { findRelevantPaths, loadResults } from "@context-manager/core";
import {
  getApprovalSettings,
  listPendingApprovals,
  onApprovalRequest,
  requestApproval,
  resolveApproval,
  resolveAllApprovals,
  type ApprovalResolution,
  updateApprovalSettings,
} from "./approval";
import {
  beginOAuthAuthorization,
  buildOAuthMetadata,
  exchangeOAuthToken,
  getAuthInfoForLocalRequest,
  validateRequestAuth,
} from "./auth";

dotenv.config({ path: path.join(__dirname, "../../../.env") });

const MCP_HOST = process.env.MCP_SERVER_HOST?.trim() || "127.0.0.1";
const MCP_PORT = Number(process.env.MCP_SERVER_PORT || 4821);

type JsonRpcRequest = {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: unknown;
};

type JsonRpcResponse = {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

function sendJson(res: http.ServerResponse, statusCode: number, payload: unknown): void {
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  return await new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += String(chunk);
      if (body.length > 5_000_000) {
        reject(new Error("Request body too large."));
      }
    });
    req.on("end", () => {
      if (!body.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

async function readTextBody(req: http.IncomingMessage): Promise<string> {
  return await new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += String(chunk);
      if (body.length > 1_000_000) {
        reject(new Error("Request body too large."));
      }
    });
    req.on("end", () => {
      resolve(body);
    });
    req.on("error", reject);
  });
}

function makeResult(id: string | number | null, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

function makeError(
  id: string | number | null,
  code: number,
  message: string,
  data?: unknown
): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message, data } };
}

function getBaseUrl(req: http.IncomingMessage): string {
  const forwardedProto = String(req.headers["x-forwarded-proto"] || "")
    .split(",")[0]
    ?.trim();
  const proto = forwardedProto || "http";
  const host = String(req.headers.host || `${MCP_HOST}:${MCP_PORT}`).trim();
  return `${proto}://${host}`;
}

function toolDefinition() {
  return {
    name: "search_context",
    description:
      "Searches local context chunks via Fireworks relevance ranking and returns raw chunk summaries.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Natural language query to match against indexed chunk summaries.",
        },
        contextRoot: {
          type: "string",
          description: "Optional override for context root directory (defaults to CONTEXT_ROOT).",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
  };
}

async function runSearchContext(args: unknown): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  if (!args || typeof args !== "object") {
    throw new Error("search_context requires an arguments object.");
  }
  const query = String((args as { query?: unknown }).query || "").trim();
  const contextRootInput = String((args as { contextRoot?: unknown }).contextRoot || "").trim();
  const contextRoot = contextRootInput || CONTEXT_ROOT;

  if (!query) {
    throw new Error("search_context requires a non-empty query.");
  }

  const relevantPaths = await findRelevantPaths(query, contextRoot);
  const formatted = await loadResults(relevantPaths);
  const approval = await requestApproval(query, formatted || "(no matching summaries found)");

  if (approval.status === "rejected") {
    return {
      content: [
        {
          type: "text",
          text: "User declined to share context for this query.",
        },
      ],
    };
  }

  if (approval.status === "timeout") {
    return {
      content: [
        {
          type: "text",
          text: "Request timed out.",
        },
      ],
    };
  }

  return {
    content: [
      {
        type: "text",
        text: formatted || "(no matching summaries found)",
      },
    ],
  };
}

async function handleRpcRequest(request: JsonRpcRequest): Promise<JsonRpcResponse> {
  const id = request.id ?? null;
  const method = request.method;

  if (request.jsonrpc !== "2.0" || typeof method !== "string") {
    return makeError(id, -32600, "Invalid JSON-RPC request.");
  }

  if (method === "initialize") {
    return makeResult(id, {
      protocolVersion: "2024-11-05",
      serverInfo: {
        name: "context-manager-mcp-server",
        version: "0.0.1",
      },
      capabilities: {
        tools: {},
      },
    });
  }

  if (method === "tools/list") {
    return makeResult(id, {
      tools: [toolDefinition()],
    });
  }

  if (method === "tools/call") {
    const params = (request.params || {}) as { name?: unknown; arguments?: unknown };
    const name = String(params.name || "");
    if (name !== "search_context") {
      return makeError(id, -32601, `Unknown tool: ${name || "(empty)"}`);
    }
    try {
      const result = await runSearchContext(params.arguments || {});
      return makeResult(id, result);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return makeError(id, -32000, message);
    }
  }

  if (method === "notifications/initialized") {
    return makeResult(id, {});
  }

  return makeError(id, -32601, `Unknown method: ${method}`);
}

async function handleApprovalRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<boolean> {
  const url = new URL(req.url || "/", `http://${MCP_HOST}:${MCP_PORT}`);

  if (req.method === "GET" && url.pathname === "/approvals/settings") {
    sendJson(res, 200, getApprovalSettings());
    return true;
  }

  if (req.method === "POST" && url.pathname === "/approvals/settings") {
    const body = (await readJsonBody(req)) as {
      autoApproveAllRequests?: unknown;
      timeoutMs?: unknown;
    };
    const settings = updateApprovalSettings({
      autoApproveAllRequests:
        typeof body.autoApproveAllRequests === "boolean" ? body.autoApproveAllRequests : undefined,
      timeoutMs: typeof body.timeoutMs === "number" ? body.timeoutMs : undefined,
    });
    sendJson(res, 200, settings);
    return true;
  }

  if (req.method === "GET" && url.pathname === "/approvals/pending") {
    sendJson(res, 200, { pending: listPendingApprovals(), settings: getApprovalSettings() });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/approvals/approve-all") {
    const resolvedCount = resolveAllApprovals("approved");
    sendJson(res, 200, { ok: true, resolvedCount });
    return true;
  }

  if (req.method === "POST" && url.pathname.startsWith("/approvals/")) {
    const requestId = url.pathname.replace("/approvals/", "").trim();
    if (!requestId) {
      sendJson(res, 400, { error: "Missing approval request id." });
      return true;
    }
    const body = (await readJsonBody(req)) as { resolution?: unknown; approved?: unknown };
    const resolution: ApprovalResolution =
      body?.resolution === "approved" || body?.approved === true ? "approved" : "rejected";
    const ok = resolveApproval(requestId, resolution);
    if (!ok) {
      sendJson(res, 404, { error: `No pending approval found for id ${requestId}` });
      return true;
    }
    sendJson(res, 200, { ok: true, requestId, resolution });
    return true;
  }

  return false;
}

async function handlePublicAuthRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<boolean> {
  const url = new URL(req.url || "/", getBaseUrl(req));
  const baseUrl = getBaseUrl(req);

  if (req.method === "GET" && url.pathname === "/auth/info") {
    const authInfo = getAuthInfoForLocalRequest(req);
    if (!authInfo.ok) {
      sendJson(res, authInfo.statusCode, { error: authInfo.error });
      return true;
    }
    sendJson(res, 200, { authToken: authInfo.authToken });
    return true;
  }

  if (
    req.method === "GET" &&
    (url.pathname === "/.well-known/oauth-authorization-server" ||
      url.pathname === "/.well-known/openid-configuration")
  ) {
    sendJson(res, 200, buildOAuthMetadata(baseUrl));
    return true;
  }

  if (req.method === "GET" && url.pathname === "/oauth/authorize") {
    const responseType = String(url.searchParams.get("response_type") || "");
    const clientId = String(url.searchParams.get("client_id") || "");
    const redirectUri = String(url.searchParams.get("redirect_uri") || "");
    const state = String(url.searchParams.get("state") || "");
    const codeChallenge = url.searchParams.get("code_challenge");
    const codeChallengeMethodParam = url.searchParams.get("code_challenge_method");
    const codeChallengeMethod =
      codeChallengeMethodParam === "S256" || codeChallengeMethodParam === "plain"
        ? codeChallengeMethodParam
        : null;

    const authz = beginOAuthAuthorization({
      clientId,
      redirectUri,
      responseType,
      state,
      codeChallenge: codeChallenge ? codeChallenge.trim() : null,
      codeChallengeMethod,
    });
    if (!authz.ok) {
      sendJson(res, authz.statusCode, { error: authz.error });
      return true;
    }
    res.writeHead(302, { Location: authz.redirectTo });
    res.end();
    return true;
  }

  if (req.method === "POST" && url.pathname === "/oauth/token") {
    const contentType = String(req.headers["content-type"] || "").toLowerCase();
    let body: URLSearchParams;
    if (contentType.includes("application/x-www-form-urlencoded")) {
      body = new URLSearchParams(await readTextBody(req));
    } else {
      const parsed = (await readJsonBody(req)) as Record<string, unknown>;
      body = new URLSearchParams();
      for (const [key, value] of Object.entries(parsed || {})) {
        if (value != null) {
          body.set(key, String(value));
        }
      }
    }

    const token = exchangeOAuthToken({
      grantType: body.get("grant_type") || "",
      code: body.get("code") || "",
      redirectUri: body.get("redirect_uri") || "",
      clientId: body.get("client_id") || "",
      codeVerifier: body.get("code_verifier"),
      refreshToken: body.get("refresh_token"),
    });
    if (!token.ok) {
      sendJson(res, token.statusCode, { error: token.error });
      return true;
    }
    sendJson(res, 200, token.payload);
    return true;
  }

  return false;
}

onApprovalRequest((request) => {
  console.log(`[MCP approval] pending id=${request.id} query="${request.query}"`);

  // If this process was spawned by Electron, forward request details over Node IPC.
  if (typeof process.send === "function") {
    process.send({
      type: "mcp-approval-request",
      payload: request,
    });
  }
});

process.on("message", (msg: unknown) => {
  const payload = msg as {
    type?: string;
    payload?: { requestId?: unknown; resolution?: unknown };
  };
  if (payload?.type !== "mcp-approval-response") {
    return;
  }
  const requestId = String(payload.payload?.requestId || "").trim();
  const resolution = payload.payload?.resolution;
  if (!requestId || (resolution !== "approved" && resolution !== "rejected")) {
    return;
  }
  resolveApproval(requestId, resolution);
});

const server = http.createServer(async (req, res) => {
  try {
    const handledPublicAuthRoute = await handlePublicAuthRoute(req, res);
    if (handledPublicAuthRoute) {
      return;
    }

    const handledApprovalRoute = await handleApprovalRoute(req, res);
    if (handledApprovalRoute) {
      return;
    }

    if (req.method === "GET" && req.url === "/health") {
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method !== "POST" || req.url !== "/mcp") {
      sendJson(res, 404, { error: "Not found" });
      return;
    }

    const auth = validateRequestAuth(req);
    if (!auth.ok) {
      sendJson(res, auth.statusCode, { error: auth.error });
      return;
    }

    const parsed = (await readJsonBody(req)) as JsonRpcRequest;
    const rpcResponse = await handleRpcRequest(parsed);
    sendJson(res, 200, rpcResponse);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    sendJson(res, 500, {
      jsonrpc: "2.0",
      id: null,
      error: { code: -32001, message },
    });
  }
});

server.listen(MCP_PORT, MCP_HOST, () => {
  console.log(`[MCP] listening on http://${MCP_HOST}:${MCP_PORT}`);
  console.log(`[MCP] endpoint: POST /mcp`);
  console.log(
    `[MCP] approvals: GET /approvals/pending, POST /approvals/:id, POST /approvals/approve-all`
  );
});
