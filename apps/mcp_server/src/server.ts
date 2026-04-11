#!/usr/bin/env node
import "./loadEnv";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CONTEXT_ROOT } from "@context-manager/config";
import {
  getChunkContext,
  getDayIndex,
  listDays,
  readHotBuffer,
  readHotFrame,
  readLatestSnapshots,
  readDayCatalog,
  readDaySessions,
  readContext,
  openIndex,
  queryByTopic,
  queryByApp,
  queryByEntity,
} from "@context-manager/core";
import { z } from "zod";
import {
  formatApprovalPayload,
  checkToolAccess,
  type ApprovalPayload,
  type ChunkContextApprovalPayload,
  type DayIndexApprovalPayload,
  type DayListApprovalPayload,
  type LiveContextApprovalPayload,
  type LiveFrameApprovalPayload,
  type LiveSnapshotsApprovalPayload,
} from "./approval";

// CRITICAL: All logging must go to stderr because stdout is the MCP transport.
const log = (msg: string) => process.stderr.write(`[mcp] ${msg}\n`);

const DEFAULT_LIST_DAYS_LIMIT = 14;

const CONTEXT_TOOLS_AGENT_INSTRUCTIONS = `The user has been consistently capturing their screen and accumulating data for you. Their intent is for you to use this context so that you understand exactly what they have been doing — you should ALWAYS be in sync with them.

Before you answer any question that touches on the user's work, communications, or projects, use the context tools first. Do not assume you know enough. It is always better to check than to guess.

ALWAYS start with get_context. It costs ~300 tokens and gives you: active projects, recent threads, what the user was last working on, their daily patterns. This is your baseline awareness.

Then use the search tools for targeted lookup:
- search_by_topic("react", dateFrom: "2026-04-01") → find all React work this week
- search_by_app("VS Code") → find all coding sessions
- search_by_entity("AuthProvider") → find chunks mentioning a specific file
- get_sessions("2026-04-08") → see today's activity grouped into meaningful sessions
- get_day_catalog("2026-04-08") → structured metadata for each chunk (topics, apps, entities)

For browsing without a specific target, use the older tools:
- list_days → days with recordings
- get_day_index → concatenated prose summaries for a day
- get_chunk_context → deep dive into a specific time block (returns frames + summary)

For real-time:
- get_latest_snapshots → most recent screenshots + OCR
- get_live_context → OCR text timeline of the last 30-60s
- get_live_frame → single screenshot by timestamp

BIAS TOWARDS FRESH DATA: Most of the time, the relevant context happened today. Start with today's data and work backwards.

The key insight: one question often requires MULTIPLE rounds of lookup across MULTIPLE days and topics. Don't stop after one call. The more creative you are with your lookups, the more useful you become.`;

// ── Helpers ──────────────────────────────────────────────────────────────────

type TextToolContent = { type: "text"; text: string };
type ImageToolContent = { type: "image"; data: string; mimeType: string };
type ToolContent = TextToolContent | ImageToolContent;
type ToolResult = { content: ToolContent[]; isError?: boolean };

function makeTextResult(text: string, isError = false): ToolResult {
  return { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) };
}

/** Scope check. Returns approved payload, or an error result. */
async function checkAccessOrError(
  toolName: string,
  payload: ApprovalPayload
): Promise<{ approvedPayload: ApprovalPayload } | ToolResult> {
  const result = await checkToolAccess(toolName, "local", "Local Client");
  if (!result.allowed) {
    return makeTextResult(result.error, true);
  }
  return { approvedPayload: payload };
}

function toolResultFromPayload(payload: ApprovalPayload): ToolResult {
  switch (payload.kind) {
    case "chunk_context":
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
    case "live_frame":
      return {
        content: [{ type: "image", data: payload.data, mimeType: payload.mimeType }],
      };
    case "live_snapshots": {
      const content: ToolContent[] = [];
      for (const item of payload.items) {
        const secsAgo = Math.round((Date.now() - item.timestamp) / 1000);
        content.push({
          type: "text",
          text: `[${secsAgo}s ago] ${item.app} — ${item.windowTitle}\nOCR: ${item.ocrText}`,
        });
        content.push({
          type: "image",
          data: item.frame.data,
          mimeType: item.frame.mimeType,
        });
      }
      return { content };
    }
    default:
      return makeTextResult(formatApprovalPayload(payload));
  }
}

// ── Tool implementations ─────────────────────────────────────────────────────

async function runListDays(limit: number, contextRoot: string): Promise<ToolResult> {
  const days = await listDays(contextRoot, limit);
  const payload: DayListApprovalPayload = { kind: "day_list", days };
  const approval = await checkAccessOrError("list_days", payload);
  if ("content" in approval) return approval;
  return toolResultFromPayload(approval.approvedPayload);
}

async function runGetDayIndex(date: string, contextRoot: string): Promise<ToolResult> {
  if (!date) throw new Error("get_day_index requires a non-empty date.");
  const day = await getDayIndex(date, contextRoot);
  const payload: DayIndexApprovalPayload = {
    kind: "day_index",
    date: day.date,
    chunkCount: day.chunkCount,
    chunkKeys: day.chunkKeys,
    indexText: day.indexText,
  };
  const approval = await checkAccessOrError("get_day_index", payload);
  if ("content" in approval) return approval;
  return toolResultFromPayload(approval.approvedPayload);
}

async function runGetChunkContext(chunkKey: string, contextRoot: string): Promise<ToolResult> {
  if (!chunkKey) throw new Error("get_chunk_context requires a non-empty chunkKey.");
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
  const approval = await checkAccessOrError("get_chunk_context", payload);
  if ("content" in approval) return approval;
  return toolResultFromPayload(approval.approvedPayload);
}

async function runGetLiveContext(lastN: number, contextRoot: string): Promise<ToolResult> {
  const entries = readHotBuffer(lastN, contextRoot);
  if (entries.length === 0) {
    return makeTextResult("Hot buffer is empty — recording may not be active.");
  }
  const timeline = entries
    .map((e) => {
      const secsAgo = Math.round((Date.now() - e.timestamp) / 1000);
      return `[${secsAgo}s ago] ${e.app} — ${e.windowTitle}\n${e.ocrText}`;
    })
    .join("\n\n---\n\n");
  const timelineText = `Live context (last ${lastN}s, ${entries.length} snapshots):\n\n${timeline}`;
  const payload: LiveContextApprovalPayload = { kind: "live_context", timelineText };
  const approval = await checkAccessOrError("get_live_context", payload);
  if ("content" in approval) return approval;
  return toolResultFromPayload(approval.approvedPayload);
}

async function runGetLiveFrame(timestamp: number, contextRoot: string): Promise<ToolResult> {
  const frame = readHotFrame(timestamp, contextRoot);
  if (!frame) return makeTextResult("Frame not found — it may have been purged.");
  const payload: LiveFrameApprovalPayload = {
    kind: "live_frame",
    timestamp,
    mimeType: "image/jpeg",
    data: frame.toString("base64"),
  };
  const approval = await checkAccessOrError("get_live_frame", payload);
  if ("content" in approval) return approval;
  return toolResultFromPayload(approval.approvedPayload);
}

async function runGetLatestSnapshots(count: number, contextRoot: string): Promise<ToolResult> {
  const snapshots = readLatestSnapshots(count, contextRoot);
  if (snapshots.length === 0) {
    return makeTextResult("Hot buffer is empty — recording may not be active.");
  }
  const items = snapshots.map((snap) => ({
    timestamp: snap.timestamp,
    app: snap.app,
    windowTitle: snap.windowTitle,
    ocrText: snap.ocrText,
    frame: {
      name: `${snap.timestamp}.jpg`,
      mimeType: "image/jpeg" as const,
      data: snap.frameBuffer.toString("base64"),
    },
  }));
  const payload: LiveSnapshotsApprovalPayload = { kind: "live_snapshots", items };
  const approval = await checkAccessOrError("get_latest_snapshots", payload);
  if ("content" in approval) return approval;
  return toolResultFromPayload(approval.approvedPayload);
}

// ── Server setup ─────────────────────────────────────────────────────────────

function createMcpServer(): McpServer {
  const server = new McpServer(
    { name: "basis-mcp-server", version: "0.0.1" },
    { instructions: CONTEXT_TOOLS_AGENT_INSTRUCTIONS }
  );

  // Historical tools
  server.registerTool(
    "list_days",
    {
      description: "Lists screen activity days. Use to identify which days to drill into.",
      inputSchema: {
        limit: z.number().int().min(1).max(100).optional().describe("Max days to return (default 14)."),
        contextRoot: z.string().optional(),
      },
    },
    async ({ limit, contextRoot }) =>
      runListDays(limit ?? DEFAULT_LIST_DAYS_LIMIT, contextRoot?.trim() || CONTEXT_ROOT)
  );

  server.registerTool(
    "get_day_index",
    {
      description: "Returns concatenated prose summaries for all chunks in a day.",
      inputSchema: {
        date: z.string().describe("YYYY-MM-DD"),
        contextRoot: z.string().optional(),
      },
    },
    async ({ date, contextRoot }) =>
      runGetDayIndex(date, contextRoot?.trim() || CONTEXT_ROOT)
  );

  server.registerTool(
    "get_chunk_context",
    {
      description: "Deep-dive into a specific 5-minute chunk. Returns summary + 5 screenshots.",
      inputSchema: {
        chunkKey: z.string().describe("YYYY-MM-DD/HH-MM"),
        contextRoot: z.string().optional(),
      },
    },
    async ({ chunkKey, contextRoot }) =>
      runGetChunkContext(chunkKey, contextRoot?.trim() || CONTEXT_ROOT)
  );

  // Real-time tools
  server.registerTool(
    "get_live_context",
    {
      description: "Returns OCR text timeline for the last 30-60 seconds. Real-time, no processing delay.",
      inputSchema: {
        lastNSeconds: z.number().min(1).max(60).optional(),
        contextRoot: z.string().optional(),
      },
    },
    async ({ lastNSeconds, contextRoot }) =>
      runGetLiveContext(lastNSeconds ?? 30, contextRoot?.trim() || CONTEXT_ROOT)
  );

  server.registerTool(
    "get_live_frame",
    {
      description: "Returns a single screenshot by timestamp. Get timestamps from get_live_context.",
      inputSchema: {
        timestamp: z.number().describe("Unix timestamp (ms)"),
        contextRoot: z.string().optional(),
      },
    },
    async ({ timestamp, contextRoot }) =>
      runGetLiveFrame(timestamp, contextRoot?.trim() || CONTEXT_ROOT)
  );

  server.registerTool(
    "get_latest_snapshots",
    {
      description: "Returns the last N screenshots + OCR + app/window metadata. Default 2.",
      inputSchema: {
        count: z.number().min(1).max(5).optional(),
        contextRoot: z.string().optional(),
      },
    },
    async ({ count, contextRoot }) =>
      runGetLatestSnapshots(count ?? 2, contextRoot?.trim() || CONTEXT_ROOT)
  );

  // Structured query tools
  server.registerTool(
    "get_context",
    {
      description: "CALL THIS FIRST. Returns rolling context: active projects, recent threads, last session, daily patterns. ~300 tokens.",
      inputSchema: { contextRoot: z.string().optional() },
    },
    async ({ contextRoot }) => {
      const root = contextRoot?.trim() || CONTEXT_ROOT;
      const access = await checkToolAccess("get_context", "local", "Local Client");
      if (!access.allowed) return makeTextResult(access.error, true);
      const ctx = await readContext(root);
      return { content: [{ type: "text" as const, text: JSON.stringify(ctx, null, 2) }] };
    }
  );

  server.registerTool(
    "search_by_topic",
    {
      description: "Search the activity index for chunks matching a topic tag (e.g. 'react', 'debugging').",
      inputSchema: {
        topic: z.string(),
        dateFrom: z.string().optional().describe("YYYY-MM-DD"),
        dateTo: z.string().optional().describe("YYYY-MM-DD"),
        contextRoot: z.string().optional(),
      },
    },
    async ({ topic, dateFrom, dateTo, contextRoot }) => {
      const root = contextRoot?.trim() || CONTEXT_ROOT;
      const access = await checkToolAccess("search_by_topic", "local", "Local Client");
      if (!access.allowed) return makeTextResult(access.error, true);
      const db = openIndex(root);
      try {
        const chunkKeys = queryByTopic(db, topic, dateFrom, dateTo);
        const results = chunkKeys.map((key) => {
          const row = db.prepare("SELECT primary_intent, summary_preview FROM chunks WHERE chunk_key = ?").get(key) as { primary_intent: string; summary_preview: string } | undefined;
          return { chunk_key: key, primary_intent: row?.primary_intent || "", summary_preview: row?.summary_preview || "" };
        });
        return { content: [{ type: "text" as const, text: JSON.stringify({ topic, matches: results.length, results }, null, 2) }] };
      } finally {
        db.close();
      }
    }
  );

  server.registerTool(
    "search_by_app",
    {
      description: "Search the activity index for chunks where a specific application was used.",
      inputSchema: {
        app: z.string(),
        dateFrom: z.string().optional(),
        dateTo: z.string().optional(),
        contextRoot: z.string().optional(),
      },
    },
    async ({ app, dateFrom, dateTo, contextRoot }) => {
      const root = contextRoot?.trim() || CONTEXT_ROOT;
      const access = await checkToolAccess("search_by_app", "local", "Local Client");
      if (!access.allowed) return makeTextResult(access.error, true);
      const db = openIndex(root);
      try {
        const chunkKeys = queryByApp(db, app, dateFrom, dateTo);
        const results = chunkKeys.map((key) => {
          const row = db.prepare("SELECT primary_intent, summary_preview FROM chunks WHERE chunk_key = ?").get(key) as { primary_intent: string; summary_preview: string } | undefined;
          return { chunk_key: key, primary_intent: row?.primary_intent || "", summary_preview: row?.summary_preview || "" };
        });
        return { content: [{ type: "text" as const, text: JSON.stringify({ app, matches: results.length, results }, null, 2) }] };
      } finally {
        db.close();
      }
    }
  );

  server.registerTool(
    "search_by_entity",
    {
      description: "Search the activity index for chunks mentioning a specific entity (file, URL, person, project, error). Partial match.",
      inputSchema: {
        entity: z.string(),
        contextRoot: z.string().optional(),
      },
    },
    async ({ entity, contextRoot }) => {
      const root = contextRoot?.trim() || CONTEXT_ROOT;
      const access = await checkToolAccess("search_by_entity", "local", "Local Client");
      if (!access.allowed) return makeTextResult(access.error, true);
      const db = openIndex(root);
      try {
        const chunkKeys = queryByEntity(db, entity);
        const results = chunkKeys.map((key) => {
          const row = db.prepare("SELECT primary_intent, summary_preview FROM chunks WHERE chunk_key = ?").get(key) as { primary_intent: string; summary_preview: string } | undefined;
          return { chunk_key: key, primary_intent: row?.primary_intent || "", summary_preview: row?.summary_preview || "" };
        });
        return { content: [{ type: "text" as const, text: JSON.stringify({ entity, matches: results.length, results }, null, 2) }] };
      } finally {
        db.close();
      }
    }
  );

  server.registerTool(
    "get_sessions",
    {
      description: "Returns activity sessions for a day — chunks grouped into meaningful units with synthesized summaries.",
      inputSchema: {
        date: z.string().describe("YYYY-MM-DD"),
        contextRoot: z.string().optional(),
      },
    },
    async ({ date, contextRoot }) => {
      const root = contextRoot?.trim() || CONTEXT_ROOT;
      const access = await checkToolAccess("get_sessions", "local", "Local Client");
      if (!access.allowed) return makeTextResult(access.error, true);
      const sessions = await readDaySessions(date, root);
      if (!sessions) {
        return { content: [{ type: "text" as const, text: `No sessions found for ${date}.` }] };
      }
      return { content: [{ type: "text" as const, text: JSON.stringify(sessions, null, 2) }] };
    }
  );

  server.registerTool(
    "get_day_catalog",
    {
      description: "Returns the structured chunk catalog for a day with topics, apps, entities, activity types, and intent.",
      inputSchema: {
        date: z.string().describe("YYYY-MM-DD"),
        contextRoot: z.string().optional(),
      },
    },
    async ({ date, contextRoot }) => {
      const root = contextRoot?.trim() || CONTEXT_ROOT;
      const access = await checkToolAccess("get_day_catalog", "local", "Local Client");
      if (!access.allowed) return makeTextResult(access.error, true);
      const catalog = await readDayCatalog(date, root);
      if (!catalog) {
        return { content: [{ type: "text" as const, text: `No catalog found for ${date}.` }] };
      }
      return { content: [{ type: "text" as const, text: JSON.stringify(catalog, null, 2) }] };
    }
  );

  return server;
}

// ── Bootstrap ────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log("Basis MCP server connected via stdio");
}

main().catch((err) => {
  log(`Fatal error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
