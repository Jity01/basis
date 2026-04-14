/**
 * MCP handler for the `search` tool.
 *
 * Bridges between the MCP server and the agent loop. Builds the user message
 * from search parameters and runs the sub-agent (Sonnet) with worker dispatch
 * enabled. Returns the data package as MCP text content.
 */

import { runAgentLoop } from "../agent/loop";
import { buildSubAgentSystemPrompt } from "../agent/prompts";

const log = (msg: string) => process.stderr.write(`[search] ${msg}\n`);

const DEFAULT_MODEL = "claude-sonnet-4-20250514";
const DEFAULT_WORKER_MODEL = "claude-haiku-4-5-20251001";
const DEFAULT_MAX_ITERATIONS = 7;

type SearchInput = {
  query: string;
  chat_context?: string;
  timestamp?: string;
  hints?: {
    time_range?: string;
    apps?: string[];
    topics?: string[];
  };
};

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

export async function handleSearch(
  input: SearchInput,
  contextRoot: string
): Promise<ToolResult> {
  const model = process.env.SEARCH_AGENT_MODEL?.trim() || DEFAULT_MODEL;
  const workerModel =
    process.env.SEARCH_WORKER_MODEL?.trim() || DEFAULT_WORKER_MODEL;
  const maxIterations = parseInt(
    process.env.SEARCH_MAX_ITERATIONS || "",
    10
  ) || DEFAULT_MAX_ITERATIONS;
  const timestamp = input.timestamp || new Date().toISOString();

  // Build the user message for the sub-agent
  let userMessage = `## Search Request

**Query:** ${input.query}
**Request time:** ${timestamp}
`;

  if (input.chat_context) {
    userMessage += `\n**Conversation context:**\n${input.chat_context}\n`;
  }

  if (input.hints) {
    userMessage += "\n**Hints from Claude:**\n";
    if (input.hints.time_range) {
      userMessage += `- Time range: ${input.hints.time_range}\n`;
    }
    if (input.hints.apps?.length) {
      userMessage += `- Apps: ${input.hints.apps.join(", ")}\n`;
    }
    if (input.hints.topics?.length) {
      userMessage += `- Topics: ${input.hints.topics.join(", ")}\n`;
    }
  }

  userMessage += `\nSearch the wiki, temporal descriptions, OCR, and hot buffer to assemble a data package for Claude. Follow your system prompt.`;

  const t0 = Date.now();

  try {
    const { output, trace } = await runAgentLoop({
      model,
      systemPrompt: buildSubAgentSystemPrompt(contextRoot),
      userMessage,
      maxIterations,
      contextRoot,
      canDispatchWorkers: true,
      workerModel,
    });

    const elapsed = Date.now() - t0;
    log(
      `query="${input.query.slice(0, 80)}" steps=${trace.length} time=${elapsed}ms model=${model}`
    );
    for (const t of trace) {
      log(`  [${t.tool}] ${t.input_summary.slice(0, 100)} (${t.latency_ms}ms)`);
    }

    return { content: [{ type: "text", text: output }] };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log(`ERROR: ${message}`);
    return {
      content: [
        {
          type: "text",
          text: `Search agent error: ${message}. Ensure ANTHROPIC_API_KEY is set.`,
        },
      ],
      isError: true,
    };
  }
}
