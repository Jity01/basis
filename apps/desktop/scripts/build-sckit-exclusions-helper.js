#!/usr/bin/env node
/**
 * Compiles native/sckit-exclusions-init.swift into resources/sckit-bin/sckit-exclusions-init.
 * No-op on non-macOS hosts.
 */
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

if (process.platform !== "darwin") {
  console.log("[build-sckit-exclusions-helper] Skipping (macOS only).");
  process.exit(0);
}

const root = path.join(__dirname, "..");
const outDir = path.join(root, "resources", "sckit-bin");
const src = path.join(root, "native", "sckit-exclusions-init.swift");
const out = path.join(outDir, "sckit-exclusions-init");

if (!fs.existsSync(src)) {
  console.error("[build-sckit-exclusions-helper] Missing source:", src);
  process.exit(1);
}

fs.mkdirSync(outDir, { recursive: true });

const r = spawnSync("swiftc", ["-O", "-o", out, src], { stdio: "inherit" });
if (r.status !== 0) {
  process.exit(r.status ?? 1);
}
console.log("[build-sckit-exclusions-helper] Wrote", out);
