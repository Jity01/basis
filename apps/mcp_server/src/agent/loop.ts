/**
 * Generic agent loop — powers both the search sub-agent (Sonnet) and workers (Haiku).
 *
 * One function, two configurations. The sub-agent gets `dispatch_worker` tool access
 * and a higher iteration budget. Workers get bash only and a smaller budget.
 * Workers cannot spawn workers (recursion capped at one level).
 */

import Anthropic from "@anthropic-ai/sdk";
import { execFile } from "child_process";
import { promisify } from "util";
import { readCredentials } from "@context-manager/config";
import {
  buildWorkerSystemPrompt,
  buildWorkerUserMessage,
} from "./prompts";

const exec = promisify(execFile);

// ── Types ───────────────────────────────────────────────────────────────────

export interface AgentConfig {
  model: string;
  systemPrompt: string;
  userMessage: string;
  maxIterations: number;
  contextRoot: string;
  canDispatchWorkers: boolean;
  workerModel?: string;
}

export interface AgentResult {
  output: string;
  trace: TraceEntry[];
}

export interface TraceEntry {
  step: number;
  tool: string;
  input_summary: string;
  result_summary: string;
  latency_ms: number;
}

// ── Read-only bash enforcement via macOS sandbox ────────────────────────────

/**
 * Sandbox profile that allows everything EXCEPT file writes.
 * macOS sandbox-exec enforces this at the kernel level — no bypasses possible.
 * The agent can use any command, pipes, redirects — the OS blocks all writes.
 */
const SANDBOX_PROFILE = "(version 1)(allow default)(deny file-write*)";

async function executeBash(
  command: string,
  contextRoot: string
): Promise<string> {
  try {
    // Use macOS sandbox-exec for OS-level read-only enforcement
    const { stdout, stderr } = await exec(
      "sandbox-exec",
      ["-p", SANDBOX_PROFILE, "bash", "-c", command],
      {
        cwd: contextRoot,
        timeout: 10_000,
        maxBuffer: 1024 * 1024,
      }
    );
    const output = (stdout || "") + (stderr ? `\nSTDERR: ${stderr}` : "");

    if (output.length > 50_000) {
      return (
        output.slice(0, 50_000) +
        "\n\n[TRUNCATED — use head, tail, or grep to narrow results]"
      );
    }

    return output || "(empty output)";
  } catch (e: any) {
    // grep/rg exit code 1 = no matches (not an error)
    if (e.code === 1) {
      return e.stdout || "(no matches)";
    }
    if (e.killed) {
      return "Error: command timed out (10s limit). Use head/tail/grep to reduce output.";
    }
    return `Error: ${e.message}`;
  }
}

// ── Tool definitions ────────────────────────────────────────────────────────

function buildTools(canDispatchWorkers: boolean): Anthropic.Tool[] {
  const tools: Anthropic.Tool[] = [
    {
      name: "bash",
      description: `Run a read-only shell command on the Basis data filesystem.
All commands are sandboxed — the OS blocks any file writes at the kernel level.
You can use any standard Unix command, pipes, and redirects freely.

Useful patterns:
  rg "keyword" .wiki/                     — search all wiki pages (instant)
  rg "keyword" YYYY/MM/DD/*/temporal_description.txt — search narratives
  rg "keyword" YYYY/MM/DD/*/ocr/          — search raw OCR text
  cat .wiki/index.md                      — read topic catalog
  tail -100 .wiki/<topic>.md              — recent entries (newest at bottom)
  ls YYYY/MM/DD/                          — list chunks for a day
  ls .hotbuffer/ | sort -r | head -5      — most recent hot buffer entries
  cat .hotbuffer/<timestamp>.json         — read live screen metadata
  find . -name "temporal_description.txt" -path "*/2026/04/14/*" — find chunks for a date

COST: instant and free. Use liberally. Grep before you read.`,
      input_schema: {
        type: "object" as const,
        properties: {
          command: { type: "string", description: "Shell command to run" },
        },
        required: ["command"],
      },
    },
  ];

  if (canDispatchWorkers) {
    tools.push({
      name: "dispatch_worker",
      description: `Send a focused question to a worker agent. The worker has the same
bash access but runs on a cheaper/faster model with a smaller iteration budget (2-3 turns).

Use when:
- You need relevance assessment on content you haven't read yet
- You have a large body of content and a specific question about it
- You need pattern detection across many temporal descriptions or OCR files

Do NOT use when:
- A simple grep would answer the question (grep is faster and free)
- You can evaluate the content yourself in this iteration

COST: ~500ms + small token cost. Not free. Exhaust bash first.`,
      input_schema: {
        type: "object" as const,
        properties: {
          question: {
            type: "string",
            description: "Specific question for the worker to answer",
          },
          starting_files: {
            type: "string",
            description:
              "Suggest files/paths the worker should start with (optional)",
          },
        },
        required: ["question"],
      },
    });
  }

  return tools;
}

// ── The loop ────────────────────────────────────────────────────────────────

export async function runAgentLoop(config: AgentConfig): Promise<AgentResult> {
  // In hosted mode, route Anthropic calls through Vizlog's processing proxy
  const creds = readCredentials();
  const client = creds?.authToken
    ? new Anthropic({
        baseURL: process.env.VIZLOG_PROCESSING_URL || "https://vizlog-processing-proxy.vizlog.workers.dev",
        apiKey: creds.authToken, // jr_ token — proxy swaps for real Anthropic key
      })
    : new Anthropic();
  const trace: TraceEntry[] = [];
  let step = 0;
  const tools = buildTools(config.canDispatchWorkers);

  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: config.userMessage },
  ];

  for (let i = 0; i < config.maxIterations; i++) {
    const response = await client.messages.create({
      model: config.model,
      max_tokens: 4096,
      temperature: 0,
      system: config.systemPrompt,
      tools,
      messages,
    });

    const hasToolUse = response.content.some((b) => b.type === "tool_use");

    if (!hasToolUse) {
      // Done — LLM returned its final text output
      const output = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("\n");
      return { output, trace };
    }

    // Execute tool calls
    messages.push({ role: "assistant", content: response.content });

    const toolUseBlocks = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use"
    );

    const toolResults = await Promise.all(
      toolUseBlocks.map(async (toolCall) => {
        step++;
        const t0 = Date.now();
        let result: string;

        if (toolCall.name === "bash") {
          result = await executeBash(
            (toolCall.input as any).command,
            config.contextRoot
          );
        } else if (toolCall.name === "dispatch_worker") {
          const input = toolCall.input as any;
          const workerResult = await runAgentLoop({
            model:
              config.workerModel || "claude-haiku-4-5-20251001",
            systemPrompt: buildWorkerSystemPrompt(config.contextRoot),
            userMessage: buildWorkerUserMessage(
              input.question,
              input.starting_files
            ),
            maxIterations: 3,
            contextRoot: config.contextRoot,
            canDispatchWorkers: false,
          });
          result = workerResult.output;
          // Merge worker trace into parent trace
          trace.push(
            ...workerResult.trace.map((t) => ({
              ...t,
              tool: `worker:${t.tool}`,
            }))
          );
        } else {
          result = `Unknown tool: ${toolCall.name}`;
        }

        trace.push({
          step,
          tool: toolCall.name,
          input_summary: JSON.stringify(toolCall.input).slice(0, 200),
          result_summary: result.slice(0, 300),
          latency_ms: Date.now() - t0,
        });

        return {
          type: "tool_result" as const,
          tool_use_id: toolCall.id,
          content: result,
        };
      })
    );

    messages.push({ role: "user", content: toolResults });
  }

  // Budget exhausted — force compilation
  messages.push({
    role: "user",
    content:
      "You have reached your search budget. Compile a data package from what you have so far. Include SUMMARY, CONFIDENCE, EXCERPTS, and GAPS. Note any leads you didn't have time to follow.",
  });

  const finalResponse = await client.messages.create({
    model: config.model,
    max_tokens: 4096,
    temperature: 0,
    system: config.systemPrompt,
    messages,
  });

  const output = finalResponse.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n");

  return { output, trace };
}
