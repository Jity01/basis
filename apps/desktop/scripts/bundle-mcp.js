#!/usr/bin/env node
/**
 * Builds @context-manager/mcp-server and deploys a production copy into
 * resources/mcp-server for electron-builder extraResources.
 *
 * Note: The repo uses `node-linker=hoisted` (.npmrc). `pnpm deploy` with hoisted
 * can leave an empty node_modules; run deploy with `node-linker=isolated` so
 * express and other deps are materialized under the target.
 */
const fs = require("fs");
const path = require("path");
const { createRequire } = require("module");
const { spawnSync } = require("child_process");

const repoRoot = path.join(__dirname, "..", "..", "..");
const target = path.join(__dirname, "..", "resources", "mcp-server");

function run(args, extraEnv) {
  const env = {
    ...process.env,
    ...extraEnv,
  };
  const r = spawnSync("pnpm", args, { stdio: "inherit", cwd: repoRoot, shell: false, env });
  if (r.status !== 0) {
    process.exit(r.status ?? 1);
  }
}

function assertDeployHasExpress() {
  const pkgJson = path.join(target, "package.json");
  if (!fs.existsSync(pkgJson)) {
    console.error("[bundle-mcp] Missing package.json in deploy target:", target);
    process.exit(1);
  }
  const req = createRequire(pkgJson);
  try {
    req.resolve("express");
  } catch (e) {
    console.error(
      "[bundle-mcp] Deploy output is missing resolvable dependencies (e.g. express).",
      "Check pnpm deploy / node-linker.",
      e.message || e,
    );
    process.exit(1);
  }
  try {
    req.resolve("@context-manager/config");
    req.resolve("@context-manager/core");
  } catch (e) {
    console.error("[bundle-mcp] Workspace packages not resolvable in deploy target:", e.message || e);
    process.exit(1);
  }
}

fs.mkdirSync(path.dirname(target), { recursive: true });
fs.rmSync(target, { recursive: true, force: true });

run(["--filter", "@context-manager/mcp-server", "build"]);

// Override hoisted linker for this deploy only (see repo .npmrc).
run(
  ["--filter", "@context-manager/mcp-server", "deploy", "--prod", target],
  { npm_config_node_linker: "isolated" },
);

assertDeployHasExpress();
