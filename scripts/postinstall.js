#!/usr/bin/env node
/**
 * electron-builder's @develar/schema-utils expects Ajv 6 (ajv._formats). pnpm hoists Ajv 8 to the
 * repo root for @modelcontextprotocol/sdk, so we symlink Ajv 6 next to schema-utils after install.
 */
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const repoRoot = path.join(__dirname, "..");
const vendorDir = path.join(repoRoot, "apps/desktop/vendor/ajv-for-electron-builder");
const schemaUtilsNm = path.join(repoRoot, "node_modules/@develar/schema-utils/node_modules");
const ajvLink = path.join(schemaUtilsNm, "ajv");
const ajvTarget = path.join(vendorDir, "node_modules/ajv");

if (!fs.existsSync(path.join(repoRoot, "node_modules/@develar/schema-utils"))) {
  process.exit(0);
}

if (!fs.existsSync(ajvTarget) && fs.existsSync(path.join(vendorDir, "package-lock.json"))) {
  const r = spawnSync("npm", ["ci", "--omit=dev"], { cwd: vendorDir, stdio: "inherit", shell: true });
  if (r.status !== 0) {
    console.warn("[postinstall] npm ci in vendor/ajv-for-electron-builder failed; skipping Ajv symlink.");
    process.exit(0);
  }
}

if (!fs.existsSync(ajvTarget)) {
  console.warn("[postinstall] Skipping Ajv symlink: vendor Ajv not installed.");
  process.exit(0);
}

fs.mkdirSync(schemaUtilsNm, { recursive: true });
try {
  fs.unlinkSync(ajvLink);
} catch {
  // ignore
}
const isWindows = process.platform === "win32";
const linkTarget = isWindows ? path.resolve(ajvTarget) : path.relative(schemaUtilsNm, ajvTarget);
fs.symlinkSync(linkTarget, ajvLink, isWindows ? "junction" : "dir");
