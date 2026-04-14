/**
 * Pipeline evaluation script.
 *
 * Takes N 1-minute video clips, runs them through the pipeline into a temp
 * context root, and prints the results for human review.
 *
 * Usage:
 *   pnpm --filter @context-manager/core pipeline-eval               # 5 clips
 *   pnpm --filter @context-manager/core pipeline-eval -- --clips 3   # 3 clips
 *   pnpm --filter @context-manager/core pipeline-eval -- --dir /path/to/clips
 *   pnpm --filter @context-manager/core pipeline-eval -- --context-root /tmp/my-eval
 *
 * Environment:
 *   FIREWORKS_API_KEY — required (or set in repo .env / ~/.basis/ai-settings.json)
 */

import fs from "fs";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CLIPS_DIR = path.join(os.homedir(), "Startup", "one-min-clips");
const DEFAULT_NUM_CLIPS = 5;

// ── CLI args ────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { clips: DEFAULT_NUM_CLIPS, dir: DEFAULT_CLIPS_DIR, contextRoot: null };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--clips" && argv[i + 1]) args.clips = parseInt(argv[++i], 10);
    else if (arg === "--dir" && argv[i + 1]) args.dir = argv[++i];
    else if (arg === "--context-root" && argv[i + 1]) args.contextRoot = argv[++i];
  }
  return args;
}

const args = parseArgs(process.argv);

// ── Load .env ───────────────────────────────────────────────────────────────

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
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = value;
  }
}

// Also try ~/.basis/ai-settings.json
if (!process.env.FIREWORKS_API_KEY) {
  const aiSettingsPath = path.join(os.homedir(), ".basis", "ai-settings.json");
  try {
    if (fs.existsSync(aiSettingsPath)) {
      const settings = JSON.parse(fs.readFileSync(aiSettingsPath, "utf8"));
      if (settings.fireworksApiKey) process.env.FIREWORKS_API_KEY = settings.fireworksApiKey;
    }
  } catch { /* ignore */ }
}

if (!process.env.FIREWORKS_API_KEY) {
  console.error("Missing FIREWORKS_API_KEY. Set it in .env, environment, or ~/.basis/ai-settings.json.");
  process.exit(1);
}

// ── Setup temp context root ─────────────────────────────────────────────────

const contextRoot = args.contextRoot || path.join(os.tmpdir(), `basis-eval-${Date.now()}`);
const tmpDir = path.join(contextRoot, ".tmp");
const wikiDir = path.join(contextRoot, ".wiki");

fs.mkdirSync(tmpDir, { recursive: true });
fs.mkdirSync(wikiDir, { recursive: true });

// Override CONTEXT_ROOT for the pipeline
process.env.CONTEXT_ROOT = contextRoot;

console.log(`\n${"=".repeat(72)}`);
console.log(`Pipeline Evaluation`);
console.log(`${"=".repeat(72)}`);
console.log(`Context root:  ${contextRoot}`);
console.log(`Clips dir:     ${args.dir}`);
console.log(`Clips to use:  ${args.clips}`);
console.log();

// ── Find and copy clips ─────────────────────────────────────────────────────

if (!fs.existsSync(args.dir)) {
  console.error(`Clips directory not found: ${args.dir}`);
  process.exit(1);
}

const allClips = fs.readdirSync(args.dir)
  .filter(f => f.endsWith(".mp4") || f.endsWith(".webm"))
  .sort();

if (allClips.length === 0) {
  console.error(`No video files found in ${args.dir}`);
  process.exit(1);
}

// Pick N evenly spaced clips for variety
const selectedClips = [];
const step = Math.max(1, Math.floor(allClips.length / args.clips));
for (let i = 0; i < allClips.length && selectedClips.length < args.clips; i += step) {
  selectedClips.push(allClips[i]);
}

console.log(`Selected ${selectedClips.length} clips from ${allClips.length} available:`);

// Copy clips to .tmp/ with proper naming (YYYY-MM-DD_HH-MM.webm)
// Assign sequential timestamps starting from a base time
const baseDate = new Date("2026-04-14T10:00:00");
const copiedFiles = [];

for (let i = 0; i < selectedClips.length; i++) {
  const clip = selectedClips[i];
  const src = path.join(args.dir, clip);
  const chunkDate = new Date(baseDate.getTime() + i * 60_000); // 1 minute apart
  const yyyy = String(chunkDate.getFullYear());
  const mm = String(chunkDate.getMonth() + 1).padStart(2, "0");
  const dd = String(chunkDate.getDate()).padStart(2, "0");
  const hh = String(chunkDate.getHours()).padStart(2, "0");
  const min = String(chunkDate.getMinutes()).padStart(2, "0");
  const destName = `${yyyy}-${mm}-${dd}_${hh}-${min}.webm`;
  const dest = path.join(tmpDir, destName);

  fs.copyFileSync(src, dest);
  // Write sidecar metadata with 60s duration
  const metaPath = `${dest}.meta.json`;
  fs.writeFileSync(metaPath, JSON.stringify({ chunkDurationMs: 60_000 }), "utf8");

  copiedFiles.push({ src: clip, dest: destName, chunkDate });
  console.log(`  [${i + 1}] ${clip} → ${destName}`);
}

console.log();

// ── Run pipeline ────────────────────────────────────────────────────────────

console.log("Running pipeline...\n");
const t0 = Date.now();

// Import after setting CONTEXT_ROOT
const { processBacklog } = await import("../dist/index.js");

await processBacklog(
  () => null, // no current file
  () => true, // don't pause
  {
    onProgress: (p) => {
      if (p.phase === "start") console.log(`  Processing ${p.total} chunks...`);
      else if (p.phase === "chunk-complete") console.log(`  [${p.completed}/${p.total}] done`);
      else if (p.phase === "done") console.log(`  All ${p.total} chunks processed.`);
    },
  }
);

const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`\nPipeline completed in ${elapsed}s\n`);

// ── Verify output ───────────────────────────────────────────────────────────

console.log(`${"=".repeat(72)}`);
console.log("Output Verification");
console.log(`${"=".repeat(72)}\n`);

let allPassed = true;

for (const { chunkDate, dest } of copiedFiles) {
  const yyyy = String(chunkDate.getFullYear());
  const mm = String(chunkDate.getMonth() + 1).padStart(2, "0");
  const dd = String(chunkDate.getDate()).padStart(2, "0");
  const hh = String(chunkDate.getHours()).padStart(2, "0");
  const min = String(chunkDate.getMinutes()).padStart(2, "0");
  const chunkDir = path.join(contextRoot, yyyy, mm, dd, `${hh}-${min}`);

  const checks = {
    temporal_description: fs.existsSync(path.join(chunkDir, "temporal_description.txt")),
    temporal_index: fs.existsSync(path.join(chunkDir, "temporal_index.json")),
    meta_json: fs.existsSync(path.join(chunkDir, "meta.json")),
    ocr_dir: fs.existsSync(path.join(chunkDir, "ocr")),
  };

  const ocrFiles = checks.ocr_dir
    ? fs.readdirSync(path.join(chunkDir, "ocr")).filter(f => f.endsWith(".txt"))
    : [];

  const status = Object.values(checks).every(Boolean) ? "PASS" : "FAIL";
  if (status === "FAIL") allPassed = false;

  console.log(`[${status}] ${yyyy}-${mm}-${dd}/${hh}-${min} (from ${dest})`);
  console.log(`  temporal_description: ${checks.temporal_description ? "YES" : "MISSING"}`);
  console.log(`  temporal_index.json:  ${checks.temporal_index ? "YES" : "MISSING"}`);
  console.log(`  meta.json:            ${checks.meta_json ? "YES" : "MISSING"}`);
  console.log(`  OCR files:            ${ocrFiles.length}`);
}

// Check wiki
const wikiFiles = fs.existsSync(wikiDir)
  ? fs.readdirSync(wikiDir).filter(f => f.endsWith(".md"))
  : [];
console.log(`\nWiki pages: ${wikiFiles.length}`);
for (const f of wikiFiles) {
  const size = fs.statSync(path.join(wikiDir, f)).size;
  console.log(`  ${f} (${(size / 1024).toFixed(1)}KB)`);
}

// Check that index pipeline artifacts are NOT created
const indexDb = path.join(contextRoot, "index.db");
const contextJson = path.join(contextRoot, "context.json");
if (fs.existsSync(indexDb)) {
  console.log("\nWARNING: index.db exists (should have been removed from pipeline)");
  allPassed = false;
}
if (fs.existsSync(contextJson)) {
  console.log("\nWARNING: context.json exists (should have been removed from pipeline)");
  allPassed = false;
}

// ── Print content for review ────────────────────────────────────────────────

console.log(`\n${"=".repeat(72)}`);
console.log("Content Review (temporal descriptions)");
console.log(`${"=".repeat(72)}\n`);

for (const { chunkDate } of copiedFiles) {
  const yyyy = String(chunkDate.getFullYear());
  const mm = String(chunkDate.getMonth() + 1).padStart(2, "0");
  const dd = String(chunkDate.getDate()).padStart(2, "0");
  const hh = String(chunkDate.getHours()).padStart(2, "0");
  const min = String(chunkDate.getMinutes()).padStart(2, "0");
  const tdPath = path.join(contextRoot, yyyy, mm, dd, `${hh}-${min}`, "temporal_description.txt");

  if (fs.existsSync(tdPath)) {
    const content = fs.readFileSync(tdPath, "utf8").trim();
    console.log(`--- ${yyyy}-${mm}-${dd}/${hh}-${min} ---`);
    console.log(content);
    console.log();
  }
}

if (wikiFiles.length > 0) {
  console.log(`${"=".repeat(72)}`);
  console.log("Content Review (wiki pages)");
  console.log(`${"=".repeat(72)}\n`);

  for (const f of wikiFiles.slice(0, 5)) { // Cap at 5 pages
    const content = fs.readFileSync(path.join(wikiDir, f), "utf8");
    console.log(`--- .wiki/${f} ---`);
    console.log(content.length > 2000 ? content.slice(0, 2000) + "\n[TRUNCATED]" : content);
    console.log();
  }
}

// ── Summary ─────────────────────────────────────────────────────────────────

console.log(`${"=".repeat(72)}`);
console.log(`Result: ${allPassed ? "ALL CHECKS PASSED" : "SOME CHECKS FAILED"}`);
console.log(`Context root: ${contextRoot}`);
console.log(`Use this for search eval: pnpm --filter @context-manager/mcp-server search-eval -- --context-root ${contextRoot}`);
console.log(`${"=".repeat(72)}\n`);
