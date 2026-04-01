import * as dotenv from "dotenv";
import * as path from "path";
import { randomUUID } from "crypto";
import express, { type NextFunction, type Request, type RequestHandler, type Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { CONTEXT_ROOT } from "@context-manager/config";
import { findRelevantPaths, loadResults } from "@context-manager/core";
import { z } from "zod";
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
import { getAuthInfoForLocalRequest, oauthProvider } from "./auth";

dotenv.config({ path: path.join(__dirname, "../../../.env") });

const MCP_HOST = process.env.MCP_SERVER_HOST?.trim() || "127.0.0.1";
const MCP_PORT = Number(process.env.MCP_SERVER_PORT || 4821);

type McpSession = {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
};

const mcpSessions: Record<string, McpSession> = {};
const authRouters = new Map<string, RequestHandler>();

function getBaseUrl(req: Request): string {
  const forwardedProto = String(req.headers["x-forwarded-proto"] || "")
    .split(",")[0]
    ?.trim();
  const proto = forwardedProto || req.protocol || "http";
  const host = String(req.headers.host || `${MCP_HOST}:${MCP_PORT}`).trim();
  return `${proto}://${host}`;
}

function sendJson(res: Response, statusCode: number, payload: unknown): void {
  res.status(statusCode).json(payload);
}

function createMcpServer(): McpServer {
  const server = new McpServer({
    name: "context-manager-mcp-server",
    version: "0.0.1",
  });

  server.registerTool(
    "search_context",
    {
      description:
        "Searches local context chunks via Fireworks relevance ranking and returns matched summary text with frames.",
      inputSchema: {
        query: z.string().describe("Natural language query to match against indexed chunk summaries."),
        contextRoot: z
          .string()
          .optional()
          .describe("Optional override for context root directory (defaults to CONTEXT_ROOT)."),
      },
    },
    async ({ query, contextRoot }) => {
      return await runSearchContext({ query, contextRoot });
    }
  );

  return server;
}

async function runSearchContext(args: unknown): Promise<{
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}> {
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
      isError: true,
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
      isError: true,
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

function isInitializePayload(body: unknown): boolean {
  if (!body || typeof body !== "object") {
    return false;
  }
  return (body as { method?: unknown }).method === "initialize";
}

function getAuthRouter(baseUrlString: string): RequestHandler {
  const existing = authRouters.get(baseUrlString);
  if (existing) {
    return existing;
  }

  const baseUrl = new URL(baseUrlString);
  const router = mcpAuthRouter({
    provider: oauthProvider,
    issuerUrl: baseUrl,
    baseUrl,
    resourceServerUrl: new URL("/mcp", baseUrl),
    scopesSupported: ["mcp:tools"],
    resourceName: "Context Manager MCP",
    authorizationOptions: { rateLimit: false },
    tokenOptions: { rateLimit: false },
    clientRegistrationOptions: { rateLimit: false },
  });
  authRouters.set(baseUrlString, router);
  return router;
}

function authRouterMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (
    req.path === "/authorize" ||
    req.path === "/token" ||
    req.path === "/register" ||
    req.path === "/revoke" ||
    req.path === "/.well-known/oauth-authorization-server" ||
    req.path === "/.well-known/oauth-protected-resource" ||
    req.path === "/.well-known/oauth-protected-resource/mcp"
  ) {
    console.log(`[mcp-auth] ${req.method} ${req.path}`);
  }
  getAuthRouter(getBaseUrl(req))(req, res, next);
}

function requireMcpBearerAuth(req: Request, res: Response, next: NextFunction): void {
  const resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(new URL("/mcp", getBaseUrl(req)));
  requireBearerAuth({
    verifier: oauthProvider,
    requiredScopes: ["mcp:tools"],
    resourceMetadataUrl,
  })(req, res, next);
}

async function handleMcpRequest(req: Request, res: Response): Promise<void> {
  const sessionId = String(req.headers["mcp-session-id"] || "").trim();
  const existingSession = sessionId ? mcpSessions[sessionId] : undefined;

  if (req.method === "GET" || req.method === "DELETE") {
    if (!existingSession) {
      sendJson(res, 400, { error: "Invalid or missing session ID." });
      return;
    }
    console.log(`[mcp] ${req.method} /mcp session=${sessionId}`);
    await existingSession.transport.handleRequest(req, res);
    return;
  }

  if (req.method !== "POST") {
    sendJson(res, 404, { error: "Not found" });
    return;
  }

  const parsedBody = req.body ?? {};
  const method = typeof parsedBody?.method === "string" ? parsedBody.method : "(unknown)";
  console.log(`[mcp] POST /mcp method=${method} session=${sessionId || "(new)"}`);

  let session = existingSession;
  if (!session) {
    if (sessionId || !isInitializePayload(parsedBody)) {
      sendJson(res, 400, {
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message: "Bad Request: No valid session ID provided.",
        },
        id: null,
      });
      return;
    }

    let mcpServer!: McpServer;
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableJsonResponse: true,
      onsessioninitialized: (newSessionId) => {
        mcpSessions[newSessionId] = {
          server: mcpServer,
          transport,
        };
      },
    });

    mcpServer = createMcpServer();
    transport.onclose = () => {
      const activeSessionId = transport.sessionId;
      if (activeSessionId) {
        delete mcpSessions[activeSessionId];
      }
      void mcpServer.close();
    };
    await mcpServer.connect(transport);
    session = {
      server: mcpServer,
      transport,
    };
  }

  await session.transport.handleRequest(req, res, parsedBody);
}

const app = express();
app.set("trust proxy", true);
app.use(express.json({ limit: "5mb" }));

app.get("/auth/info", (req, res) => {
  const authInfo = getAuthInfoForLocalRequest(req);
  if (!authInfo.ok) {
    sendJson(res, authInfo.statusCode, { error: authInfo.error });
    return;
  }
  sendJson(res, 200, { authToken: authInfo.authToken });
});

app.get("/approvals/settings", (_req, res) => {
  sendJson(res, 200, getApprovalSettings());
});

app.post("/approvals/settings", (req, res) => {
  const body = req.body as {
    autoApproveAllRequests?: unknown;
    timeoutMs?: unknown;
  };
  const settings = updateApprovalSettings({
    autoApproveAllRequests:
      typeof body.autoApproveAllRequests === "boolean" ? body.autoApproveAllRequests : undefined,
    timeoutMs: typeof body.timeoutMs === "number" ? body.timeoutMs : undefined,
  });
  sendJson(res, 200, settings);
});

app.get("/approvals/pending", (_req, res) => {
  sendJson(res, 200, { pending: listPendingApprovals(), settings: getApprovalSettings() });
});

app.post("/approvals/approve-all", (_req, res) => {
  const resolvedCount = resolveAllApprovals("approved");
  sendJson(res, 200, { ok: true, resolvedCount });
});

app.post("/approvals/:id", (req, res) => {
  const requestId = String(req.params.id || "").trim();
  if (!requestId) {
    sendJson(res, 400, { error: "Missing approval request id." });
    return;
  }
  const body = req.body as { resolution?: unknown; approved?: unknown };
  const resolution: ApprovalResolution =
    body?.resolution === "approved" || body?.approved === true ? "approved" : "rejected";
  const ok = resolveApproval(requestId, resolution);
  if (!ok) {
    sendJson(res, 404, { error: `No pending approval found for id ${requestId}` });
    return;
  }
  sendJson(res, 200, { ok: true, requestId, resolution });
});

app.get("/health", (_req, res) => {
  sendJson(res, 200, { ok: true });
});

app.use(authRouterMiddleware);

app.all("/mcp", requireMcpBearerAuth, async (req, res) => {
  try {
    await handleMcpRequest(req, res);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    sendJson(res, 500, {
      jsonrpc: "2.0",
      id: null,
      error: { code: -32001, message },
    });
  }
});

app.use((_req, res) => {
  sendJson(res, 404, { error: "Not found" });
});

onApprovalRequest((request) => {
  console.log(`[MCP approval] pending id=${request.id} query="${request.query}"`);

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

app.listen(MCP_PORT, MCP_HOST, () => {
  console.log(`[MCP] listening on http://${MCP_HOST}:${MCP_PORT}`);
  console.log(`[MCP] endpoint: Streamable HTTP /mcp`);
  console.log(`[MCP] auth: /.well-known/oauth-authorization-server, /authorize, /token, /register`);
  console.log(
    `[MCP] approvals: GET /approvals/pending, POST /approvals/:id, POST /approvals/approve-all`
  );
});
