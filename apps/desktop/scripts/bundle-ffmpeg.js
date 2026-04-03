#!/usr/bin/env node
/**
 * Copies ffmpeg/ffprobe from ffmpeg-static / ffprobe-static into resources/ffmpeg-bin/
 * for electron-builder extraResources.
 */
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const outDir = path.join(root, "resources", "ffmpeg-bin");
fs.mkdirSync(outDir, { recursive: true });

const ffmpegStatic = require("ffmpeg-static");
const ffprobeMod = require("ffprobe-static");
const ffprobePath = ffprobeMod.path;

const isWin = process.platform === "win32";
const ffmpegName = isWin ? "ffmpeg.exe" : "ffmpeg";
const ffprobeName = isWin ? "ffprobe.exe" : "ffprobe";

if (!ffmpegStatic || typeof ffmpegStatic !== "string") {
  console.error("[bundle-ffmpeg] ffmpeg-static did not resolve to a path.");
  process.exit(1);
}
if (!ffprobePath || typeof ffprobePath !== "string") {
  console.error("[bundle-ffmpeg] ffprobe-static did not resolve to a path.");
  process.exit(1);
}

const destFfmpeg = path.join(outDir, ffmpegName);
const destFfprobe = path.join(outDir, ffprobeName);
fs.copyFileSync(ffmpegStatic, destFfmpeg);
fs.copyFileSync(ffprobePath, destFfprobe);
if (!isWin) {
  fs.chmodSync(destFfmpeg, 0o755);
  fs.chmodSync(destFfprobe, 0o755);
}
console.log("[bundle-ffmpeg] Staged", destFfmpeg, destFfprobe);
