import "./loadRepoEnv";
import * as fs from "fs/promises";
import * as fsSync from "fs";
import * as path from "path";
import type { AISettings } from "@context-manager/config";
import { DEFAULT_WIKI_TEXT_MODEL } from "@context-manager/config";
import {
  NARRATOR_SYSTEM_PROMPT,
  buildNarratorUserPrompt,
  VL_CLEAN_USER_PROMPT,
  WIKI_JSON_USER_SUFFIX,
} from "./wikiConstants";

const DEFAULT_VL_MODEL =
  process.env.FIREWORKS_VL_MODEL?.trim() ||
  process.env.FIREWORKS_MODEL?.trim() ||
  "accounts/fireworks/models/qwen3-vl-30b-a3b-instruct";
const DEFAULT_FIREWORKS_BASE_URL = "https://api.fireworks.ai/inference/v1";

type VisionContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

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

function getVlModel(settings?: AISettings): string {
  return settings?.provider === "local" ? settings.localTaggingModel : DEFAULT_VL_MODEL;
}

function getChatUrl(settings?: AISettings): string {
  const baseUrl =
    settings?.provider === "local" ? settings.localBaseUrl : getFireworksBaseUrl();
  return `${baseUrl.replace(/\/$/, "")}/chat/completions`;
}

function getChatHeaders(settings?: AISettings): Record<string, string> {
  if (settings?.provider === "local") {
    return { "Content-Type": "application/json" };
  }
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${getApiKey(settings)}`,
  };
}

function mimeForPath(filePath: string): string {
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

const KEY_FRAMES_RE = /KEY_FRAMES:\s*\[([\d,\s]+)\]/im;

/**
 * Parses KEY_FRAMES line from narrator output. Returns 1-based indices in range 1..numFrames.
 */
export function parseKeyFrames(text: string, numFrames: number): number[] {
  const m = KEY_FRAMES_RE.exec(text);
  if (!m) {
    return [];
  }
  const raw = m[1] ?? "";
  const indices: number[] = [];
  for (const part of raw.split(",")) {
    const p = part.trim();
    if (!p) {
      continue;
    }
    const i = Number.parseInt(p, 10);
    if (Number.isNaN(i) || i < 1 || i > numFrames) {
      throw new Error(`KEY_FRAMES index ${i} out of range 1..${numFrames}`);
    }
    indices.push(i);
  }
  return indices;
}

/** Five evenly spaced indices when the model omits or breaks KEY_FRAMES. */
export function fallbackKeyFrames(numFrames: number): number[] {
  if (numFrames <= 5) {
    return Array.from({ length: numFrames }, (_, k) => k + 1);
  }
  const picks = [1, 4, 7, 10, 13].filter((i) => i <= numFrames);
  if (picks.length >= 5) {
    return picks.slice(0, 5);
  }
  const out: number[] = [];
  const step = (numFrames - 1) / 4;
  for (let k = 0; k < 5; k++) {
    const idx = Math.min(numFrames, Math.max(1, Math.round(1 + k * step)));
    if (!out.includes(idx)) {
      out.push(idx);
    }
  }
  while (out.length < 5 && out.length < numFrames) {
    for (let i = 1; i <= numFrames; i++) {
      if (!out.includes(i)) {
        out.push(i);
        break;
      }
    }
  }
  return out.slice(0, Math.min(10, Math.max(5, out.length)));
}

export function normalizeKeyFrames(indices: number[], numFrames: number): number[] {
  const uniq = Array.from(new Set(indices)).sort((a, b) => a - b);
  if (uniq.length >= 5 && uniq.length <= 10) {
    return uniq;
  }
  return fallbackKeyFrames(numFrames);
}

export async function callNarratorVlm(
  framePaths: string[],
  settings?: AISettings
): Promise<string> {
  const n = framePaths.length;
  const intro =
    `Below are ${n} screenshots in order. Frame 1 is the first image, frame ${n} is the last.\n\n`;
  const userText = intro + buildNarratorUserPrompt(n);

  const content: VisionContentPart[] = [{ type: "text", text: userText }];
  for (const fp of framePaths) {
    const buf = await fs.readFile(fp);
    const b64 = buf.toString("base64");
    const mediaType = mimeForPath(fp);
    content.push({
      type: "image_url",
      image_url: { url: `data:${mediaType};base64,${b64}` },
    });
  }

  const payload = {
    model: getVlModel(settings),
    messages: [
      { role: "system", content: NARRATOR_SYSTEM_PROMPT },
      { role: "user", content },
    ],
    max_tokens: 4096,
    temperature: 0.2,
  };

  const response = await fetch(getChatUrl(settings), {
    method: "POST",
    headers: getChatHeaders(settings),
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Narrator VLM HTTP ${response.status}: ${body.slice(0, 2000)}`);
  }

  const json = (await response.json()) as {
    choices?: Array<{ message?: { content?: string | null } }>;
  };
  const text = json.choices?.[0]?.message?.content?.trim() ?? "";
  if (!text) {
    throw new Error("Narrator VLM returned empty content");
  }
  return text;
}

export async function callFormattedOcrVl(
  imagePath: string,
  settings?: AISettings
): Promise<string> {
  const buf = await fs.readFile(imagePath);
  const b64 = buf.toString("base64");
  const mediaType = mimeForPath(imagePath);
  const dataUrl = `data:${mediaType};base64,${b64}`;

  const payload = {
    model: getVlModel(settings),
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: VL_CLEAN_USER_PROMPT },
          { type: "image_url", image_url: { url: dataUrl } },
        ],
      },
    ],
    max_tokens: 4096,
    temperature: 0.2,
  };

  const response = await fetch(getChatUrl(settings), {
    method: "POST",
    headers: getChatHeaders(settings),
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`OCR VLM HTTP ${response.status}: ${body.slice(0, 2000)}`);
  }

  const json = (await response.json()) as {
    choices?: Array<{ message?: { content?: string | null } }>;
  };
  let text = json.choices?.[0]?.message?.content?.trim() ?? "";
  text = text.replace(/^```(?:\w+)?\s*/i, "").replace(/\s*```\s*$/m, "").trim();
  return text || "(VL returned empty)";
}

export function formatFramesForPromptTemporal(chunk: {
  timestamp: string;
  app: string;
  window: string;
  temporal_description?: string;
  ocr_texts: string[];
}): string {
  const temporal = (chunk.temporal_description ?? "").trim();
  const lines: string[] = [
    `Frame ${chunk.timestamp} | ${chunk.app} | ${chunk.window}`,
  ];
  if (temporal) {
    lines.push("");
    lines.push("## Temporal description (whole segment)");
    lines.push(temporal);
    lines.push("");
    lines.push("## Formatted OCR (representative key frames only)");
  }
  const labeled: string[] = [];
  for (let i = 0; i < chunk.ocr_texts.length; i++) {
    let ocrText = chunk.ocr_texts[i] ?? "";
    if (ocrText.length > 600) {
      ocrText = ocrText.slice(0, 600) + " [...]";
    }
    labeled.push(`[frame ${i + 1}]: ${ocrText}`);
  }
  lines.push(labeled.join("\n"));
  return lines.join("\n");
}

function getWikiTextModel(): string {
  return process.env.FIREWORKS_WIKI_MODEL?.trim() || DEFAULT_WIKI_TEXT_MODEL;
}

let mergedPromptCache: string | null = null;

/**
 * Same text as Python `MERGED_WIKI_SYSTEM_PROMPT` in `experiments/daywiki_cleaned_ocr_temporal.py`
 * (`merge_cleaned_system_with_temporal(CLEANED_OCR_WIKI_SYSTEM_PROMPT)`).
 * Regenerate `prompts/mergedWikiSystemPrompt.txt` from that source when the experiment prompt changes.
 */
export function getMergedWikiSystemPrompt(): string {
  if (!mergedPromptCache) {
    const p = path.join(__dirname, "prompts", "mergedWikiSystemPrompt.txt");
    mergedPromptCache = fsSync.readFileSync(p, "utf8");
  }
  return mergedPromptCache;
}

export type WikiOperation = Record<string, unknown>;

function stripJsonFences(content: string): string {
  let s = content.trim();
  if (s.startsWith("```json")) {
    s = s.slice(7);
  } else if (s.startsWith("```")) {
    s = s.slice(3);
  }
  if (s.endsWith("```")) {
    s = s.slice(0, -3);
  }
  return s.trim();
}

function extractJsonValue(stripped: string, start: number): string | null {
  const head = stripped[start];
  if (head === "{") {
    let depth = 0;
    for (let i = start; i < stripped.length; i++) {
      const c = stripped[i];
      if (c === "{") {
        depth++;
      } else if (c === "}") {
        depth--;
        if (depth === 0) {
          return stripped.slice(start, i + 1);
        }
      }
    }
    return null;
  }
  if (head === "[") {
    let depth = 0;
    for (let i = start; i < stripped.length; i++) {
      const c = stripped[i];
      if (c === "[") {
        depth++;
      } else if (c === "]") {
        depth--;
        if (depth === 0) {
          return stripped.slice(start, i + 1);
        }
      }
    }
    return null;
  }
  return null;
}

export function parseWikiResponse(content: string): { operations: WikiOperation[]; extras: Record<string, unknown> | null } {
  const stripped = stripJsonFences(content);
  if (!stripped) {
    return { operations: [], extras: null };
  }

  const start = stripped.search(/[{[]/);
  if (start === -1) {
    return { operations: [], extras: null };
  }

  const jsonSlice = extractJsonValue(stripped, start);
  if (!jsonSlice) {
    return { operations: [], extras: null };
  }

  let obj: unknown;
  try {
    obj = JSON.parse(jsonSlice);
  } catch {
    return { operations: [], extras: null };
  }

  if (Array.isArray(obj)) {
    return { operations: obj as WikiOperation[], extras: null };
  }
  if (obj && typeof obj === "object" && Array.isArray((obj as { operations?: unknown }).operations)) {
    const o = obj as {
      operations: WikiOperation[];
      frame_decisions?: unknown;
      batch_reasoning?: unknown;
    };
    const extras: Record<string, unknown> = {};
    if (o.frame_decisions !== undefined) {
      extras.frame_decisions = o.frame_decisions;
    }
    if (o.batch_reasoning !== undefined) {
      extras.batch_reasoning = o.batch_reasoning;
    }
    return { operations: o.operations, extras: Object.keys(extras).length ? extras : null };
  }

  return { operations: [], extras: null };
}

export async function callWikiTextModel(
  wikiState: string,
  framesText: string,
  settings?: AISettings
): Promise<string> {
  if (settings?.provider === "local") {
    throw new Error("Wiki text model requires Fireworks (set provider to fireworks or configure API key).");
  }
  const system = getMergedWikiSystemPrompt();
  const userMessage = `## Current wiki state\n\n${wikiState}\n\n## New frames\n\n${framesText}${WIKI_JSON_USER_SUFFIX}`;

  const payload = {
    model: getWikiTextModel(),
    messages: [
      { role: "system", content: system },
      { role: "user", content: userMessage },
    ],
    max_tokens: 4096,
    temperature: 0.2,
  };

  const response = await fetch(`${getFireworksBaseUrl().replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${getApiKey(settings)}`,
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Wiki LLM HTTP ${response.status}: ${body.slice(0, 2000)}`);
  }

  const json = (await response.json()) as {
    choices?: Array<{ message?: { content?: string | null; reasoning_content?: string | null } }>;
  };
  const msg = json.choices?.[0]?.message;
  return (msg?.content ?? msg?.reasoning_content ?? "").trim();
}
