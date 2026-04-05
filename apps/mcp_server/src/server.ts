import "./loadEnv";
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

const MCP_HOST = process.env.MCP_SERVER_HOST?.trim() || "127.0.0.1";
const MCP_PORT = Number(process.env.MCP_SERVER_PORT || 4821);

type McpSession = {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
};

const mcpSessions: Record<string, McpSession> = {};
const authRouters = new Map<string, RequestHandler>();
const DEFAULT_LIST_DAYS_LIMIT = 14;

/** Shown at MCP initialize and prefixed on each tool so agents favor continuity over chat-only state. */
const CONTEXT_TOOLS_AGENT_INSTRUCTIONS=`The user has been consistently capturing their screen and accumulating data for you. Their intent is for you to use this context so that you understand exactly what they have been doing — you should ALWAYS be in sync with them.

Before you answer any question that touches on the user's work, communications, or projects, use the context tools first. Do not assume you know enough. It is always better to check than to guess.

Whenever you want to ask the user a clarifying question, ask yourself: "Could I answer this by looking at their context instead?" If yes, look it up.

IMPORTANT — YOU HAVE AN INSANELY RICH SOURCE OF DATA. USE IT LIKE CRAZY.

Why is it insanely rich? Because you are getting images of what the user has been seeing throughout their days. You can use it to understand exactly what they're thinking about, what they've been doing, what they are seeing RIGHT NOW. It's like you were there with them all along. You are here to point out all the things they missed. Almost every conversation can be enhanced by you getting more context. You should always strive to figure out where a user is coming from when they ask you to do things.

Almost every time something isn't adding up, it can be solved if you just look at the context. For instance, if the MCP connection randomly stopped working, you can "investigate" by looking at any point where the user was working on the MCP, configuring the MCP setup, etc. You now have such a rich source of data — it's INSANE not to use it like crazy. You can be SO creative with it, and it would suck if you are lazy and too narrow with the usage and make the user re-explain things over and over again.

Don't just look at one day. Don't just look at one chunk. Scan multiple days, cross-reference topics, and build a full picture. The tools are designed to work with your strengths as a model — connecting dots, noticing patterns, synthesizing across sources. Use your skills maximally.

BIAS TOWARDS FRESH DATA: Most of the time, the context relevant to what the user is asking about happened today. Start with today's chunks and work backwards. Don't apply this rule shallowly everywhere — sometimes you need to go back days or weeks — but recognize this very real pattern: users usually ask about things they were just doing.

EXAMPLE 1 — Multi-round lookup (responding to an email):

User: "I got an email from Caleb about the onboarding flow — help me respond."

Often, one question touches on multiple different things and requires multiple rounds of lookup. Here, you need: (1) what the email says, and (2) what the user has been doing on the onboarding flow. These are probably in different chunks.

Round 1 — Find recent days:
  → list_days(limit: 3)

Round 2 — Scan today first:
  → get_day_index(date: "2026-04-04")
  → Look for chunks mentioning "Gmail", "Caleb", or "email"

Round 3 — Get the email content:
  → get_chunk_context(chunkKey: "2026-04-04/14-30")

Round 4 — Find project context (maybe on a DIFFERENT day):
  → get_day_index on previous days too, scan for "onboarding", "Figma", or the relevant codebase

Round 5 — Get the project details:
  → get_chunk_context on the relevant chunks
  → Now you know what Caleb said AND what the user has been building, what decisions were made, what's still open

EXAMPLE 2 — Investigation (debugging something):

User: "the MCP connection keeps dropping, what's going on?"

Don't just say "I don't know." INVESTIGATE.
  → list_days, then scan multiple day indexes for any chunks where the user was configuring, debugging, or discussing the MCP setup
  → Pull chunks from different days — maybe they changed a setting.`;

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
  const server = new McpServer(
    {
      name: "context-manager-mcp-server",
      version: "0.0.1",
    },
    {
      instructions: CONTEXT_TOOLS_AGENT_INSTRUCTIONS,
    }
  );

  server.registerTool(
    "list_days",
    {
      description:
        "CALL BEFORE ASKING CLARIFYING QUESTIONS about user context it lists screen activity days. Call this FIRST whenever the user asks about their work, projects, communications, or anything they were doing. Returns day-level summaries to help you identify which days to drill into.",
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
        "Scans a specific day's activity to return what the user was doing throughout that day — apps used, topics covered, communications. Use this to find the right time chunks before calling get_chunk_context.",
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
        "Deep-dive into a specific time block returns detailed summaries and actual screenshots of what the user was seeing. Use this when you need the actual content — emails, code, documents, conversations.",
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