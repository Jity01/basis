#!/usr/bin/env node
/**
 * Compiles native/ocr-helper.swift (Apple Vision OCR) into resources/ocr-bin/ocr-helper.
 * No-op on non-macOS hosts.
 */
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

if (process.platform !== "darwin") {
  console.log("[build-ocr-helper] Skipping (macOS only).");
  process.exit(0);
}

const root = path.join(__dirname, "..");
const outDir = path.join(root, "resources", "ocr-bin");
const src = path.join(root, "native", "ocr-helper.swift");
const out = path.join(outDir, "ocr-helper");

if (!fs.existsSync(src)) {
  console.error("[build-ocr-helper] Missing source:", src);
  process.exit(1);
}

fs.mkdirSync(outDir, { recursive: true });

const r = spawnSync("swiftc", ["-O", "-o", out, src], { stdio: "inherit" });
if (r.status !== 0) {
  process.exit(r.status ?? 1);
}
console.log("[build-ocr-helper] Wrote", out);
