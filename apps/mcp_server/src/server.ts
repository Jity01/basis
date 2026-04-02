import * as dotenv from "dotenv";
import * as path from "path";
import { randomUUID } from "crypto";
import express, { type NextFunction, type Request, type RequestHandler, type Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { CONTEXT_ROOT } from "@context-manager/config";
import { getChunkContext, getDayIndex, listDays } from "@context-manager/core";
import { z } from "zod";
import {
  formatApprovalPayload,
  getApprovalSettings,
  listPendingApprovals,
  onApprovalRequest,
  requestApproval,
  resolveApproval,
  resolveAllApprovals,
  type ApprovalPayload,
  type ApprovalResolution,
  type ChunkContextApprovalPayload,
  type DayIndexApprovalPayload,
  type DayListApprovalPayload,
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
const DEFAULT_LIST_DAYS_LIMIT = 14;

type TextToolContent = { type: "text"; text: string };
type ImageToolContent = { type: "image"; data: string; mimeType: string };
type ToolContent = TextToolContent | ImageToolContent;
type ToolResult = {
  content: ToolContent[];
  isError?: boolean;
};

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

function makeTextResult(text: string, isError = false): ToolResult {
  return {
    content: [{ type: "text", text }],
    ...(isError ? { isError: true } : {}),
  };
}

async function approvePayloadOrError(
  query: string,
  title: string,
  payload: ApprovalPayload
): Promise<{ approvedPayload: ApprovalPayload } | ToolResult> {
  const approval = await requestApproval({
    query,
    title,
    payload,
  });
  if (approval.status === "rejected") {
    return makeTextResult("User declined to share this context.", true);
  }
  if (approval.status === "timeout") {
    return makeTextResult("Request timed out.", true);
  }
  return { approvedPayload: approval.approvedPayload ?? payload };
}

function toolResultFromPayload(payload: ApprovalPayload): ToolResult {
  if (payload.kind !== "chunk_context") {
    return makeTextResult(formatApprovalPayload(payload));
  }
  return {
    content: [
      { type: "text", text: formatApprovalPayload(payload) },
      ...payload.frames.map((frame) => ({
        type: "image" as const,
        data: frame.data,
        mimeType: frame.mimeType,
      })),
    ],
  };
}

function createMcpServer(): McpServer {
  const server = new McpServer({
    name: "context-manager-mcp-server",
    version: "0.0.1",
  });

  server.registerTool(
    "list_days",
    {
      description:
        "Lists available context days with lightweight metadata such as chunk counts and time ranges.",
      inputSchema: {
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe("Optional maximum number of days to return (defaults to 14)."),
        contextRoot: z
          .string()
          .optional()
          .describe("Optional override for context root directory (defaults to CONTEXT_ROOT)."),
      },
    },
    async ({ limit, contextRoot }) => {
      return await runListDays({ limit, contextRoot });
    }
  );

  server.registerTool(
    "get_day_index",
    {
      description:
        "Returns one day's index.txt content plus chunk metadata for deterministic browsing.",
      inputSchema: {
        date: z.string().describe("Day to inspect, formatted as YYYY-MM-DD."),
        contextRoot: z
          .string()
          .optional()
          .describe("Optional override for context root directory (defaults to CONTEXT_ROOT)."),
      },
    },
    async ({ date, contextRoot }) => {
      return await runGetDayIndex({ date, contextRoot });
    }
  );

  server.registerTool(
    "get_chunk_context",
    {
      description:
        "Returns one chunk's reconstructed summary, metadata, and frame images for a specific chunk key.",
      inputSchema: {
        chunkKey: z
          .string()
          .describe("Chunk key to inspect, formatted as YYYY-MM-DD/HH-MM."),
        contextRoot: z
          .string()
          .optional()
          .describe("Optional override for context root directory (defaults to CONTEXT_ROOT)."),
      },
    },
    async ({ chunkKey, contextRoot }) => {
      return await runGetChunkContext({ chunkKey, contextRoot });
    }
  );

  return server;
}

async function runListDays(args: unknown): Promise<ToolResult> {
  if (!args || typeof args !== "object") {
    throw new Error("list_days requires an arguments object.");
  }
  const limitInput = (args as { limit?: unknown }).limit;
  const contextRootInput = String((args as { contextRoot?: unknown }).contextRoot || "").trim();
  const contextRoot = contextRootInput || CONTEXT_ROOT;
  const limit =
    typeof limitInput === "number" && Number.isFinite(limitInput)
      ? Math.max(1, Math.trunc(limitInput))
      : DEFAULT_LIST_DAYS_LIMIT;

  const days = await listDays(contextRoot, limit);
  const payload: DayListApprovalPayload = {
    kind: "day_list",
    days,
  };
  const approval = await approvePayloadOrError("Share context day list", "Share context day list", payload);
  if ("content" in approval) {
    return approval;
  }

  return toolResultFromPayload(approval.approvedPayload);
}

async function runGetDayIndex(args: unknown): Promise<ToolResult> {
  if (!args || typeof args !== "object") {
    throw new Error("get_day_index requires an arguments object.");
  }
  const date = String((args as { date?: unknown }).date || "").trim();
  const contextRootInput = String((args as { contextRoot?: unknown }).contextRoot || "").trim();
  const contextRoot = contextRootInput || CONTEXT_ROOT;

  if (!date) {
    throw new Error("get_day_index requires a non-empty date.");
  }

  const day = await getDayIndex(date, contextRoot);
  const payload: DayIndexApprovalPayload = {
    kind: "day_index",
    date: day.date,
    chunkCount: day.chunkCount,
    chunkKeys: day.chunkKeys,
    indexText: day.indexText,
  };
  const approval = await approvePayloadOrError(
    `Share context day ${day.date}`,
    `Share context day ${day.date}`,
    payload
  );
  if ("content" in approval) {
    return approval;
  }

  return toolResultFromPayload(approval.approvedPayload);
}

async function runGetChunkContext(args: unknown): Promise<ToolResult> {
  if (!args || typeof args !== "object") {
    throw new Error("get_chunk_context requires an arguments object.");
  }
  const chunkKey = String((args as { chunkKey?: unknown }).chunkKey || "").trim();
  const contextRootInput = String((args as { contextRoot?: unknown }).contextRoot || "").trim();
  const contextRoot = contextRootInput || CONTEXT_ROOT;

  if (!chunkKey) {
    throw new Error("get_chunk_context requires a non-empty chunkKey.");
  }

  const chunk = await getChunkContext(chunkKey, contextRoot);
  const payload: ChunkContextApprovalPayload = {
    kind: "chunk_context",
    chunkKey: chunk.chunkKey,
    date: chunk.date,
    time: chunk.time,
    summaryText: chunk.summaryText,
    metaText: chunk.meta ? JSON.stringify(chunk.meta, null, 2) : "",
    frames: chunk.frames.map((frame) => ({
      name: frame.name,
      mimeType: frame.mimeType,
      data: frame.data,
    })),
  };
  const approval = await approvePayloadOrError(
    `Share chunk ${chunk.chunkKey}`,
    `Share chunk ${chunk.chunkKey}`,
    payload
  );
  if ("content" in approval) {
    return approval;
  }

  return toolResultFromPayload(approval.approvedPayload);
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
  const body = req.body as { resolution?: unknown; approved?: unknown; approvedPayload?: unknown };
  const resolution: ApprovalResolution =
    body?.resolution === "approved" || body?.approved === true ? "approved" : "rejected";
  const ok = resolveApproval(requestId, resolution, body?.approvedPayload);
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
    payload?: { requestId?: unknown; resolution?: unknown; approvedPayload?: unknown };
  };
  if (payload?.type !== "mcp-approval-response") {
    return;
  }
  const requestId = String(payload.payload?.requestId || "").trim();
  const resolution = payload.payload?.resolution;
  if (!requestId || (resolution !== "approved" && resolution !== "rejected")) {
    return;
  }
  resolveApproval(requestId, resolution, payload.payload?.approvedPayload);
});

app.listen(MCP_PORT, MCP_HOST, () => {
  console.log(`[MCP] listening on http://${MCP_HOST}:${MCP_PORT}`);
  console.log(`[MCP] endpoint: Streamable HTTP /mcp`);
  console.log(`[MCP] auth: /.well-known/oauth-authorization-server, /authorize, /token, /register`);
  console.log(
    `[MCP] approvals: GET /approvals/pending, POST /approvals/:id, POST /approvals/approve-all`
  );
});
