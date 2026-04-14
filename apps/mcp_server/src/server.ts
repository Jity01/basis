#!/usr/bin/env node
import "./loadEnv";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CONTEXT_ROOT } from "@context-manager/config";
import { z } from "zod";
import { handleSearch } from "./handlers/search";

// CRITICAL: All logging must go to stderr because stdout is the MCP transport.
const log = (msg: string) => process.stderr.write(`[mcp] ${msg}\n`);

const AGENT_INSTRUCTIONS = `The user captures their screen continuously. You have ONE tool: search.

Use search() for ANY question about the user's activity, work, or screen history.
The search agent will autonomously investigate wiki pages, temporal descriptions,
OCR text, and live screen data to build a comprehensive answer with verbatim excerpts.

Pass chat_context with recent conversation so the search agent understands intent.
Use hints to narrow scope when you know the time range, apps, or topics involved.

Examples:
- search({ query: "what was I working on today?" })
- search({ query: "find the error I saw in Railway", hints: { apps: ["Chrome"] } })
- search({ query: "what's on my screen right now?" })
- search({ query: "trace the steps that led to the deployment failure", chat_context: "user mentioned Railway went down after a config change" })
- search({ query: "show me every time I used Figma this week", hints: { time_range: "last 7 days", apps: ["Figma"] } })

The search agent returns a data package with SUMMARY, CONFIDENCE, EXCERPTS, and GAPS.
Use the excerpts as evidence when answering the user. If confidence is low or there
are gaps, tell the user what couldn't be verified.`;

// ── Server setup ────────────────────────────────────────────────────────────

function createMcpServer(): McpServer {
  const server = new McpServer(
    { name: "basis-mcp-server", version: "0.1.0" },
    { instructions: AGENT_INSTRUCTIONS }
  );

  server.registerTool(
    "search",
    {
      description:
        "Search across all screen activity history. Runs an AI agent that reads wiki pages, temporal descriptions, OCR text, and the live hot buffer to answer your query. Returns a synthesized answer with verbatim excerpts and confidence level. Use for any question about what the user has been doing.",
      inputSchema: {
        query: z.string().describe("Natural language search query"),
        chat_context: z
          .string()
          .optional()
          .describe(
            "Recent conversation context to help the search agent understand intent"
          ),
        timestamp: z
          .string()
          .optional()
          .describe("ISO 8601 timestamp for temporal anchoring (defaults to now)"),
        hints: z
          .object({
            time_range: z
              .string()
              .optional()
              .describe(
                "e.g. 'today', 'last 3 days', '2026-04-10 to 2026-04-12'"
              ),
            apps: z
              .array(z.string())
              .optional()
              .describe("e.g. ['VS Code', 'Chrome']"),
            topics: z
              .array(z.string())
              .optional()
              .describe("e.g. ['react', 'authentication']"),
          })
          .optional()
          .describe("Optional hints to narrow search scope"),
      },
    },
    async ({ query, chat_context, timestamp, hints }) => {
      return handleSearch(
        { query, chat_context, timestamp, hints },
        CONTEXT_ROOT
      );
    }
  );

  return server;
}

// ── Bootstrap ───────────────────────────────────────────────────────────────

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
