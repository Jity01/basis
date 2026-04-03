import { app } from "electron";
import * as fs from "fs";
import * as path from "path";
import { spawn, type ChildProcess } from "child_process";

let mcpChild: ChildProcess | null = null;

/** True when Vite dev server is used (MCP is started by concurrently). */
export function isRendererDevServer(): boolean {
  return process.env.VITE_DEV_SERVER_URL != null;
}

function resolveMcpServerRoot(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "mcp-server");
  }
  // dist-main -> apps/desktop -> sibling apps/mcp_server
  return path.join(__dirname, "..", "..", "mcp_server");
}

/**
 * Starts the MCP HTTP server when not in Vite dev mode.
 * In dev, `pnpm dev` runs the server via concurrently.
 */
export function startBundledMcpServer(): void {
  if (isRendererDevServer()) {
    return;
  }
  if (mcpChild) {
    return;
  }

  const serverRoot = resolveMcpServerRoot();
  const serverJs = path.join(serverRoot, "dist", "server.js");

  if (!fs.existsSync(serverJs)) {
    console.error(
      "[Electron] MCP server bundle missing at %s. Run pnpm build (includes bundle-mcp) before packaging.",
      serverJs,
    );
    return;
  }

  const env = { ...process.env, ELECTRON_RUN_AS_NODE: "1" };

  mcpChild = spawn(process.execPath, [serverJs], {
    cwd: serverRoot,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  mcpChild.stdout?.on("data", (d) => process.stdout.write(`[mcp] ${d}`));
  mcpChild.stderr?.on("data", (d) => process.stderr.write(`[mcp] ${d}`));

  mcpChild.on("error", (err) => {
    console.error("[Electron] Failed to spawn MCP server:", err.message);
    mcpChild = null;
  });

  mcpChild.on("exit", (code, signal) => {
    if (signal) {
      console.warn("[Electron] MCP server exited with signal", signal);
    } else if (code !== 0 && code !== null) {
      console.warn("[Electron] MCP server exited with code", code);
    }
    mcpChild = null;
  });

  console.log("[Electron] MCP server started from", serverRoot);
}

export function stopBundledMcpServer(): void {
  if (!mcpChild) {
    return;
  }
  try {
    mcpChild.kill("SIGTERM");
  } catch {
    // ignore
  }
  mcpChild = null;
}
