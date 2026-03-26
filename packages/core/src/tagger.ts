import Anthropic from "@anthropic-ai/sdk";
import * as dotenv from "dotenv";
import * as fs from "fs/promises";
import * as path from "path";

/** Load repo-root `.env` when running from compiled `dist/` (packages/core/dist). */
dotenv.config({ path: path.join(__dirname, "../../../.env") });

const DEFAULT_MODEL = "claude-sonnet-4-20250514";

function anthropicModel(): string {
  return process.env.ANTHROPIC_MODEL?.trim() || DEFAULT_MODEL;
}

function getApiKey(): string {
  const key = process.env.ANTHROPIC_API_KEY?.trim();
  if (!key) {
    throw new Error(
      "Missing ANTHROPIC_API_KEY. Copy .env.example to .env at the repo root and set your key."
    );
  }
  return key;
}

function buildAnalysisPrompt(
  numFrames: number,
  startTime: string,
  endTime: string,
  rollingContext: string
): string {
  const contextBlock =
    rollingContext.trim().length > 0
      ? `\n\nPrior context from the immediately preceding segment:\n${rollingContext.trim()}\n`
      : "";

  return `You are a screen activity analyzer. Your job is to produce specific
summaries of what a user is doing on their computer. These summaries will be stored
and later searched by an AI agent to answer questions like "when did the user work on X?"
or "what was the user trying to figure out about Y?" — so specificity matters.

You are looking at ${numFrames} sequential screenshots from a screen recording,
covering ${startTime} to ${endTime}, evenly spaced.${contextBlock}

INSTRUCTIONS:
- Read and understand the actual text on screen carefully.
- Focus on INTENT and CONTENT. What is the user trying to do? What problem are they solving?
- If the user is in a conversation (chat, email, etc.), understand the full conversation.
- Name specific entities as needed.

GOOD SUMMARY EXAMPLE:
"User is writing a cold outreach email to a partner at Morrison & Foerster
about a new compliance monitoring product. They are iterating on the subject
line, testing variations that emphasize ROI for mid-size firms. They also
have a spreadsheet open tracking 30 law firms they plan to contact this week,
with columns for partner name, practice area, and outreach status. Three
firms are marked as already contacted: Baker McKenzie, Latham & Watkins,
and Sidley Austin."

BAD SUMMARY EXAMPLE:
"User is browsing code repositories and documentation in a web browser with
multiple tabs open. They appear to be doing development work with a dark-themed
IDE visible. The activity suggests active research and coding."

The bad example is useless because it describes what things look like, not what
the user is actually doing. It contains zero searchable details.

Write your summary as a single paragraph. Get to the point. Be concise.
`;
}

function mimeForPath(filePath: string): "image/jpeg" | "image/png" | "image/gif" | "image/webp" {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".png") {
    return "image/png";
  }
  if (ext === ".gif") {
    return "image/gif";
  }
  if (ext === ".webp") {
    return "image/webp";
  }
  return "image/jpeg";
}

function textFromBlocks(content: Anthropic.Messages.ContentBlock[]): string {
  const parts: string[] = [];
  for (const block of content) {
    if (block.type === "text") {
      parts.push(block.text);
    }
  }
  return parts.join("\n").trim();
}

/**
 * Reads frame files as base64 and sends them to **Claude** (Anthropic Messages API)
 * with vision. Requires **`ANTHROPIC_API_KEY`** (see repo-root `.env.example`).
 *
 * Environment:
 * - `ANTHROPIC_API_KEY` — required
 * - `ANTHROPIC_MODEL` — optional, default `claude-sonnet-4-20250514` (must be a vision-capable model)
 */
export async function tagChunk(
  framePaths: string[],
  startTime: string,
  endTime: string,
  rollingContext: string
): Promise<string> {
  const numFrames = framePaths.length;
  const promptText = buildAnalysisPrompt(
    numFrames,
    startTime,
    endTime,
    rollingContext
  );

  const content: Anthropic.Messages.ContentBlockParam[] = [
    { type: "text", text: promptText },
  ];

  for (const fp of framePaths) {
    const buf = await fs.readFile(fp);
    const b64 = buf.toString("base64");
    const mediaType = mimeForPath(fp);
    content.push({
      type: "image",
      source: {
        type: "base64",
        media_type: mediaType,
        data: b64,
      },
    });
  }

  const client = new Anthropic({ apiKey: getApiKey() });

  let response: Anthropic.Messages.Message;
  try {
    response = await client.messages.create({
      model: anthropicModel(),
      max_tokens: 4096,
      messages: [{ role: "user", content }],
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`Anthropic Messages API failed: ${msg}`);
  }

  const raw = textFromBlocks(response.content);
  if (!raw) {
    throw new Error("Anthropic returned no text content");
  }

  return raw;
}
