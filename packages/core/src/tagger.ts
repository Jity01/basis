import "./loadRepoEnv";
import * as fs from "fs/promises";
import * as path from "path";
import type { AISettings } from "./aiSettings";

const DEFAULT_MODEL =
  process.env.FIREWORKS_MODEL?.trim() ||
  "accounts/fireworks/models/qwen3-vl-30b-a3b-instruct";
const DEFAULT_FIREWORKS_BASE_URL = "https://api.fireworks.ai/inference/v1";

function getApiKey(settings?: AISettings): string {
  const fromEnv = process.env.FIREWORKS_API_KEY?.trim();
  if (fromEnv) {
    return fromEnv;
  }
  const fromSettings = settings?.fireworksApiKey?.trim();
  if (fromSettings) {
    return fromSettings;
  }
  throw new Error(
    "Missing Fireworks API key. Set FIREWORKS_API_KEY in the environment or add it in Settings."
  );
}

function getFireworksBaseUrl(): string {
  return process.env.FIREWORKS_BASE_URL?.trim() || DEFAULT_FIREWORKS_BASE_URL;
}

function buildAnalysisPrompt(
  numFrames: number,
  startTime: string,
  endTime: string
): string {
  return `You are a screen activity analyzer. Your job is to produce specific
summaries of what a user is doing on their computer. These summaries will be stored
and later searched by an AI agent to answer questions like "when did the user work on X?"
or "what was the user trying to figure out about Y?" — so specificity matters.

You are looking at ${numFrames} sequential screenshots from a screen recording,
covering ${startTime} to ${endTime}, evenly spaced.

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
 * API key: `FIREWORKS_API_KEY` env, else `settings.fireworksApiKey` from saved AI settings.
 *
 * Environment:
 * - `FIREWORKS_API_KEY` — optional if key is saved in Settings
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
    Authorization: `Bearer ${getApiKey(settings)}`,
  };
}

export async function tagChunk(
  framePaths: string[],
  startTime: string,
  endTime: string,
  settings?: AISettings
): Promise<string> {
  const numFrames = framePaths.length;
  const promptText = buildAnalysisPrompt(numFrames, startTime, endTime);

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
    const response = await fetch(getTaggingUrl(settings), {
      method: "POST",
      headers: getTaggingHeaders(settings),
      body: JSON.stringify({
        model: getTaggingModel(settings),
        max_tokens: 4096,
        messages: [{ role: "user", content }],
      }),
    });

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
