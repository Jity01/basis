#!/usr/bin/env node
/**
 * Spawns Electron with a clean env (no ELECTRON_RUN_AS_NODE) so require('electron')
 * resolves to the API object instead of the npm package path.
 */
const { spawn } = require("child_process");
const path = require("path");

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
env.VITE_DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL || "http://127.0.0.1:5173";

const electronBinary = require("electron");
const child = spawn(electronBinary, ["."], {
  env,
  stdio: "inherit",
  cwd: path.join(__dirname, ".."),
});

child.on("close", (code) => process.exit(code || 0));
