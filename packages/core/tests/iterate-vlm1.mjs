/**
 * VLM Pass 1 prompt iteration script.
 *
 * Sends pre-extracted frames (or extracts from video) to the VLM with a
 * prompt loaded from a text file and prints the result. Edit the prompt
 * file and re-run to iterate quickly.
 *
 * Usage:
 *   pnpm --filter @context-manager/core iterate-vlm1 -- /path/to/frames-dir/
 *   pnpm --filter @context-manager/core iterate-vlm1 -- /path/to/video.webm
 *   pnpm --filter @context-manager/core iterate-vlm1 -- /path/to/frames-dir/ --prompt ./tests/prompts/my-variant.txt
 *
 * Environment:
 *   FIREWORKS_API_KEY   — required (or set in repo .env)
 *   FIREWORKS_MODEL     — optional override
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── CLI args ────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { video: null, prompt: null, frames: 15 };
  const positional = [];

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--prompt" && argv[i + 1]) {
      args.prompt = argv[++i];
    } else if (arg === "--frames" && argv[i + 1]) {
      args.frames = parseInt(argv[++i], 10);
    } else if (!arg.startsWith("--")) {
      positional.push(arg);
    }
  }

  args.video = positional[0] || null;
  return args;
}

const args = parseArgs(process.argv);

if (!args.video) {
  console.error("Usage: iterate-vlm1 <path> [--prompt <prompt-file>] [--frames <N>]");
  console.error("  <path> can be a directory of frame images or a video file");
  process.exit(1);
}

if (!fs.existsSync(args.video)) {
  console.error(`Path not found: ${args.video}`);
  process.exit(1);
}

const inputIsDir = fs.statSync(args.video).isDirectory();

// ── Load prompt template ────────────────────────────────────────────────────

const defaultPromptPath = path.join(__dirname, "prompts", "vlm1-activity.txt");
const promptPath = args.prompt ? path.resolve(args.prompt) : defaultPromptPath;

if (!fs.existsSync(promptPath)) {
  console.error(`Prompt file not found: ${promptPath}`);
  process.exit(1);
}

const rawPromptTemplate = fs.readFileSync(promptPath, "utf8");

// ── Load .env from repo root ────────────────────────────────────────────────

const dotenvPath = path.join(__dirname, "../../../.env");
if (fs.existsSync(dotenvPath)) {
  const envContent = fs.readFileSync(dotenvPath, "utf8");
  for (const line of envContent.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1).trim();
    // Strip surrounding quotes
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}

// ── Load API key from env, .env, or ~/.basis/ai-settings.json ───────────────

let apiKey = process.env.FIREWORKS_API_KEY?.trim() || "";
if (!apiKey) {
  // Try ~/.basis/ai-settings.json (where the desktop app stores it)
  const aiSettingsPath = path.join(process.env.HOME || "", ".basis", "ai-settings.json");
  try {
    if (fs.existsSync(aiSettingsPath)) {
      const settings = JSON.parse(fs.readFileSync(aiSettingsPath, "utf8"));
      apiKey = settings.fireworksApiKey?.trim() || "";
    }
  } catch { /* ignore */ }
}
if (!apiKey) {
  console.error("Missing FIREWORKS_API_KEY. Set it in .env, environment, or ~/.basis/ai-settings.json.");
  process.exit(1);
}

const model = process.env.FIREWORKS_MODEL?.trim() || "accounts/fireworks/models/qwen3-vl-30b-a3b-instruct";
const baseUrl = (process.env.FIREWORKS_BASE_URL?.trim() || "https://api.fireworks.ai/inference/v1").replace(/\/$/, "");

// ── Load or extract frames ──────────────────────────────────────────────────

console.log(`\nInput:  ${args.video}${inputIsDir ? " (directory)" : " (video)"}`);
console.log(`Prompt: ${promptPath}`);
console.log(`Model:  ${model}`);
console.log("");

const t0 = Date.now();
let framePaths;
let extractMs;

if (inputIsDir) {
  // Load frames from directory — sort by name to preserve order
  const exts = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp"]);
  framePaths = fs.readdirSync(args.video)
    .filter((f) => exts.has(path.extname(f).toLowerCase()))
    .sort()
    .map((f) => path.resolve(args.video, f));
  extractMs = 0;
  console.log(`Loaded ${framePaths.length} frames from directory`);
} else {
  const { extractFrames } = await import("../dist/index.js");
  console.log("Extracting frames from video...");
  framePaths = await extractFrames(args.video, args.frames);
  extractMs = Date.now() - t0;
  console.log(`  ${framePaths.length} frames extracted in ${(extractMs / 1000).toFixed(1)}s`);
}

// Show frame file sizes for reference
for (let i = 0; i < framePaths.length; i++) {
  const size = fs.statSync(framePaths[i]).size;
  console.log(`  [${String(i).padStart(2)}] ${path.basename(framePaths[i])}  ${(size / 1024).toFixed(0)}KB`);
}

// ── Fill prompt template with actual frame count ────────────────────────────

const actualFrames = framePaths.length;
const promptTemplate = rawPromptTemplate
  .replace(/\{\{NUM_FRAMES\}\}/g, String(actualFrames));

// ── Build VLM request ───────────────────────────────────────────────────────

console.log("\nSending to VLM...");

const content = [];
for (const fp of framePaths) {
  const buf = fs.readFileSync(fp);
  const b64 = buf.toString("base64");
  const ext = path.extname(fp).toLowerCase();
  const mime = ext === ".png" ? "image/png" : "image/jpeg";
  content.push({
    type: "image_url",
    image_url: { url: `data:${mime};base64,${b64}` },
  });
}
content.push({ type: "text", text: promptTemplate });

const t1 = Date.now();
const response = await fetch(`${baseUrl}/chat/completions`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
  },
  body: JSON.stringify({
    model,
    max_tokens: 4096,
    messages: [{ role: "user", content }],
  }),
});

if (!response.ok) {
  const body = await response.text();
  console.error(`\nVLM API error: HTTP ${response.status}`);
  console.error(body);
  process.exit(1);
}

const json = await response.json();
const vlmMs = Date.now() - t1;
const result = json.choices?.[0]?.message?.content?.trim() ?? "";

if (!result) {
  console.error("\nVLM returned empty response.");
  process.exit(1);
}

// ── Print result ────────────────────────────────────────────────────────────

console.log(`\nVLM response (${(vlmMs / 1000).toFixed(1)}s):`);
console.log("─".repeat(72));
console.log(result);
console.log("─".repeat(72));

// ── Parse key frames if present ─────────────────────────────────────────────

const keyFrameMatch = result.match(/KEY_FRAMES:\s*\[([^\]]+)\]/);
if (keyFrameMatch) {
  // VLM outputs 1-indexed frame numbers — convert to 0-indexed for array access
  const oneIndexed = keyFrameMatch[1]
    .split(",")
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n) && n >= 1 && n <= framePaths.length);
  console.log(`\nKey frames selected (1-indexed): [${oneIndexed.join(", ")}]`);
  for (const num of oneIndexed) {
    const idx = num - 1;
    const size = fs.statSync(framePaths[idx]).size;
    console.log(`  frame ${String(num).padStart(2)} → ${path.basename(framePaths[idx])}  ${(size / 1024).toFixed(0)}KB`);
  }
} else {
  console.log("\n(No KEY_FRAMES line found in output)");
}

// ── Save output ─────────────────────────────────────────────────────────────

const outputsDir = path.join(__dirname, "outputs");
fs.mkdirSync(outputsDir, { recursive: true });
const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const outputFile = path.join(outputsDir, `${ts}.txt`);

const header = [
  `Input:  ${args.video}`,
  `Prompt: ${promptPath}`,
  `Model:  ${model}`,
  `Frames: ${actualFrames}`,
  `Extract: ${(extractMs / 1000).toFixed(1)}s`,
  `VLM:     ${(vlmMs / 1000).toFixed(1)}s`,
  "",
  "─".repeat(72),
  "",
].join("\n");

fs.writeFileSync(outputFile, header + result + "\n", "utf8");
console.log(`\nSaved to: ${outputFile}`);

// ── Usage stats ─────────────────────────────────────────────────────────────

const usage = json.usage;
if (usage) {
  console.log(`\nTokens: ${usage.prompt_tokens ?? "?"} prompt + ${usage.completion_tokens ?? "?"} completion = ${usage.total_tokens ?? "?"} total`);
}

console.log(`\nTotal time: ${((Date.now() - t0) / 1000).toFixed(1)}s`);
