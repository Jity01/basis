import * as dotenv from "dotenv";
import * as fs from "fs/promises";
import * as path from "path";
import type { AISettings } from "./aiSettings";

/** Load repo-root `.env` when running from compiled `dist/` (packages/core/dist). */
dotenv.config({ path: path.join(__dirname, "../../../.env") });

const DEFAULT_MODEL =
  process.env.FIREWORKS_MODEL?.trim() ||
  "accounts/fireworks/models/qwen3-vl-30b-a3b-instruct";
const DEFAULT_FIREWORKS_BASE_URL = "https://api.fireworks.ai/inference/v1";
const MIN_SECONDS_BETWEEN_REQUESTS = 70;
let lastRequestAtMs = 0;

function getApiKey(): string {
  const key = process.env.FIREWORKS_API_KEY?.trim();
  if (!key) {
    throw new Error(
      "Missing FIREWORKS_API_KEY."
    );
  }
  return key;
}

function getFireworksBaseUrl(): string {
  return process.env.FIREWORKS_BASE_URL?.trim() || DEFAULT_FIREWORKS_BASE_URL;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForRateLimitWindow(settings?: AISettings): Promise<void> {
  if (settings?.provider === "local") {
    return;
  }
  if (lastRequestAtMs <= 0) {
    return;
  }

  const elapsedSeconds = (Date.now() - lastRequestAtMs) / 1000;
  const waitSeconds = Math.max(0, MIN_SECONDS_BETWEEN_REQUESTS - elapsedSeconds);
  if (waitSeconds > 0) {
    await sleep(waitSeconds * 1000);
  }
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
- Read and understand the actual text on screen carefully. Do not just rely on
the visual layout.
- Focus on INTENT and CONTENT. What is the user trying to do?
  What are they thinking about? What problem are they solving?
- If the user is in a conversation (chat, email, etc.), summarize both sides.
- Name specific entities as needed.
- Briefly mention the platform the user is on if not already mentioned.

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
the user is actually doing or thinking about. It contains zero searchable details.

Write your summary as a single concise paragraph; do not be verbose. Keep your
analysis to the minimum and more so describe what's happening.

IMPORTANT: DO NOT REPEAT YOURSELF. If you've said something in the previous chunk,
don't say it again in this chunk summary. Focus only on what is new and different in
this chunk. If there absolutely aren't any new things, just do not say anything.
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

/**
 * Reads frame files as base64 and sends them to Fireworks Chat Completions (vision).
 * Requires `FIREWORKS_API_KEY`.
 *
 * Environment:
 * - `FIREWORKS_API_KEY` — required
 * - `FIREWORKS_MODEL` — optional, defaults to qwen3-vl-30b-a3b-instruct
 */
type VisionContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

function getTaggingModel(settings?: AISettings): string {
  return settings?.provider === "local" ? settings.localTaggingModel : DEFAULT_MODEL;
}

function getTaggingUrl(settings?: AISettings): string {
  const baseUrl =
    settings?.provider === "local" ? settings.localBaseUrl : getFireworksBaseUrl();
  return `${baseUrl.replace(/\/$/, "")}/chat/completions`;
}

function getTaggingHeaders(settings?: AISettings): Record<string, string> {
  if (settings?.provider === "local") {
    return { "Content-Type": "application/json" };
  }
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${getApiKey()}`,
  };
}

export async function tagChunk(
  framePaths: string[],
  startTime: string,
  endTime: string,
  rollingContext: string,
  settings?: AISettings
): Promise<string> {
  const numFrames = framePaths.length;
  const promptText = buildAnalysisPrompt(
    numFrames,
    startTime,
    endTime,
    rollingContext
  );

  const content: VisionContentPart[] = [];

  for (const fp of framePaths) {
    const buf = await fs.readFile(fp);
    const b64 = buf.toString("base64");
    const mediaType = mimeForPath(fp);
    content.push({
      type: "image_url",
      image_url: {
        url: `data:${mediaType};base64,${b64}`,
      },
    });
  }
  content.push({ type: "text", text: promptText });

  let responseContent = "";
  try {
    await waitForRateLimitWindow(settings);
    const response = await fetch(getTaggingUrl(settings), {
      method: "POST",
      headers: getTaggingHeaders(settings),
      body: JSON.stringify({
        model: getTaggingModel(settings),
        max_tokens: 4096,
        messages: [{ role: "user", content }],
      }),
    });
    if (settings?.provider !== "local") {
      lastRequestAtMs = Date.now();
    }

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`HTTP ${response.status}: ${body}`);
    }

    const json = (await response.json()) as {
      choices?: Array<{ message?: { content?: string | null } }>;
    };
    responseContent = json.choices?.[0]?.message?.content?.trim() ?? "";
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(
      `${settings?.provider === "local" ? "Local Ollama" : "Fireworks"} Chat Completions API failed: ${msg}`
    );
  }

  if (!responseContent) {
    throw new Error(`${settings?.provider === "local" ? "Local Ollama" : "Fireworks"} returned no text content`);
  }

  return responseContent;
}
