/**
 * Smoke-test: extractFrames(15) + tagChunk via Fireworks vision.
 * Set FIREWORKS_API_KEY in repo-root .env.
 *
 * Usage (from repo root):
 *   pnpm --filter @context-manager/core build
 *   pnpm --filter @context-manager/core tag-test -- /path/to/recording.webm
 */

import { extractFrames, tagChunk } from "../dist/index.js";

// const video = process.argv[2];
// if (!video) {
//   console.error("Usage: node scripts/run-tag-chunk.mjs <path-to-video>");
//   process.exit(1);
// }

// console.log("Video:", video);
console.log("Getting 15 frames…");
const paths = ["/Users/jity/.context/.tmp/extracted-frames/frame_000.jpg", "/Users/jity/.context/.tmp/extracted-frames/frame_001.jpg", "/Users/jity/.context/.tmp/extracted-frames/frame_002.jpg", "/Users/jity/.context/.tmp/extracted-frames/frame_003.jpg", "/Users/jity/.context/.tmp/extracted-frames/frame_004.jpg", "/Users/jity/.context/.tmp/extracted-frames/frame_005.jpg", "/Users/jity/.context/.tmp/extracted-frames/frame_006.jpg", "/Users/jity/.context/.tmp/extracted-frames/frame_007.jpg", "/Users/jity/.context/.tmp/extracted-frames/frame_008.jpg", "/Users/jity/.context/.tmp/extracted-frames/frame_009.jpg", "/Users/jity/.context/.tmp/extracted-frames/frame_010.jpg", "/Users/jity/.context/.tmp/extracted-frames/frame_011.jpg", "/Users/jity/.context/.tmp/extracted-frames/frame_012.jpg", "/Users/jity/.context/.tmp/extracted-frames/frame_013.jpg", "/Users/jity/.context/.tmp/extracted-frames/frame_014.jpg"];

console.log("Calling tagChunk (Fireworks vision)…");
const summary = await tagChunk(paths, "00:00:00", "00:05:00");

console.log("\n--- SUMMARY ---\n");
console.log(summary);
