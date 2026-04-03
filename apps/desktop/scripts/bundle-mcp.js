#!/usr/bin/env node
/**
 * Builds @context-manager/mcp-server and deploys a production copy into
 * resources/mcp-server for electron-builder extraResources.
 */
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const repoRoot = path.join(__dirname, "..", "..", "..");
const target = path.join(__dirname, "..", "resources", "mcp-server");

function run(args) {
  const r = spawnSync("pnpm", args, { stdio: "inherit", cwd: repoRoot, shell: false });
  if (r.status !== 0) {
    process.exit(r.status ?? 1);
  }
}

fs.mkdirSync(path.dirname(target), { recursive: true });
fs.rmSync(target, { recursive: true, force: true });

run(["--filter", "@context-manager/mcp-server", "build"]);
run(["--filter", "@context-manager/mcp-server", "deploy", "--prod", target]);
