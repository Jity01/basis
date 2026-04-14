/**
 * Smoke-test: extractFrames(15) + tagChunk via Fireworks vision.
 * Set FIREWORKS_API_KEY in repo-root .env.
 *
 * Usage (from repo root):
 *   pnpm --filter @context-manager/core build
 *   pnpm --filter @context-manager/core tag-test -- /path/to/recording.webm
 */

import { extractFrames, tagChunk } from "../dist/index.js";

const video = process.argv[2];
if (!video) {
  console.error("Usage: node tests/run-tag-chunk.mjs <path-to-video>");
  process.exit(1);
}

console.log("Video:", video);
console.log("Getting 15 frames…");

const { framePaths, cleanup } = await extractFrames(video, 15);

try {
  console.log("Calling tagChunk (Fireworks vision)…");
  const summary = await tagChunk(framePaths, "00:00:00", "00:05:00");

  console.log("\n--- SUMMARY ---\n");
  console.log(summary);
} finally {
  await cleanup();
  console.log("Cleaned up extraction work dir.");
}
